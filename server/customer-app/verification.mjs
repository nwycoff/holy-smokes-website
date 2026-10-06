import { consumeLimits } from '../rewards.mjs';
import { AppError, cookie, fetchSafe, hash, randomToken, readCookie } from './http.mjs';
export const VERIFY_COOKIE = '__Host-treehouse_verify';
export function resendReady(env) {
  return env.APP_AUTH_RESEND_ENABLED === 'true'
    && /^[a-z0-9.-]+\.auth0\.com$/.test(env.APP_AUTH_RESEND_DOMAIN || '')
    && Boolean(env.APP_AUTH_RESEND_CLIENT_ID && env.APP_AUTH_RESEND_CLIENT_SECRET);
}
export async function verificationProof(env, subject, now) {
  // Only database users: other identity providers own their verification process.
  if (!resendReady(env) || typeof subject !== 'string' || !/^auth0\|[A-Za-z0-9_-]{1,128}$/.test(subject)) return null;
  const token = randomToken();
  await env.APP_DB.prepare('INSERT INTO app_email_verifications(token_hash, subject, expires_at) VALUES (?, ?, ?)')
    .bind(await hash(env.APP_LIMIT_SECRET, `verify:${token}`), subject, now + 600000).run();
  return cookie(VERIFY_COOKIE, token, 600);
}
async function pending(request, env, now) {
  if (!resendReady(env)) return null;
  const token = readCookie(request, VERIFY_COOKIE);
  if (!token) return null;
  const row = await env.APP_DB.prepare('SELECT subject FROM app_email_verifications WHERE token_hash = ? AND expires_at > ?')
    .bind(await hash(env.APP_LIMIT_SECRET, `verify:${token}`), now).first();
  return row ? { subject: row.subject, csrf: await hash(env.APP_LIMIT_SECRET, `verify-csrf:${token}`) } : null;
}
export async function verificationStatus(request, env, now) {
  const row = await pending(request, env, now);
  return row ? { canResend: true, csrf: row.csrf } : { canResend: false };
}
export async function resendVerification(request, env, deps, input, ip) {
  if (Object.keys(input).length) throw new AppError('INPUT', 400);
  const row = await pending(request, env, deps.now());
  if (!row || request.headers.get('x-treehouse-csrf') !== row.csrf) throw new AppError('VERIFY_AGAIN', 403);
  if (!await consumeLimits(env.APP_DB, env.APP_LIMIT_SECRET, [
    { subject: `verify-minute:${row.subject}`, max: 1, window: 60000 },
    { subject: `verify-day:${row.subject}`, max: 3, window: 86400000 },
    { subject: `verify-ip:${ip}`, max: 30, window: 900000 },
    { subject: 'verify-global', max: 100, window: 3600000 }
  ], deps.now())) throw new AppError('VERIFY_LIMIT', 429);
  const origin = `https://${env.APP_AUTH_RESEND_DOMAIN}`;
  const tokenRes = await fetchSafe(deps, `${origin}/oauth/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials',
      client_id: env.APP_AUTH_RESEND_CLIENT_ID, client_secret: env.APP_AUTH_RESEND_CLIENT_SECRET,
      audience: `${origin}/api/v2/`, scope: 'update:users' }) });
  if (!tokenRes.ok) throw new AppError('VERIFY_PROVIDER');
  const token = await tokenRes.json();
  if (typeof token.access_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer') throw new AppError('VERIFY_PROVIDER');
  const result = await fetchSafe(deps, `${origin}/api/v2/jobs/verification-email`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.access_token}` },
    body: JSON.stringify({ user_id: row.subject, client_id: env.APP_AUTH_CLIENT_ID }) });
  if (result.status !== 201) throw new AppError('VERIFY_PROVIDER');
  return { requested: true }; // Provider acceptance, not a claim of inbox delivery.
}
