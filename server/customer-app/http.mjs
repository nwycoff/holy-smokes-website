export const DAY = 86400000;
export const SESSION_SECONDS = 7 * 86400;
export const SESSION_COOKIE = '__Host-treehouse_session';
export const LOGIN_COOKIE = '__Host-treehouse_login';
export class AppError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
export const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private', 'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Vary': 'Cookie', ...extra }
});
export function redirect(location, cookies = []) {
  const response = json(303, {}, { Location: location });
  for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
  return response;
}
export const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
export function readCookie(request, name) {
  const matches = (request.headers.get('cookie') || '').split(';').map(v => v.trim())
    .filter(v => v.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function hash(secret, value) {
  const encode = s => new TextEncoder().encode(s);
  const key = await crypto.subtle.importKey('raw', encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encode(value))),
    b => b.toString(16).padStart(2, '0')).join('');
}
export function sameOrigin(request) {
  return request.headers.get('origin') === new URL(request.url).origin
    && !['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'));
}
export async function bodyJSON(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json' || !request.body)
    throw new AppError('INPUT', 400);
  const reader = request.body.getReader();
  let size = 0; const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) { await reader.cancel(); throw new AppError('INPUT', 400); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AppError('INPUT', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INPUT', 400);
  return body;
}
export function enabled(env, url) {
  return env.APP_ENABLED === 'true' && url.protocol === 'https:' && Boolean(env.APP_DB)
    && String(env.APP_ALLOWED_HOSTS || '').split(',').map(x => x.trim()).includes(url.hostname)
    && typeof env.APP_LIMIT_SECRET === 'string' && env.APP_LIMIT_SECRET.length >= 32;
}
export function authReady(env) {
  try {
    const issuer = new URL(env.APP_AUTH_ISSUER);
    return issuer.protocol === 'https:' && issuer.pathname === '/' && !issuer.search && !issuer.hash
      && !issuer.username && !issuer.password && !issuer.port
      && Boolean(env.APP_AUTH_CLIENT_ID && env.APP_AUTH_CLIENT_SECRET);
  } catch { return false; }
}
export function growflowReady(env) {
  return /^[a-z0-9-]+$/.test(env.GROWFLOW_ORG || '')
    && /^gfr_[^\s\u0000-\u001f\u007f]{1,4092}$/.test(env.APP_GROWFLOW_TOKEN || '');
}
export function menuReady(env) {
  return growflowReady(env) && env.APP_MENU_ENABLED === 'true'
    && Boolean(env.APP_MENU_KEY?.trim() && env.APP_FRONT_LOCATION?.trim());
}
export function rewardTiersReady(env) {
  return growflowReady(env) && env.APP_REWARD_TIERS_ENABLED === 'true';
}
export function preorderReady(env) {
  return menuReady(env) && env.APP_PREORDER_ENABLED === 'true'
    && /^gfr_[^\s\u0000-\u001f\u007f]{1,4092}$/.test(env.APP_PREORDER_TOKEN || '')
    && env.APP_PREORDER_TOKEN !== env.APP_GROWFLOW_TOKEN;
}
export async function fetchSafe(deps, url, init = {}, timeoutMs = 10000) {
  const res = await deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  if (res.status >= 300 && res.status < 400) throw new AppError('UPSTREAM_REDIRECT');
  return res;
}

// Base64url without padding, as used by Web Push and stored encrypted values.
export const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function fromB64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch { return null; }
}
