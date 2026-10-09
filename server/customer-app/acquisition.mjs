import { AppError, cookie, hash, json, randomToken, readCookie } from './http.mjs';

export const SIGNUP_SOURCES = Object.freeze({
  'register-1': 'Register 1', 'register-2': 'Register 2',
  'bag-card-v1': 'Bag inserts · version 1', 'menu-tvs': 'Menu TVs', website: 'Website', social: 'Social media',
  direct: 'Direct / source unknown'
});
export const VISIT_COOKIE = '__Host-treehouse_source';
const DAY = 86400000;
export const acquisitionReady = env => env.APP_SIGNUP_TRACKING_ENABLED === 'true' && Boolean(env.APP_DB);
export const sourceValid = source => typeof source === 'string' && Object.hasOwn(SIGNUP_SOURCES, source);
// Attribution is deliberately best effort. Analytics must never stop sign-in, linking or consent.
export async function trackSafely(env, deps, fn) {
  if (!acquisitionReady(env) || deps.trackingDenied) return;
  try { return await fn(); } catch { deps.report('SIGNUP_TRACKING'); }
}
async function visitKey(request, env) {
  const token = readCookie(request, VISIT_COOKIE);
  return token ? hash(env.APP_LIMIT_SECRET, `signup-visit:${token}`) : null;
}
export async function visit(request, env, deps, input) {
  if (Object.keys(input).some(k => k !== 'source') || !sourceValid(input.source)) throw new AppError('INPUT', 400);
  if (!acquisitionReady(env) || deps.trackingDenied) return json(200, { recorded: false }, { 'Set-Cookie': cookie(VISIT_COOKIE, '', 0) });
  const now = deps.now(), existing = await visitKey(request, env);
  await env.APP_DB.prepare('DELETE FROM app_signup_visits WHERE created_at < ?').bind(now - 180 * DAY).run();
  if (existing && await env.APP_DB.prepare('SELECT id FROM app_signup_visits WHERE id = ? AND created_at > ?')
    .bind(existing, now - 30 * DAY).first()) return json(200, { recorded: true });
  const token = randomToken(), id = await hash(env.APP_LIMIT_SECRET, `signup-visit:${token}`);
  await env.APP_DB.prepare('INSERT INTO app_signup_visits(id, source, created_at) VALUES (?, ?, ?)')
    .bind(id, input.source, now).run();
  return json(200, { recorded: true }, { 'Set-Cookie': cookie(VISIT_COOKIE, token, 30 * 86400) });
}
export async function startAcquisition(request, env, stateHash, now) {
  const id = await visitKey(request, env);
  if (!id) return;
  await env.APP_DB.batch([
    env.APP_DB.prepare('UPDATE app_signup_visits SET started_at = COALESCE(started_at, ?) WHERE id = ? AND created_at > ?')
      .bind(now, id, now - 30 * DAY),
    env.APP_DB.prepare(`INSERT INTO app_signup_logins(state_hash, visit_id)
      SELECT ?, id FROM app_signup_visits WHERE id = ? AND created_at > ?`).bind(stateHash, id, now - 30 * DAY)
  ]);
}
export async function acquisitionForLogin(env, stateHash) {
  return (await env.APP_DB.prepare('SELECT visit_id FROM app_signup_logins WHERE state_hash = ?').bind(stateHash).first())?.visit_id || null;
}
export async function verifiedAcquisition(env, userId, visitId, now) {
  // Called ONLY for an INSERTed app user. Existing users are never counted as new signups.
  const updated = visitId ? await env.APP_DB.prepare(`UPDATE app_signup_visits SET user_id = ?, verified_at = ?
    WHERE id = ? AND user_id IS NULL RETURNING id`).bind(userId, now, visitId).run() : null;
  if (!updated?.results?.length) await env.APP_DB.prepare(`INSERT INTO app_signup_visits(id, source, created_at, started_at, user_id, verified_at)
    VALUES (?, 'direct', ?, ?, ?, ?)`).bind(randomToken(), now, now, userId, now).run();
}
export async function linkedAcquisition(env, userId, now) {
  await env.APP_DB.prepare('UPDATE app_signup_visits SET linked_at = COALESCE(linked_at, ?) WHERE user_id = ?').bind(now, userId).run();
}
export async function reachableAcquisition(env, userId, now) {
  await env.APP_DB.prepare(`UPDATE app_signup_visits SET reachable_at = COALESCE(reachable_at, ?)
    WHERE user_id = ? AND linked_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM app_marketing_prefs m WHERE m.user_id = ? AND m.topics <> '[]')
    AND EXISTS (SELECT 1 FROM app_push_subscriptions p WHERE p.user_id = ?)`)
    .bind(now, userId, userId, userId).run();
}
