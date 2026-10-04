import { AppError, hash, randomToken } from '../customer-app/http.mjs';
import { TOPICS } from '../customer-app/marketing.mjs';
import { pushReady, sendPush } from '../customer-app/push.mjs';
import { compile, validateDefinition } from './segments.mjs';

// Deals & news campaigns. The CRM writes a campaign; the notifier Worker (which holds the
// notification key) sends it. What customers were promised is enforced here, not by staff:
// at most WEEKLY_CAP a week each, only between 9 am and 8 pm Central, discreet lock-screen
// wording, and only the topics they chose.
const DAY = 86400000;
export const WEEKLY_CAP = 2;
export const QUIET = { start: 9, end: 20, zone: 'America/Chicago' };
export const LINKS = { home: '/app/', menu: '/app/#menu', rewards: '/app/#rewards', order: '/app/#order' };
// "menu:category:<name>" or "menu:brand:<name>" opens the menu filtered to it. The filter travels
// separately from the URL, so phones with an older app simply open the full menu.
const FILTERED = /^menu:(category|brand):([^\u0000-\u001f\u007f]{1,60})$/;
export function linkTarget(link) {
  if (typeof link !== 'string') return null;
  if (Object.hasOwn(LINKS, link)) return { url: LINKS[link] };
  const match = FILTERED.exec(link);
  return match && match[2].trim() === match[2] ? { url: LINKS.menu, filter: `${match[1]}=${encodeURIComponent(match[2])}` } : null;
}
export const HOLDOUTS = [0, 5, 10, 20];
export const TITLE = 'Treehouse Pharmacy';
// Automatic messages: checked once a day at this hour (Central). 0 days = only ever once.
export const AUTOMATION_HOUR = 11;
export const COOLDOWNS = [7, 14, 30, 60, 90, 180, 365, 0];
// Words that would say "cannabis" on a lock screen, and health claims Oklahoma rules forbid.
const NOT_DISCREET = /\b(cannabis|marijuana|weed|thc|cbd|dispensary|dabs?|vapes?|carts?|cartridges?|joints?|pre-?rolls?|blunts?|stoned|420|edibles?|gummies|indica|sativa|strains?|kush|grams?|ounces?|oz)\b/i;
const HEALTH_CLAIM = /\b(cures?|cured|heals?|healing|relief|relieves?|anxiety|pain|insomnia|depression|medicine)\b/i;
const LEASE = 120000, RETRY = 300000, MAX_ATTEMPTS = 3, BATCH = 25;

export const campaignsReady = env => env.CRM_CAMPAIGNS_ENABLED === 'true' && Boolean(env.CRM_DB && env.APP_DB);

export function localHour(ms) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: QUIET.zone, hour: 'numeric', hourCycle: 'h23' }).format(ms));
}
export const quietAt = ms => { const h = localHour(ms); return h < QUIET.start || h >= QUIET.end; };
export const localDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: QUIET.zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
// Seconds left before quiet hours, so a phone that is offline never receives it late at night.
export function secondsUntilQuiet(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: QUIET.zone, hour: 'numeric', minute: 'numeric',
    hourCycle: 'h23' }).formatToParts(ms).map(p => [p.type, p.value]));
  return Math.max(600, ((QUIET.end - Number(parts.hour)) * 60 - Number(parts.minute)) * 60);
}
const clean = (text, max) => typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

// Lock-screen text must not reveal cannabis or make health claims.
export function checkWording(text, { lockScreen = true } = {}) {
  if (lockScreen && NOT_DISCREET.test(text)) throw new AppError('CAMPAIGN_DISCREET', 400);
  if (HEALTH_CLAIM.test(text)) throw new AppError('CAMPAIGN_CLAIMS', 400);
}
// Checks a campaign the CRM is about to preview, test or send. Returns the stored form.
export function validateCampaign(input, env, now) {
  const fail = code => { throw new AppError(code, 400); };
  const allowed = ['name', 'topic', 'body', 'link', 'definition', 'audienceLabel', 'holdoutPct', 'sendAt'];
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !allowed.includes(k))) fail('INPUT');
  const name = clean(input.name, 60), body = clean(input.body, 200), audienceLabel = clean(input.audienceLabel, 80) || 'Everyone opted in';
  if (!name) fail('CAMPAIGN_NAME');
  if (!TOPICS.includes(input.topic)) fail('INPUT');
  if (body.length < 10 || body.length > 120) fail('CAMPAIGN_LENGTH');
  checkWording(body);
  if (!linkTarget(input.link)) fail('INPUT');
  if (!HOLDOUTS.includes(input.holdoutPct)) fail('INPUT');
  const definition = input.definition === null || input.definition === undefined ? null : validateDefinition(input.definition);
  const sendAt = input.sendAt === null || input.sendAt === undefined ? now : input.sendAt;
  if (!Number.isInteger(sendAt) || sendAt < now - 60000 || sendAt > now + 30 * DAY) fail('CAMPAIGN_TIME');
  return { name, topic: input.topic, body, link: input.link, definition, audienceLabel, holdoutPct: input.holdoutPct, sendAt };
}

export function validateAutomation(input, env, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INPUT', 400);
  const { cooldownDays, ...rest } = input;
  if (!COOLDOWNS.includes(cooldownDays)) throw new AppError('INPUT', 400);
  return { ...validateCampaign({ ...rest, sendAt: null }, env, now), cooldownDays };
}

// Linked customers who chose this topic and have at least one phone set up for notifications.
async function optedIn(env, topic) {
  const { results = [] } = await env.APP_DB.prepare(`SELECT DISTINCT u.customer_id FROM app_marketing_prefs m
    JOIN app_users u ON u.id = m.user_id WHERE u.customer_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM json_each(m.topics) t WHERE t.value = ?)
    AND EXISTS (SELECT 1 FROM app_push_subscriptions s WHERE s.user_id = u.id)`).bind(topic).run();
  return results.map(r => r.customer_id);
}
// The opted-in customers who also match the segment rules (all of them when there are none).
export async function audience(env, definition, topic, now) {
  const ids = await optedIn(env, topic);
  if (!definition || !ids.length) return ids;
  const { where, params } = compile(definition, now);
  const { results = [] } = await env.CRM_DB.prepare(`SELECT c.id FROM crm_customers c
    WHERE c.id IN (SELECT value FROM json_each(?)) AND ${where}`).bind(JSON.stringify(ids), ...params).run();
  return results.map(r => r.id);
}
// Customers who already had WEEKLY_CAP campaigns in the last 7 days (tests don't count).
async function capped(env, ids, now, exceptCampaign = '') {
  if (!ids.length) return new Set();
  const { results = [] } = await env.CRM_DB.prepare(`SELECT r.customer_id, COUNT(*) AS n FROM crm_campaign_recipients r
    JOIN crm_campaigns c ON c.id = r.campaign_id WHERE r.state = 'sent' AND r.sent_at > ? AND c.test_customer_id IS NULL
    AND r.campaign_id <> ? AND r.customer_id IN (SELECT value FROM json_each(?)) GROUP BY r.customer_id HAVING n >= ?`)
    .bind(now - 7 * DAY, exceptCampaign, JSON.stringify(ids), WEEKLY_CAP).run();
  return new Set(results.map(r => r.customer_id));
}
export async function previewCampaign(env, campaign, now) {
  const ids = await audience(env, campaign.definition, campaign.topic, now), limited = await capped(env, ids, now);
  const reachable = ids.length - limited.size;
  return { optedIn: ids.length, weeklyLimit: limited.size, heldBack: Math.round(reachable * campaign.holdoutPct / 100),
    reach: reachable - Math.round(reachable * campaign.holdoutPct / 100), waitsForMorning: quietAt(campaign.sendAt) };
}
// The same customer always lands in or out of a campaign's held-back group.
async function heldBack(campaignId, customerId, pct) {
  if (!pct) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${campaignId}:${customerId}`)));
  return ((digest[0] << 8) | digest[1]) % 100 < pct;
}

export async function createCampaign(env, user, campaign, now, testCustomerId = null) {
  const id = randomToken();
  await env.CRM_DB.prepare(`INSERT INTO crm_campaigns(id, name, topic, body, link, definition, audience_label, holdout_pct,
    test_customer_id, status, send_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`)
    .bind(id, campaign.name, campaign.topic, campaign.body, campaign.link, campaign.definition ? JSON.stringify(campaign.definition) : null,
      campaign.audienceLabel, testCustomerId ? 0 : campaign.holdoutPct, testCustomerId, testCustomerId ? now : campaign.sendAt, user, now).run();
  return id;
}
export async function createAutomation(env, user, a, now) {
  const id = randomToken();
  await env.CRM_DB.prepare(`INSERT INTO crm_automations(id, name, topic, body, link, definition, audience_label, holdout_pct,
    cooldown_days, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .bind(id, a.name, a.topic, a.body, a.link, a.definition ? JSON.stringify(a.definition) : null, a.audienceLabel, a.holdoutPct,
      a.cooldownDays, user, now, now).run();
  return id;
}
export async function setAutomationActive(env, id, active, now) {
  const row = await env.CRM_DB.prepare('UPDATE crm_automations SET active = ?, updated_at = ? WHERE id = ? RETURNING id')
    .bind(active ? 1 : 0, now, id).first();
  if (!row) throw new AppError('INPUT', 400);
}
export async function cancelCampaign(env, id, now) {
  const row = await env.CRM_DB.prepare(`UPDATE crm_campaigns SET status = 'canceled', finished_at = ?
    WHERE id = ? AND status IN ('scheduled', 'sending') RETURNING id`).bind(now, id).first();
  if (!row) throw new AppError('CAMPAIGN_DONE', 409);
}

// What a campaign featured, for "bought what it featured": the brand or menu section it opened
// to, or else the brands or product groups in its audience rules.
async function featured(env, link, definition) {
  const m = /^menu:(category|brand):(.+)$/.exec(link || '');
  if (m) {
    const table = m[1] === 'brand' ? 'crm_brands' : 'crm_categories';
    const { results = [] } = await env.CRM_DB.prepare(`SELECT id FROM ${table} WHERE lower(name) = lower(?)`).bind(m[2]).run();
    return results.length ? { label: m[2], sql: `l.${m[1] === 'brand' ? 'brand_id' : 'category_id'} IN (${results.map(() => '?').join(',')})`,
      params: results.map(r => r.id) } : null;
  }
  const def = typeof definition === 'string' ? JSON.parse(definition || 'null') : definition;
  if (def?.brands) return { label: 'the brands it was about', sql: `l.brand_id IN (${def.brands.ids.map(() => '?').join(',')})`, params: def.brands.ids };
  if (def?.categories) return { label: def.categories.groups.join(' or '), sql: `l.category_group IN (${def.categories.groups.map(() => '?').join(',')})`,
    params: def.categories.groups };
  return null;
}
// For people sent it and people held back, over the 7 days after each send: how many visited,
// spent, ordered ahead in the app and bought what it featured; how many tapped it; and how many
// turned off Deals & news or that topic within 2 days. `where` picks the sends (one campaign, or
// an automatic message's batches).
async function measure(env, where, params, { topic, link, definition }, now) {
  const db = env.CRM_DB, feat = await featured(env, link, definition);
  const end = 'MIN(c.started_at + 604800000, ?)';
  const visit = extra => `SUM(EXISTS (SELECT 1 FROM crm_orders o WHERE o.customer_id = r.customer_id ${extra} AND o.completed_at BETWEEN c.started_at AND ${end}))`;
  const { results: groups = [] } = await db.prepare(`SELECT r.state, COUNT(*) AS people, SUM(r.tapped_at IS NOT NULL) AS tapped,
    ${visit('')} AS visited, ${visit('AND o.is_preorder = 1')} AS app_orders,
    SUM((SELECT COALESCE(SUM(o.total_cents), 0) FROM crm_orders o WHERE o.customer_id = r.customer_id AND o.completed_at BETWEEN c.started_at AND ${end})) AS cents,
    ${feat ? `SUM(EXISTS (SELECT 1 FROM crm_lines l WHERE l.customer_id = r.customer_id AND l.returned = 0
      AND l.sold_at BETWEEN c.started_at AND ${end} AND ${feat.sql}))` : 'NULL'} AS bought,
    MIN(c.started_at) AS first_start
    FROM crm_campaign_recipients r JOIN crm_campaigns c ON c.id = r.campaign_id
    WHERE ${where} AND c.started_at IS NOT NULL AND r.state IN ('sent', 'holdout') GROUP BY r.state`)
    .bind(now, now, now, ...(feat ? [now, ...feat.params] : []), ...params).run();
  if (!groups.length) return null;
  // Opt-outs come from the app's consent log, matched to each person's own send time.
  const { results: people = [] } = await db.prepare(`SELECT r.customer_id, r.state, c.started_at FROM crm_campaign_recipients r
    JOIN crm_campaigns c ON c.id = r.campaign_id WHERE ${where} AND c.started_at IS NOT NULL AND r.state IN ('sent', 'holdout')`).bind(...params).run();
  const optedOut = { sent: 0, holdout: 0 };
  if (env.APP_DB && people.length) {
    const { results: changes = [] } = await env.APP_DB.prepare(`SELECT u.customer_id, l.at, l.topics FROM app_marketing_consent_log l
      JOIN app_users u ON u.id = l.user_id WHERE u.customer_id IN (SELECT value FROM json_each(?)) AND l.at >= ?`)
      .bind(JSON.stringify([...new Set(people.map(p => p.customer_id))]), Math.min(...people.map(p => p.started_at))).run().catch(() => ({ results: [] }));
    for (const p of people) if (changes.some(ch => ch.customer_id === p.customer_id && ch.at >= p.started_at && ch.at <= p.started_at + 2 * DAY
      && !JSON.parse(ch.topics || '[]').includes(topic))) optedOut[p.state]++;
  }
  const first = Math.min(...groups.map(g => g.first_start)), days = Math.min(7, (now - first) / DAY);
  return { days: Math.round(days * 10) / 10, featured: feat?.label || null, ...Object.fromEntries(groups.map(g => [g.state, { people: g.people,
    tapped: g.state === 'sent' ? g.tapped || 0 : undefined, visited: g.visited || 0, cents: g.cents || 0, appOrders: g.app_orders || 0,
    bought: feat ? g.bought || 0 : undefined, optedOut: optedOut[g.state] }])) };
}

// Campaigns for the CRM page, with who got them and, after sending, how both groups behaved in
// the 7 days that followed. Held-back customers are the baseline for "did it make a difference".
export async function listCampaigns(env, now) {
  const db = env.CRM_DB;
  const { results = [] } = await db.prepare(`SELECT c.id, c.name, c.topic, c.body, c.link, c.audience_label, c.holdout_pct, c.status,
    c.send_at, c.started_at, c.finished_at, c.created_by, c.definition,
    (SELECT json_group_object(state, n) FROM (SELECT state, COUNT(*) AS n FROM crm_campaign_recipients r WHERE r.campaign_id = c.id GROUP BY state)) AS counts
    FROM crm_campaigns c WHERE c.test_customer_id IS NULL AND c.automation_id IS NULL ORDER BY c.created_at DESC LIMIT 30`).bind().run();
  const campaigns = [];
  for (const c of results) {
    const { definition, ...rest } = c;
    const out = { ...rest, counts: JSON.parse(c.counts || '{}'),
      results: c.started_at ? await measure(env, 'c.id = ?', [c.id], { topic: c.topic, link: c.link, definition }, now) : null };
    campaigns.push(out);
  }
  return campaigns;
}

// Automatic messages with their totals, and how people sent them behaved in the 7 days after
// each send compared with the held-back group.
export async function listAutomations(env, now) {
  const db = env.CRM_DB;
  const { results = [] } = await db.prepare(`SELECT a.id, a.name, a.topic, a.body, a.link, a.definition, a.audience_label, a.holdout_pct, a.cooldown_days,
    a.active, a.created_by, a.created_at, (SELECT MAX(c.started_at) FROM crm_campaigns c WHERE c.automation_id = a.id) AS last_sent_at
    FROM crm_automations a ORDER BY a.created_at DESC`).bind().run();
  const automations = [];
  for (const a of results) {
    // The last 90 days of an automatic message's daily batches.
    const measured = await measure(env, 'c.automation_id = ? AND c.started_at >= ?', [a.id, now - 90 * DAY],
      { topic: a.topic, link: a.link, definition: a.definition }, now);
    const { definition, ...rest } = a;
    automations.push({ ...rest, active: Boolean(a.active), results: measured || {} });
  }
  return automations;
}

// --- Sending (notifier Worker) ---

// A signed "who tapped which campaign" code carried inside the (encrypted) notification. The app
// reports it when tapped, so taps count even on a phone that isn't signed in.
export async function tapToken(env, campaignId, customerId) {
  return `${campaignId}.${customerId}.${await hash(env.APP_LIMIT_SECRET, `tap:${campaignId}:${customerId}`)}`;
}
export async function recordTap(env, token, now) {
  const m = /^([a-f0-9]{64})\.([A-Za-z0-9_-]{1,64})\.([a-f0-9]{64})$/.exec(typeof token === 'string' ? token : '');
  if (!m || !env.CRM_DB || await hash(env.APP_LIMIT_SECRET, `tap:${m[1]}:${m[2]}`) !== m[3]) throw new AppError('INPUT', 400);
  await env.CRM_DB.prepare(`UPDATE crm_campaign_recipients SET tapped_at = COALESCE(tapped_at, ?) WHERE campaign_id = ? AND customer_id = ?`)
    .bind(now, m[1], m[2]).run();
}
export function campaignSenderReady(env) {
  try {
    const jwk = JSON.parse(env.APP_VAPID_PRIVATE_JWK || '');
    return campaignsReady(env) && pushReady(env) && jwk?.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.d === 'string'
      && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(env.APP_PUSH_SUBJECT || '');
  } catch { return false; }
}
// Recipients are written idempotently, so two overlapping runs produce the same list. An
// automatic message's held-back group is chosen per automation, so it stays the same people.
async function start(env, c, now, chosen = null) {
  const ids = chosen || (c.test_customer_id ? [c.test_customer_id] : await audience(env, c.definition ? JSON.parse(c.definition) : null, c.topic, now));
  const rows = [];
  for (const id of ids) rows.push([id, await heldBack(c.automation_id || c.id, id, c.holdout_pct) ? 'holdout' : 'pending']);
  for (let i = 0; i < rows.length; i += 50)
    await env.CRM_DB.batch(rows.slice(i, i + 50).map(([id, state]) => env.CRM_DB.prepare(`INSERT OR IGNORE INTO crm_campaign_recipients(campaign_id,
      customer_id, state) VALUES (?, ?, ?)`).bind(c.id, id, state)));
  await env.CRM_DB.prepare(`UPDATE crm_campaigns SET status = 'sending', started_at = ? WHERE id = ? AND status = 'scheduled'`).bind(now, c.id).run();
}
// One customer: re-checks the weekly limit and their consent, then notifies each of their phones.
async function deliver(env, deps, c, customerId) {
  const now = deps.now(), test = Boolean(c.test_customer_id);
  if (!test && (await capped(env, [customerId], now, c.id)).size) return 'capped';
  const { results: devices = [] } = await env.APP_DB.prepare(`SELECT s.endpoint, s.p256dh, s.auth FROM app_users u
    JOIN app_push_subscriptions s ON s.user_id = u.id WHERE u.customer_id = ?${test ? '' : ` AND EXISTS (SELECT 1 FROM
    app_marketing_prefs m, json_each(m.topics) t WHERE m.user_id = u.id AND t.value = ?)`}`).bind(customerId, ...(test ? [] : [c.topic])).run();
  if (!devices.length) return 'skipped';
  const message = { title: TITLE, body: test ? `Test: ${c.body}` : c.body, ...(linkTarget(c.link) || { url: '/app/' }), tag: 'treehouse-news',
    ...(!test && env.APP_LIMIT_SECRET ? { tap: await tapToken(env, c.id, customerId) } : {}) };
  let sent = false, failed = false;
  for (const device of devices) {
    const outcome = await sendPush(env, deps, device, message, c.id.slice(0, 32), { ttl: test ? 3600 : secondsUntilQuiet(now), urgency: 'normal' });
    if (outcome === 'sent') sent = true;
    else if (outcome === 'gone') await env.APP_DB.prepare('DELETE FROM app_push_subscriptions WHERE endpoint = ?').bind(device.endpoint).run();
    else failed = true;
  }
  return sent ? 'sent' : failed ? 'failed' : 'skipped';
}
// Once a day from 11 am Central: everyone who matches an active automatic message, opted in to
// its topic, and hasn't had it within its cooldown gets it as one campaign batch. People held
// back count as having had it. Over-the-limit, failed or skipped people are tried again next day.
async function runAutomations(env, now) {
  if (quietAt(now) || localHour(now) < AUTOMATION_HOUR) return;
  const db = env.CRM_DB, today = localDay(now);
  const { results = [] } = await db.prepare(`SELECT * FROM crm_automations WHERE active = 1 AND (last_run_on IS NULL OR last_run_on < ?)`)
    .bind(today).run();
  for (const a of results) {
    const claimed = await db.prepare(`UPDATE crm_automations SET last_run_on = ? WHERE id = ? AND active = 1
      AND (last_run_on IS NULL OR last_run_on < ?) RETURNING id`).bind(today, a.id, today).first();
    if (!claimed) continue; // Another run took it.
    const matching = await audience(env, a.definition ? JSON.parse(a.definition) : null, a.topic, now);
    if (!matching.length) continue;
    const { results: recent = [] } = await db.prepare(`SELECT DISTINCT r.customer_id FROM crm_campaign_recipients r
      JOIN crm_campaigns c ON c.id = r.campaign_id WHERE c.automation_id = ? AND c.started_at >= ?
      AND r.state IN ('sent', 'holdout', 'pending', 'sending') AND r.customer_id IN (SELECT value FROM json_each(?))`)
      .bind(a.id, a.cooldown_days ? now - a.cooldown_days * DAY : 0, JSON.stringify(matching)).run();
    const had = new Set(recent.map(r => r.customer_id)), ids = matching.filter(id => !had.has(id));
    if (!ids.length) continue;
    const id = randomToken();
    await db.prepare(`INSERT INTO crm_campaigns(id, name, topic, body, link, definition, audience_label, holdout_pct, automation_id,
      status, send_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`)
      .bind(id, a.name, a.topic, a.body, a.link, a.definition, a.audience_label, a.holdout_pct, a.id, now, a.created_by, now).run();
    await start(env, { id, automation_id: a.id, holdout_pct: a.holdout_pct }, now, ids);
  }
}
// The campaign assistant's updates for CRM users who turned them on, to the phones on their own
// customer record ("Use for my tests"). Sent from here because this Worker holds the key.
export async function sendOwnerAlerts(env, deps) {
  if (!campaignSenderReady(env)) return { sent: 0 };
  const db = env.CRM_DB, now = deps.now();
  const { results: alerts = [] } = await db.prepare(`SELECT id, body, audience FROM crm_owner_alerts WHERE sent_at IS NULL AND created_at > ?
    ORDER BY created_at LIMIT 5`).bind(now - DAY).run().catch(() => ({ results: [] }));
  if (!alerts.length) return { sent: 0 };
  let sent = 0;
  for (const alert of alerts) {
    const claimed = await db.prepare('UPDATE crm_owner_alerts SET sent_at = ? WHERE id = ? AND sent_at IS NULL RETURNING id').bind(now, alert.id).first();
    if (!claimed) continue;
    // Each alert goes to the people who turned on that kind: assistant updates or low-rating alerts.
    const column = alert.audience === 'feedback' ? 'notify_feedback' : 'notify_assistant';
    const { results: owners = [] } = await db.prepare(`SELECT DISTINCT test_customer_id FROM crm_settings WHERE ${column} = 1
      AND test_customer_id IS NOT NULL`).bind().run();
    for (const { test_customer_id: customerId } of owners) {
      const { results: devices = [] } = await env.APP_DB.prepare(`SELECT s.endpoint, s.p256dh, s.auth FROM app_users u
        JOIN app_push_subscriptions s ON s.user_id = u.id WHERE u.customer_id = ?`).bind(customerId).run();
      for (const device of devices) {
        const outcome = await sendPush(env, deps, device, { title: 'Treehouse CRM', body: alert.body, url: '/crm/', tag: 'treehouse-crm' },
          alert.id.slice(0, 32), { ttl: 6 * 3600, urgency: 'normal' });
        if (outcome === 'sent') sent++;
        else if (outcome === 'gone') await env.APP_DB.prepare('DELETE FROM app_push_subscriptions WHERE endpoint = ?').bind(device.endpoint).run();
      }
    }
  }
  return { sent };
}
export async function sendCampaigns(env, deps, budgetMs = 40000) {
  if (!campaignSenderReady(env)) return { sent: 0 };
  const db = env.CRM_DB, started = deps.now(), quiet = quietAt(started);
  let sent = 0;
  await runAutomations(env, started);
  const { results: due = [] } = await db.prepare(`SELECT * FROM crm_campaigns WHERE status = 'scheduled' AND send_at <= ?
    ORDER BY send_at LIMIT 5`).bind(started).run();
  for (const c of due) if (!quiet || c.test_customer_id) await start(env, c, started);
  const { results: active = [] } = await db.prepare(`SELECT * FROM crm_campaigns WHERE status = 'sending' ORDER BY started_at LIMIT 5`).bind().run();
  for (const c of active) {
    if (quiet && !c.test_customer_id) continue; // Resumes at 9 am.
    let canceled = false;
    while (!canceled && deps.now() - started < budgetMs) {
      const t = deps.now();
      // Lease a batch so an overlapping run cannot send the same customers.
      const { results: batch = [] } = await db.prepare(`UPDATE crm_campaign_recipients SET state = 'sending', attempts = attempts + 1,
        lease_until = ? WHERE campaign_id = ? AND customer_id IN (SELECT customer_id FROM crm_campaign_recipients WHERE campaign_id = ?
        AND (state = 'pending' OR (state = 'sending' AND lease_until < ?)) LIMIT ${BATCH}) RETURNING customer_id, attempts`)
        .bind(t + LEASE, c.id, c.id, t).run();
      if (!batch.length) break;
      for (const r of batch) {
        // A campaign canceled mid-send stops here; the rest are left unsent.
        const live = await db.prepare('SELECT status FROM crm_campaigns WHERE id = ?').bind(c.id).first();
        if (live?.status !== 'sending') { canceled = true; break; }
        const outcome = await deliver(env, deps, c, r.customer_id), at = deps.now();
        if (outcome === 'sent') sent++;
        if (outcome === 'failed' && r.attempts < MAX_ATTEMPTS)
          await db.prepare(`UPDATE crm_campaign_recipients SET lease_until = ? WHERE campaign_id = ? AND customer_id = ?`).bind(at + RETRY, c.id, r.customer_id).run();
        else await db.prepare(`UPDATE crm_campaign_recipients SET state = ?, sent_at = ? WHERE campaign_id = ? AND customer_id = ?`)
          .bind(outcome, outcome === 'sent' ? at : null, c.id, r.customer_id).run();
        if (outcome === 'failed') deps.report(r.attempts < MAX_ATTEMPTS ? 'CAMPAIGN_SEND' : 'CAMPAIGN_SEND_GAVE_UP');
      }
    }
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM crm_campaign_recipients WHERE campaign_id = ? AND state IN ('pending', 'sending')`).bind(c.id).first();
    if (!left?.n) await db.prepare(`UPDATE crm_campaigns SET status = 'sent', finished_at = ? WHERE id = ? AND status = 'sending'`).bind(deps.now(), c.id).run();
  }
  return { sent };
}
