import { AppError, randomToken } from '../customer-app/http.mjs';
import { createAutomation, createCampaign, localDay, setAutomationActive, validateAutomation, validateCampaign } from './campaigns.mjs';

// The CRM side of the campaign assistant: its suggestions, runs and budget. The assistant itself
// (server/crm/assistant.mjs) runs in its own Worker; this file never calls the AI.
const DAY = 86400000;
export const SCHEDULE = { weekly: { weekday: 'Mon', hour: 9 }, daily: { hour: 10 } };
// Open suggestions expire after 14 days (see tickAssistant).

export const assistantReady = env => env.CRM_ASSISTANT_ENABLED === 'true' && Boolean(env.CRM_DB && env.APP_DB);
export const budgetCents = env => { const v = Number(env.CRM_ASSISTANT_BUDGET_CENTS); return Number.isInteger(v) && v > 0 ? v : 2500; };
// Spending this calendar month (Central), in cents.
export async function spentCents(env, now) {
  const [year, month] = localDay(now).split('-');
  const row = await env.CRM_DB.prepare('SELECT COALESCE(SUM(cost_micro), 0) AS micro FROM crm_assistant_runs WHERE created_at >= ?')
    .bind(Date.parse(`${year}-${month}-01T06:00:00Z`)).first();
  return Math.round((row?.micro || 0) / 10000);
}

export async function requestRun(env, user, kind, now) {
  if (!['weekly', 'daily'].includes(kind)) throw new AppError('INPUT', 400);
  const busy = await env.CRM_DB.prepare(`SELECT id FROM crm_assistant_runs WHERE status IN ('requested', 'running')`).bind().first();
  if (busy) return { queued: true, already: true };
  await env.CRM_DB.prepare(`INSERT INTO crm_assistant_runs(id, kind, trigger, requested_by, status, created_at) VALUES (?, ?, 'manual', ?, 'requested', ?)`)
    .bind(randomToken(), kind, user, now).run();
  return { queued: true };
}
export async function assistantView(env, now, user) {
  const db = env.CRM_DB;
  const { results: suggestions = [] } = await db.prepare(`SELECT id, kind, title, reasoning, payload, status, decided_by, decided_at, decision_note, created_at
    FROM crm_suggestions WHERE status = 'open' OR decided_at >= ? ORDER BY status = 'open' DESC, created_at DESC LIMIT 40`).bind(now - 30 * DAY).run();
  const { results: runs = [] } = await db.prepare(`SELECT id, kind, trigger, requested_by, model, status, summary, cost_micro, turns, error, created_at, finished_at
    FROM crm_assistant_runs ORDER BY created_at DESC LIMIT 10`).bind().run();
  const { results: notes = [] } = await db.prepare('SELECT at, text FROM crm_assistant_notes ORDER BY id DESC LIMIT 30').bind().run();
  return { suggestions: suggestions.map(s => ({ ...s, payload: JSON.parse(s.payload) })), runs, notes,
    spentCents: await spentCents(env, now), budgetCents: budgetCents(env), schedule: SCHEDULE,
    me: await env.CRM_DB.prepare('SELECT test_customer_id IS NOT NULL AS testPhone, notify_assistant AS notify FROM crm_settings WHERE email = ?')
      .bind(user).first().then(r => ({ testPhone: Boolean(r?.testPhone), notify: Boolean(r?.notify) })) };
}
// Whether this CRM user's phone (their own customer record) gets the assistant's updates.
export async function setAssistantUpdates(env, user, on, now) {
  if (typeof on !== 'boolean') throw new AppError('INPUT', 400);
  const row = await env.CRM_DB.prepare('UPDATE crm_settings SET notify_assistant = ?, updated_at = ? WHERE email = ? AND test_customer_id IS NOT NULL RETURNING email')
    .bind(on ? 1 : 0, now, user).first();
  if (!row) throw new AppError('CAMPAIGN_TEST_PHONE', 400);
  return { notify: on };
}
// Approving creates exactly what the suggestion describes, re-checked against today's rules.
export async function decideSuggestion(env, user, input, now) {
  const { id, decision } = input || {}, note = typeof input?.note === 'string' ? input.note.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !['approved', 'dismissed', 'edited'].includes(decision)) throw new AppError('INPUT', 400);
  const s = await env.CRM_DB.prepare(`SELECT * FROM crm_suggestions WHERE id = ? AND status = 'open'`).bind(id).first();
  if (!s) throw new AppError('SUGGESTION_DONE', 409);
  const payload = JSON.parse(s.payload), by = `${user} (from assistant)`;
  if (decision === 'approved') {
    if (s.kind === 'campaign') {
      const { reachWhenSuggested, ...rest } = payload;
      await createCampaign(env, by, validateCampaign({ ...rest, sendAt: rest.sendAt && rest.sendAt > now ? rest.sendAt : null }, env, now), now);
    } else if (s.kind === 'automation') await createAutomation(env, by, validateAutomation(payload, env, now), now);
    else if (s.kind === 'pause') await setAutomationActive(env, payload.automationId, false, now);
  }
  await env.CRM_DB.prepare(`UPDATE crm_suggestions SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'open'`)
    .bind(decision, user, now, note, id).run();
  return { decision };
}
