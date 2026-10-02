import Anthropic from '@anthropic-ai/sdk';
import { AppError, randomToken } from '../customer-app/http.mjs';
import { TOPICS } from '../customer-app/marketing.mjs';
import { GROUPS, preview, validateDefinition } from './segments.mjs';
import { overview, topBrands } from './insights.mjs';
import { listAutomations, listCampaigns, localDay, localHour, previewCampaign, validateAutomation, validateCampaign,
  AUTOMATION_HOUR, COOLDOWNS, HOLDOUTS, QUIET, WEEKLY_CAP } from './campaigns.mjs';
import { assistantReady, budgetCents, spentCents, SCHEDULE } from './suggestions.mjs';

// Campaign assistant. On a schedule (weekly plan, daily check) or on request, Claude reviews the
// CRM's totals and campaign results through the tools below and proposes campaigns, automatic
// messages or pauses as suggestions. People approve, edit or dismiss them; the assistant cannot
// send anything. Tools return totals only: no customer names, phone numbers or IDs leave the CRM.
const DAY = 86400000;
export const MODELS = { weekly: 'claude-opus-5-5', daily: 'claude-sonnet-5-5' };
// US dollars per million tokens (input, output). Cache reads are $0.20; cache writes 1.25x input.
const PRICES = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10] };
const LIMITS = {
  weekly: { turns: 24, costCents: 200, suggestions: 3, effort: 'high' },
  daily: { turns: 12, costCents: 50, suggestions: 2, effort: 'medium' }
};
const modelFor = (env, kind) => (kind === 'weekly' ? env.CRM_ASSISTANT_WEEKLY_MODEL : env.CRM_ASSISTANT_DAILY_MODEL) || MODELS[kind];
const weekday = ms => new Intl.DateTimeFormat('en-US', { timeZone: QUIET.zone, weekday: 'short' }).format(ms);
const longDate = ms => new Intl.DateTimeFormat('en-US', { timeZone: QUIET.zone, weekday: 'long', year: 'numeric', month: 'long',
  day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);
const iso = ms => (ms ? new Date(ms).toISOString() : null);

function costMicro(model, usage = {}) {
  const [input, output] = PRICES[model] || PRICES[MODELS.weekly];
  return Math.round((usage.input_tokens || 0) * input + (usage.cache_creation_input_tokens || 0) * input * 1.25
    + (usage.cache_read_input_tokens || 0) * 0.2 + (usage.output_tokens || 0) * output);
}
// --- Tools ---

const RULES = `Segment rules; every rule given must match. Keys (all optional, at least one): lastVisit {minDays?, maxDays?} (days since last visit),
visits {days, min?, max?}, spend {days, min?, max?} (dollars), categories {groups: [${GROUPS.join(', ')}], days},
brands {ids: [brand IDs from list_brands], days}, pointsMin (number), birthday ("this_month" | "next_month"),
app ("linked" | "not_linked" | "push" | "marketing"), newWithinDays (first visit within N days).`;
const campaignProperties = {
  name: { type: 'string', description: 'Internal name, up to 60 characters.' },
  topic: { type: 'string', enum: TOPICS, description: 'Only customers who chose this topic receive it.' },
  body: { type: 'string', description: 'Notification text shown under the title "Treehouse Pharmacy", 10-120 characters.' },
  link: { type: 'string', description: 'What tapping opens: home, menu, rewards, order, menu:category:<section from get_menu>, or menu:brand:<brand from get_menu>.' },
  definition: { type: ['object', 'null'], description: `${RULES} null means everyone opted in to the topic.` },
  audienceLabel: { type: 'string', description: 'Short plain-language description of who it is for.' },
  holdoutPct: { type: 'integer', enum: HOLDOUTS, description: 'Share held back to measure results; 10 is the default.' }
};
const campaignSchema = { type: 'object', properties: { ...campaignProperties,
  sendAt: { type: ['string', 'null'], description: 'ISO 8601 time to send (include the Central offset), or null for as soon as it is approved.' } },
  required: Object.keys(campaignProperties), additionalProperties: false };
const automationSchema = { type: 'object', properties: { ...campaignProperties,
  cooldownDays: { type: 'integer', enum: COOLDOWNS, description: 'Each person gets it at most once every N days; 0 means only once ever.' } },
  required: [...Object.keys(campaignProperties), 'cooldownDays'], additionalProperties: false };
const empty = { type: 'object', properties: {}, additionalProperties: false };
const suggestion = extra => ({ type: 'object', properties: { title: { type: 'string', description: 'One-line headline for the owners.' },
  reasoning: { type: 'string', description: 'Why, with the numbers behind it, in 2-4 plain sentences.' }, ...extra },
  required: ['title', 'reasoning', ...Object.keys(extra)], additionalProperties: false });

export const TOOLS = [
  { name: 'get_shop_overview', description: 'Shop totals: active, lapsed and new customers, visits and sales (30 days vs the 30 before), top categories and brands (90 days), app and Deals & news adoption, and opted-in customers per topic.', input_schema: empty },
  { name: 'count_customers', description: `Size a segment: customers matching the rules, their 90-day spend, average points, and how many use the app or get Deals & news. ${RULES}`,
    input_schema: { type: 'object', properties: { definition: { type: 'object' } }, required: ['definition'], additionalProperties: false } },
  { name: 'list_brands', description: 'Best-selling brands over 90 days with their IDs (for brands rules), sales and number of buyers.', input_schema: empty },
  { name: 'get_menu', description: 'Today\'s app menu: sections and brands with product counts, and items added since the assistant last looked.', input_schema: empty },
  { name: 'list_campaigns', description: 'Recent one-off campaigns: message, audience, status, how many were sent, held back or skipped, and 7-day results for people sent it vs held back.', input_schema: empty },
  { name: 'list_automations', description: 'Automatic messages: rules, cooldown, whether on, totals and 7-day results vs held back.', input_schema: empty },
  { name: 'check_campaign', description: 'Check a draft campaign against the rules and see its reach right now (opted in, skipped for the weekly limit, held back). Use before suggesting.', input_schema: campaignSchema },
  { name: 'suggest_campaign', description: 'Propose a one-off campaign for the owners to approve.', input_schema: suggestion({ campaign: campaignSchema }) },
  { name: 'suggest_automation', description: 'Propose a new automatic message (checked daily at 11 am Central) for the owners to approve.', input_schema: suggestion({ automation: automationSchema }) },
  { name: 'suggest_pause_automation', description: 'Propose pausing an automatic message that is not working or no longer fits.',
    input_schema: suggestion({ automationId: { type: 'string', description: 'The automatic message ID from list_automations.' } }) },
  { name: 'add_note', description: 'Save one durable lesson for future runs (one specific sentence, with numbers when you have them).',
    input_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false } }
];

const PROBLEMS = { CAMPAIGN_NAME: 'Give it a name.', CAMPAIGN_LENGTH: 'The message must be 10 to 120 characters.',
  CAMPAIGN_DISCREET: 'The message uses a word that would show cannabis on a lock screen (product types, THC/CBD, strains, weights). Rephrase it discreetly.',
  CAMPAIGN_CLAIMS: 'The message makes a health claim (pain, anxiety, relief, cures and similar). Remove it.',
  CAMPAIGN_TIME: 'sendAt must be in the next 30 days.', SEGMENT_RULES: 'The segment rules are not valid. Check the rule format.',
  INPUT: 'A field is not valid (topic, link, holdoutPct or cooldownDays).' };
const problem = error => ({ error: error instanceof AppError ? PROBLEMS[error.code] || error.code : 'That could not be checked.' });
function toCampaign(input, now) {
  const sendAt = input.sendAt ? Date.parse(input.sendAt) : null;
  if (input.sendAt && !Number.isFinite(sendAt)) throw new AppError('CAMPAIGN_TIME', 400);
  return { name: input.name, topic: input.topic, body: input.body, link: input.link, definition: input.definition ?? null,
    audienceLabel: input.audienceLabel, holdoutPct: input.holdoutPct, sendAt: sendAt && sendAt > now ? sendAt : null };
}

async function optedInByTopic(env) {
  const { results = [] } = await env.APP_DB.prepare(`SELECT t.value AS topic, COUNT(DISTINCT u.customer_id) AS customers
    FROM app_marketing_prefs m JOIN app_users u ON u.id = m.user_id, json_each(m.topics) t
    WHERE u.customer_id IS NOT NULL AND EXISTS (SELECT 1 FROM app_push_subscriptions s WHERE s.user_id = u.id) GROUP BY t.value`).bind().run();
  return Object.fromEntries(TOPICS.map(t => [t, results.find(r => r.topic === t)?.customers || 0]));
}
async function menuView(env, ctx) {
  const row = await env.APP_DB.prepare("SELECT value FROM app_cache WHERE key = 'menu:summary'").bind().first();
  if (!row) return { error: 'The menu summary is not available yet.' };
  const menu = JSON.parse(row.value), tally = key => Object.entries(menu.products.reduce((m, p) => (p[key] ? { ...m, [p[key]]: (m[p[key]] || 0) + 1 } : m), {}))
    .sort((a, b) => b[1] - a[1]).map(([name, products]) => ({ name, products }));
  const state = await env.CRM_DB.prepare("SELECT value FROM crm_assistant_state WHERE key = 'menu_seen'").bind().first();
  const seen = new Set(state ? JSON.parse(state.value) : []);
  ctx.menuSeen = menu.products.map(p => p.id);
  return { updatedAt: iso(menu.updatedAt), sections: tally('category'), brands: tally('brand').slice(0, 80),
    addedSinceLastLook: state ? menu.products.filter(p => !seen.has(p.id)).slice(0, 40).map(({ name, brand, category }) => ({ name, brand, category }))
      : 'First look: no earlier menu to compare with.' };
}
const trimCampaign = c => ({ name: c.name, topic: c.topic, message: c.body, link: c.link, audience: c.audience_label, holdoutPct: c.holdout_pct,
  status: c.status, sendAt: iso(c.send_at), startedAt: iso(c.started_at), counts: c.counts, results: c.results });

async function store(env, ctx, kind, title, reasoning, payload) {
  if (ctx.suggestions >= LIMITS[ctx.run.kind].suggestions) return { error: 'You have reached the suggestion limit for this run. Finish with your report.' };
  ctx.suggestions++;
  await env.CRM_DB.prepare(`INSERT INTO crm_suggestions(id, run_id, kind, title, reasoning, payload, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`).bind(randomToken(), ctx.run.id, kind, String(title).slice(0, 140), String(reasoning).slice(0, 1200),
    JSON.stringify(payload), ctx.deps.now()).run();
  return { saved: true, note: 'Saved for the owners to approve.' };
}
async function runTool(env, ctx, name, input) {
  const now = ctx.deps.now();
  try {
    switch (name) {
      case 'get_shop_overview': {
        const { totals, categories, brands } = await overview(env, now);
        return { totals, categories90Days: categories, topBrands90Days: brands.map(({ id, ...b }) => b), optedInByTopic: await optedInByTopic(env) };
      }
      case 'count_customers': return await preview(env.CRM_DB, validateDefinition(input.definition), now);
      case 'list_brands': return { brands: await topBrands(env, now) };
      case 'get_menu': return await menuView(env, ctx);
      case 'list_campaigns': return { campaigns: (await listCampaigns(env, now)).map(trimCampaign) };
      case 'list_automations': return { automations: (await listAutomations(env, now)).map(a => ({ id: a.id, name: a.name, topic: a.topic,
        message: a.body, link: a.link, audience: a.audience_label, cooldownDays: a.cooldown_days, on: a.active,
        lastSentAt: iso(a.last_sent_at), results: a.results })) };
      case 'check_campaign': {
        const campaign = validateCampaign(toCampaign(input, now), env, now);
        return { ok: true, ...await previewCampaign(env, campaign, now) };
      }
      case 'suggest_campaign': {
        const campaign = validateCampaign(toCampaign(input.campaign, now), env, now);
        const reach = await previewCampaign(env, campaign, now);
        return await store(env, ctx, 'campaign', input.title, input.reasoning, { ...campaign, reachWhenSuggested: reach.reach });
      }
      case 'suggest_automation': {
        const { sendAt, ...rest } = toCampaign(input.automation, now);
        const automation = validateAutomation({ ...rest, cooldownDays: input.automation.cooldownDays }, env, now);
        return await store(env, ctx, 'automation', input.title, input.reasoning, automation);
      }
      case 'suggest_pause_automation': {
        const row = await env.CRM_DB.prepare('SELECT id, name, active FROM crm_automations WHERE id = ?').bind(String(input.automationId)).first();
        if (!row?.active) return { error: 'No automatic message with that ID is on.' };
        return await store(env, ctx, 'pause', input.title, input.reasoning, { automationId: row.id, name: row.name });
      }
      case 'add_note': {
        const note = String(input.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!note) return { error: 'The note is empty.' };
        await env.CRM_DB.batch([
          env.CRM_DB.prepare('INSERT INTO crm_assistant_notes(at, run_id, text) VALUES (?, ?, ?)').bind(now, ctx.run.id, note),
          env.CRM_DB.prepare('DELETE FROM crm_assistant_notes WHERE id NOT IN (SELECT id FROM crm_assistant_notes ORDER BY id DESC LIMIT 60)').bind()]);
        return { saved: true };
      }
      default: return { error: `Unknown tool ${name}.` };
    }
  } catch (error) { return problem(error); }
}

// --- The run ---

export const SYSTEM = `You are the campaign assistant for Treehouse Pharmacy, a medical marijuana dispensary in Ponca City, Oklahoma. You help the owners and manager send "Deals & news" phone notifications through the store's app that customers are glad to get, so that satisfaction, repeat visits and sales grow.

How it works:
- Customers opt in by topic: new_arrivals (new arrivals and restocks), rewards (rewards and points reminders), events, specials. A message reaches only people who chose its topic and have a phone set up. Segment rules from the CRM can narrow it further.
- Everything you propose is a suggestion. A person approves, edits or dismisses it. You cannot send anything or change settings.
- The system enforces these no matter what: at most ${WEEKLY_CAP} Deals & news messages per person per week; sending only 9 am to 8 pm Central; the title is always "Treehouse Pharmacy"; no words that reveal cannabis on a lock screen; no health claims. check_campaign tells you if a draft breaks a rule. Automatic messages are checked every day at ${AUTOMATION_HOUR} am Central.

What good work looks like:
- Relevance over volume. Each message should matter to the people who get it (their categories, brands, points, timing). A few good messages a month beat many ordinary ones, and overlapping messages get people skipped by the weekly limit.
- Regulars respond to early access and new arrivals; save discounts and specials for people who are slipping away or lapsed.
- Messages are warm, short, specific and discreet, and say what is in it for the customer. For example: "New arrivals from a farm you love just landed. Tap to see what's new." Send the tap where the action is: a filtered menu for brand or section news, My points for rewards.
- Size audiences with count_customers and check_campaign before suggesting. Use list_campaigns and list_automations to see what is already going out.
- Judge results honestly. Each campaign holds back a share of its audience; results compare visits and spend over 7 days for people sent it vs held back. Groups at this store are small, so differences are noisy: only call something a win when both groups have at least about 30 people and the gap is large, and prefer patterns that repeat. Otherwise, say what you are watching.
- Learn from history. Past decisions are feedback from the owners; a dismissal reason tells you what they do not want. Save durable lessons with add_note.

Write your final message as a short report for the owners in plain language, without IDs or jargon: how recent messages did against their held-back groups, anything notable in the numbers, and what you suggested and why. If nothing is worth suggesting, say so; that is a fine outcome.`;

async function brief(env, ctx) {
  const db = env.CRM_DB, now = ctx.deps.now();
  const { results: open = [] } = await db.prepare(`SELECT kind, title, created_at FROM crm_suggestions WHERE status = 'open' ORDER BY created_at DESC LIMIT 20`).bind().run();
  const { results: decided = [] } = await db.prepare(`SELECT kind, title, status, decision_note FROM crm_suggestions
    WHERE status IN ('approved', 'edited', 'dismissed') AND decided_at >= ? ORDER BY decided_at DESC LIMIT 20`).bind(now - 45 * DAY).run();
  const { results: notes = [] } = await db.prepare('SELECT at, text FROM crm_assistant_notes ORDER BY id DESC LIMIT 30').bind().run();
  const weekly = ctx.run.kind === 'weekly';
  return [
    `This is the ${weekly ? 'weekly plan' : 'daily check'}. It is ${longDate(now)} Central.`,
    weekly ? `Review how things are going and propose up to ${LIMITS.weekly.suggestions} suggestions for the coming week. Then write your report (6 to 12 sentences).`
      : `Only suggest something if it is timely, such as new arrivals that a brand's fans would want or a problem with something already going out (up to ${LIMITS.daily.suggestions}). Keep the report to 2 to 4 sentences.`,
    `Suggestions still waiting for a decision (don't repeat these): ${JSON.stringify(open.map(s => s.title))}`,
    `Decisions on your recent suggestions: ${JSON.stringify(decided.map(s => ({ title: s.title, decision: s.status, note: s.decision_note || undefined })))}`,
    `Your notes from earlier runs: ${JSON.stringify(notes.map(n => n.text))}`
  ].join('\n\n');
}

export async function runAssistant(env, deps, run) {
  const db = env.CRM_DB, limits = LIMITS[run.kind];
  const client = deps.anthropic || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const ctx = { run, deps, suggestions: 0, menuSeen: null };
  const messages = [{ role: 'user', content: await brief(env, ctx) }];
  let cost = 0, turns = 0, summary = '', status = 'done', error = null;
  const save = () => db.prepare('UPDATE crm_assistant_runs SET cost_micro = ?, turns = ? WHERE id = ?').bind(cost, turns, run.id).run();
  try {
    while (true) {
      if (turns >= limits.turns || cost / 10000 >= limits.costCents) { status = 'limit'; break; }
      if (await spentCents(env, deps.now()) >= budgetCents(env)) { status = 'budget'; break; }
      const response = await client.beta.messages.create({
        model: run.model, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages,
        output_config: { effort: limits.effort }, cache_control: { type: 'ephemeral' },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'
      });
      turns++; cost += costMicro(response.model || run.model, response.usage); await save();
      if (response.stop_reason === 'refusal') { status = 'failed'; error = 'The model declined this run.'; break; }
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason === 'pause_turn') continue;
      const uses = response.content.filter(b => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !uses.length) {
        summary = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        break;
      }
      const results = [];
      for (const use of uses) {
        const result = await runTool(env, ctx, use.name, use.input || {});
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result), ...(result?.error ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    status = 'failed';
    error = e instanceof Anthropic.APIError ? `Claude API error ${e.status || ''}`.trim() : 'The run stopped unexpectedly.';
    deps.report?.(`ASSISTANT_${e instanceof Anthropic.APIError ? `API_${e.status || 'ERROR'}` : 'RUN'}`);
  }
  if (!summary) summary = status === 'budget' ? 'Stopped: this month\'s assistant budget is used up.'
    : status === 'limit' ? 'Stopped at this run\'s size limit before finishing its report.' : '';
  const statements = [db.prepare(`UPDATE crm_assistant_runs SET status = ?, summary = ?, error = ?, cost_micro = ?, turns = ?, finished_at = ?
    WHERE id = ?`).bind(status, summary.slice(0, 4000), error, cost, turns, deps.now(), run.id)];
  if (ctx.menuSeen && status === 'done') statements.push(db.prepare(`INSERT INTO crm_assistant_state(key, value, updated_at) VALUES ('menu_seen', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(JSON.stringify(ctx.menuSeen), deps.now()));
  await db.batch(statements);
  return { status, suggestions: ctx.suggestions, costMicro: cost, turns };
}

// Called every few minutes by the assistant Worker: queues the scheduled runs, then runs one.
export async function tickAssistant(env, deps) {
  if (!assistantReady(env) || !env.ANTHROPIC_API_KEY) return null;
  const db = env.CRM_DB, now = deps.now(), day = localDay(now), hour = localHour(now), monday = weekday(now) === 'Mon';
  await db.batch([
    db.prepare(`UPDATE crm_assistant_runs SET status = 'failed', error = 'Interrupted', finished_at = ? WHERE status = 'running' AND started_at < ?`)
      .bind(now, now - 20 * 60000),
    db.prepare(`UPDATE crm_suggestions SET status = 'expired' WHERE status = 'open' AND created_at < ?`).bind(now - 14 * DAY)]);
  // Scheduled runs happen once a day, within a few hours of their time (never late at night).
  const kind = monday ? 'weekly' : 'daily', at = SCHEDULE[kind].hour;
  if (hour >= at && hour < at + 3)
    await db.prepare(`INSERT OR IGNORE INTO crm_assistant_runs(id, kind, trigger, status, created_at) VALUES (?, ?, 'schedule', 'requested', ?)`)
      .bind(`${kind}:${day}`, kind, now).run();
  const next = await db.prepare(`SELECT id, kind FROM crm_assistant_runs WHERE status = 'requested' ORDER BY created_at LIMIT 1`).bind().first();
  if (!next) return null;
  const run = await db.prepare(`UPDATE crm_assistant_runs SET status = 'running', started_at = ?, model = ? WHERE id = ? AND status = 'requested'
    RETURNING id, kind, model`).bind(now, modelFor(env, next.kind), next.id).first();
  return run ? runAssistant(env, deps, run) : null;
}
