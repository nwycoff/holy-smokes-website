import { AppError, preorderReady } from './http.mjs';
import { pushReady } from './push.mjs';

// "Deals & news": marketing notifications, separate from order-ready alerts. Consent is per
// account and per topic, and every change is logged with when and where it was made. Turning
// it off is one tap. Devices come from the same push subscriptions as order-ready alerts.
export const TOPICS = ['new_arrivals', 'rewards', 'events', 'specials'];
// A customer who says "Not now" is not asked again for this long.
export const ASK_AGAIN_MS = 90 * 86400000;
const SOURCES = ['account', 'prompt'];

export function marketingReady(env) {
  return env.APP_MARKETING_ENABLED === 'true' && pushReady(env) && preorderReady(env);
}
function readTopics(text) {
  try { const topics = JSON.parse(text || '[]'); return Array.isArray(topics) ? TOPICS.filter(t => topics.includes(t)) : []; }
  catch { return []; }
}
// What the app shows: the chosen topics, and whether it may ask the customer to opt in.
export async function marketingState(env, deps, userId) {
  const row = await env.APP_DB.prepare('SELECT topics, asked_at FROM app_marketing_prefs WHERE user_id = ?').bind(userId).first();
  const topics = readTopics(row?.topics);
  return { topics, ask: !topics.length && (!row?.asked_at || deps.now() - row.asked_at > ASK_AGAIN_MS) };
}
// { topics: [...], source } sets the topics ([] turns it off); { dismissed: true } records "Not now".
export async function setMarketing(env, deps, s, input) {
  const db = env.APP_DB, now = deps.now();
  if (input.dismissed === true && Object.keys(input).length === 1) {
    await db.prepare(`INSERT INTO app_marketing_prefs(user_id, topics, asked_at, updated_at) VALUES (?, '[]', ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET asked_at = excluded.asked_at, updated_at = excluded.updated_at`).bind(s.id, now, now).run();
    return marketingState(env, deps, s.id);
  }
  const { topics, source } = input;
  if (Object.keys(input).some(k => !['topics', 'source'].includes(k)) || !SOURCES.includes(source) || !Array.isArray(topics)
    || topics.length > TOPICS.length || topics.some(t => !TOPICS.includes(t)) || new Set(topics).size !== topics.length)
    throw new AppError('INPUT', 400);
  const chosen = JSON.stringify(TOPICS.filter(t => topics.includes(t)));
  // The log entry is written only when the topics actually change, before the new value lands.
  await db.batch([
    db.prepare(`INSERT INTO app_marketing_consent_log(user_id, at, topics, source) SELECT ?, ?, ?, ?
      WHERE ? IS NOT COALESCE((SELECT topics FROM app_marketing_prefs WHERE user_id = ?), '[]')`).bind(s.id, now, chosen, source, chosen, s.id),
    db.prepare(`INSERT INTO app_marketing_prefs(user_id, topics, opted_in_at, asked_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET topics = excluded.topics,
        opted_in_at = CASE WHEN excluded.topics = '[]' THEN NULL WHEN app_marketing_prefs.topics = '[]' THEN excluded.opted_in_at
          ELSE app_marketing_prefs.opted_in_at END,
        asked_at = excluded.asked_at, updated_at = excluded.updated_at`).bind(s.id, chosen, chosen === '[]' ? null : now, now, now)
  ]);
  return marketingState(env, deps, s.id);
}
