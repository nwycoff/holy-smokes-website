import { AppError, randomToken } from '../customer-app/http.mjs';
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
export const HOLDOUTS = [0, 5, 10, 20];
export const TITLE = 'Treehouse Pharmacy';
// Words that would say "cannabis" on a lock screen, and health claims Oklahoma rules forbid.
const NOT_DISCREET = /\b(cannabis|marijuana|weed|thc|cbd|dispensary|dabs?|vapes?|carts?|cartridges?|joints?|pre-?rolls?|blunts?|stoned|420|edibles?|gummies|indica|sativa|strains?|kush|grams?|ounces?|oz)\b/i;
const HEALTH_CLAIM = /\b(cures?|cured|heals?|healing|relief|relieves?|anxiety|pain|insomnia|depression|medicine)\b/i;
const LEASE = 120000, RETRY = 300000, MAX_ATTEMPTS = 3, BATCH = 25;

export const campaignsReady = env => env.CRM_CAMPAIGNS_ENABLED === 'true' && Boolean(env.CRM_DB && env.APP_DB);

function localHour(ms) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: QUIET.zone, hour: 'numeric', hourCycle: 'h23' }).format(ms));
}
export const quietAt = ms => { const h = localHour(ms); return h < QUIET.start || h >= QUIET.end; };
// Seconds left before quiet hours, so a phone that is offline never receives it late at night.
function secondsUntilQuiet(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: QUIET.zone, hour: 'numeric', minute: 'numeric',
    hourCycle: 'h23' }).formatToParts(ms).map(p => [p.type, p.value]));
  return Math.max(600, ((QUIET.end - Number(parts.hour)) * 60 - Number(parts.minute)) * 60);
}
const clean = (text, max) => typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

// Checks a campaign the CRM is about to preview, test or send. Returns the stored form.
export function validateCampaign(input, env, now) {
  const fail = code => { throw new AppError(code, 400); };
  const allowed = ['name', 'topic', 'body', 'link', 'definition', 'audienceLabel', 'holdoutPct', 'sendAt'];
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !allowed.includes(k))) fail('INPUT');
  const name = clean(input.name, 60), body = clean(input.body, 200), audienceLabel = clean(input.audienceLabel, 80) || 'Everyone opted in';
  if (!name) fail('CAMPAIGN_NAME');
  if (!TOPICS.includes(input.topic)) fail('INPUT');
  if (body.length < 10 || body.length > 120) fail('CAMPAIGN_LENGTH');
  if (NOT_DISCREET.test(body)) fail('CAMPAIGN_DISCREET');
  if (HEALTH_CLAIM.test(body)) fail('CAMPAIGN_CLAIMS');
  if (!Object.hasOwn(LINKS, input.link)) fail('INPUT');
  if (!HOLDOUTS.includes(input.holdoutPct)) fail('INPUT');
  const definition = input.definition === null || input.definition === undefined ? null : validateDefinition(input.definition);
  const sendAt = input.sendAt === null || input.sendAt === undefined ? now : input.sendAt;
  if (!Number.isInteger(sendAt) || sendAt < now - 60000 || sendAt > now + 30 * DAY) fail('CAMPAIGN_TIME');
  return { name, topic: input.topic, body, link: input.link, definition, audienceLabel, holdoutPct: input.holdoutPct, sendAt };
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
export async function cancelCampaign(env, id, now) {
  const row = await env.CRM_DB.prepare(`UPDATE crm_campaigns SET status = 'canceled', finished_at = ?
    WHERE id = ? AND status IN ('scheduled', 'sending') RETURNING id`).bind(now, id).first();
  if (!row) throw new AppError('CAMPAIGN_DONE', 409);
}

// Campaigns for the CRM page, with who got them and, after sending, how both groups behaved in
// the 7 days that followed. Held-back customers are the baseline for "did it make a difference".
export async function listCampaigns(env, now) {
  const db = env.CRM_DB;
  const { results = [] } = await db.prepare(`SELECT c.id, c.name, c.topic, c.body, c.link, c.audience_label, c.holdout_pct, c.status,
    c.send_at, c.started_at, c.finished_at, c.created_by,
    (SELECT json_group_object(state, n) FROM (SELECT state, COUNT(*) AS n FROM crm_campaign_recipients r WHERE r.campaign_id = c.id GROUP BY state)) AS counts
    FROM crm_campaigns c WHERE c.test_customer_id IS NULL ORDER BY c.created_at DESC LIMIT 30`).bind().run();
  const campaigns = [];
  for (const c of results) {
    const out = { ...c, counts: JSON.parse(c.counts || '{}'), results: null };
    if (c.started_at) {
      const end = Math.min(now, c.started_at + 7 * DAY);
      const { results: groups = [] } = await db.prepare(`SELECT r.state, COUNT(*) AS people,
        SUM(EXISTS (SELECT 1 FROM crm_orders o WHERE o.customer_id = r.customer_id AND o.completed_at BETWEEN ? AND ?)) AS visited,
        SUM((SELECT COALESCE(SUM(o.total_cents), 0) FROM crm_orders o WHERE o.customer_id = r.customer_id AND o.completed_at BETWEEN ? AND ?)) AS cents
        FROM crm_campaign_recipients r WHERE r.campaign_id = ? AND r.state IN ('sent', 'holdout') GROUP BY r.state`)
        .bind(c.started_at, end, c.started_at, end, c.id).run();
      out.results = { days: Math.round((end - c.started_at) / DAY * 10) / 10,
        ...Object.fromEntries(groups.map(g => [g.state, { people: g.people, visited: g.visited || 0, cents: g.cents || 0 }])) };
    }
    campaigns.push(out);
  }
  return campaigns;
}

// --- Sending (notifier Worker) ---

export function campaignSenderReady(env) {
  try {
    const jwk = JSON.parse(env.APP_VAPID_PRIVATE_JWK || '');
    return campaignsReady(env) && pushReady(env) && jwk?.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.d === 'string'
      && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(env.APP_PUSH_SUBJECT || '');
  } catch { return false; }
}
// Recipients are written idempotently, so two overlapping runs produce the same list.
async function start(env, c, now) {
  const ids = c.test_customer_id ? [c.test_customer_id] : await audience(env, c.definition ? JSON.parse(c.definition) : null, c.topic, now);
  const rows = [];
  for (const id of ids) rows.push([id, await heldBack(c.id, id, c.holdout_pct) ? 'holdout' : 'pending']);
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
  const message = { title: TITLE, body: test ? `Test: ${c.body}` : c.body, url: LINKS[c.link] || '/app/', tag: 'treehouse-news' };
  let sent = false, failed = false;
  for (const device of devices) {
    const outcome = await sendPush(env, deps, device, message, c.id.slice(0, 32), { ttl: test ? 3600 : secondsUntilQuiet(now), urgency: 'normal' });
    if (outcome === 'sent') sent = true;
    else if (outcome === 'gone') await env.APP_DB.prepare('DELETE FROM app_push_subscriptions WHERE endpoint = ?').bind(device.endpoint).run();
    else failed = true;
  }
  return sent ? 'sent' : failed ? 'failed' : 'skipped';
}
export async function sendCampaigns(env, deps, budgetMs = 40000) {
  if (!campaignSenderReady(env)) return { sent: 0 };
  const db = env.CRM_DB, started = deps.now(), quiet = quietAt(started);
  let sent = 0;
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
