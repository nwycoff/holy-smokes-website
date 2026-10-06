import { AppError, randomToken } from '../customer-app/http.mjs';
import { acquisitionReady, SIGNUP_SOURCES, sourceValid } from '../customer-app/acquisition.mjs';
const DAY = 86400000;

export async function signupReport(env, now, days) {
  if (![7, 30, 90].includes(days)) throw new AppError('INPUT', 400);
  if (!env.APP_DB) return { available: false };
  // Cohorts are grouped by the first observed browser visit. Conversions can happen later.
  const since = now - days * DAY;
  let groups;
  try {
    groups = (await env.APP_DB.prepare(`SELECT v.source, COUNT(*) AS visitors,
      SUM(v.started_at IS NOT NULL) AS started, SUM(v.verified_at IS NOT NULL) AS verified,
      SUM(v.linked_at IS NOT NULL) AS linked, SUM(v.reachable_at IS NOT NULL) AS reachable,
      SUM(v.linked_at IS NOT NULL AND EXISTS (SELECT 1 FROM app_marketing_prefs m WHERE m.user_id = v.user_id AND m.topics <> '[]')
        AND EXISTS (SELECT 1 FROM app_push_subscriptions p WHERE p.user_id = v.user_id)) AS reachable_now
      FROM app_signup_visits v WHERE v.created_at >= ? AND v.created_at <= ? GROUP BY v.source`).bind(since, now).run()).results || [];
  } catch { throw new AppError('SIGNUP_SETUP'); }
  const costs = (await env.CRM_DB.prepare(`SELECT source, SUM(cents) AS cents FROM crm_signup_spend
    WHERE spent_at >= ? AND spent_at <= ? GROUP BY source`).bind(since, now).run()).results || [];
  const rows = Object.entries(SIGNUP_SOURCES).map(([source, label]) => ({ source, label,
    visitors: 0, started: 0, verified: 0, linked: 0, reachable: 0, reachable_now: 0,
    ...groups.find(g => g.source === source), spend_cents: costs.find(c => c.source === source)?.cents || 0,
    preorder_customers: 0, visit_customers: 0, revenue_cents: 0 }));
  let after = '', pages = 0, complete = true;
  for (;;) {
    const batch = (await env.APP_DB.prepare(`SELECT v.id, v.source, v.linked_at, u.customer_id FROM app_signup_visits v
      JOIN app_users u ON u.id = v.user_id WHERE v.created_at >= ? AND v.created_at <= ?
      AND v.linked_at IS NOT NULL AND u.customer_id IS NOT NULL AND v.id > ? ORDER BY v.id LIMIT 200`)
      .bind(since, now, after).run()).results || [];
    if (!batch.length) break;
    // Aggregate only already-synced CRM sales. No live GrowFlow requests or IDs in the response.
    const sales = (await env.CRM_DB.prepare(`WITH cohort AS (
      SELECT json_extract(value, '$.customer_id') AS customer_id, json_extract(value, '$.source') AS source,
        json_extract(value, '$.linked_at') AS linked_at FROM json_each(?)
    ) SELECT c.source, COUNT(DISTINCT o.customer_id) AS visit_customers,
      COUNT(DISTINCT CASE WHEN o.is_preorder = 1 THEN o.customer_id END) AS preorder_customers,
      COALESCE(SUM(o.total_cents), 0) AS revenue_cents
      FROM cohort c JOIN crm_orders o ON o.customer_id = c.customer_id AND o.completed_at > c.linked_at
        AND o.completed_at <= MIN(c.linked_at + ?, ?) GROUP BY c.source`)
      .bind(JSON.stringify(batch), 30 * DAY, now).run()).results || [];
    for (const sale of sales) {
      const row = rows.find(r => r.source === sale.source);
      if (row) for (const key of ['visit_customers', 'preorder_customers', 'revenue_cents']) row[key] += sale[key];
    }
    after = batch.at(-1).id;
    if (batch.length < 200) break;
    // Bound dashboard work; never silently report partial sales totals.
    if (++pages >= 25) { complete = false; break; }
  }
  if (!complete) for (const row of rows) for (const key of ['visit_customers', 'preorder_customers', 'revenue_cents']) row[key] = null;
  const spend = (await env.CRM_DB.prepare(`SELECT id, source, spent_at, cents FROM crm_signup_spend
    WHERE spent_at >= ? AND spent_at <= ? ORDER BY spent_at DESC LIMIT 50`).bind(since, now).run()).results || [];
  return { available: true, trackingEnabled: acquisitionReady(env), days, since, until: now, rows, spend, salesComplete: complete };
}

export function validateSignupSpend(input, now) {
  if (Object.keys(input).some(k => !['id', 'source', 'cents', 'date'].includes(k)) || !sourceValid(input.source) || input.source === 'direct'
    || !Number.isSafeInteger(input.cents) || input.cents < 1 || input.cents > 1000000
    || typeof input.id !== 'string' || !/^[a-f0-9]{32}$/.test(input.id)
    || typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new AppError('INPUT', 400);
  // Noon UTC is the same calendar date in Oklahoma; do not accidentally store tomorrow's expense.
  let at = Date.parse(`${input.date}T12:00:00Z`);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== input.date || input.date > today || at < now - 180 * DAY)
    throw new AppError('INPUT', 400);
  at = Math.min(at, now);
  return { id: input.id, source: input.source, cents: input.cents, at };
}
export async function saveSignupSpend(env, input, actor, now) {
  const value = validateSignupSpend(input, now);
  // The request ID makes browser/network retries idempotent, including the audit record.
  await env.CRM_DB.batch([
    env.CRM_DB.prepare(`INSERT INTO crm_audit(id, at, actor, action, detail)
      SELECT ?, ?, ?, 'signup_spend', ? WHERE NOT EXISTS (SELECT 1 FROM crm_signup_spend WHERE id = ?)`)
      .bind(randomToken(), now, actor, JSON.stringify({ source: value.source, cents: value.cents }), value.id),
    env.CRM_DB.prepare(`INSERT INTO crm_signup_spend(id, source, spent_at, cents, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).bind(value.id, value.source, value.at, value.cents, now, actor)
  ]);
}
