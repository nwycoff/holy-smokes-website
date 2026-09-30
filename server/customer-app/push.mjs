import { AppError, fetchSafe } from './http.mjs';
import { refreshStatus } from './preorders.mjs';

// "Your order is ready" notifications. Standard Web Push: payloads are encrypted for each
// device (RFC 8291, aes128gcm) and requests are signed with the app's VAPID key (RFC 8292).
// Notifications carry no order details, names or items.
const encoder = new TextEncoder();
export const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function fromB64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch { return null; }
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// Push services the app will send to. Anything else is refused, so a stored endpoint
// can never make the server call an arbitrary URL.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
export function pushEndpoint(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && value.length <= 1024 && url.protocol === 'https:' && !url.port
      && !url.username && !url.password && PUSH_HOSTS.some(host => host.test(url.hostname)) ? url.href : null;
  } catch { return null; }
}
export function readSubscription(input) {
  const keys = input?.keys;
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['endpoint', 'keys', 'expirationTime'].includes(k))
    || !keys || typeof keys !== 'object' || Object.keys(keys).some(k => !['p256dh', 'auth'].includes(k))) return null;
  const endpoint = pushEndpoint(input.endpoint), p256dh = fromB64url(keys.p256dh), auth = fromB64url(keys.auth);
  if (!endpoint || p256dh?.length !== 65 || p256dh[0] !== 4 || auth?.length !== 16) return null;
  return { endpoint, p256dh: b64url(p256dh), auth: b64url(auth) };
}

// The website only needs the public key to let devices subscribe.
export function pushReady(env) {
  return env.APP_PUSH_ENABLED === 'true' && fromB64url(env.APP_VAPID_PUBLIC_KEY)?.length === 65;
}
// The scheduled notifier also needs the private key, a contact for push services, GrowFlow
// access and the shared limiter secret.
export function senderReady(env) {
  try {
    const jwk = JSON.parse(env.APP_VAPID_PRIVATE_JWK || '');
    return pushReady(env) && env.APP_PREORDER_ENABLED === 'true' && Boolean(env.APP_DB)
      && jwk?.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.d === 'string'
      && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(env.APP_PUSH_SUBJECT || '')
      && typeof env.APP_LIMIT_SECRET === 'string' && env.APP_LIMIT_SECRET.length >= 32
      && /^[a-z0-9-]+$/.test(env.GROWFLOW_ORG || '') && /^gfr_\S+$/.test(env.APP_PREORDER_TOKEN || '');
  } catch { return false; }
}

export async function vapidAuthorization(env, endpoint, now) {
  const header = b64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600, sub: env.APP_PUSH_SUBJECT })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.APP_VAPID_PRIVATE_JWK),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${env.APP_VAPID_PUBLIC_KEY}`;
}

// RFC 8291 message encryption with a single aes128gcm record (RFC 8188).
export async function encryptPayload(subscription, plaintext) {
  const uaPublic = fromB64url(subscription.p256dh), authSecret = fromB64url(subscription.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hmac(await hmac(authSecret, shared),
    concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(encoder.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(encoder.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key,
    concat(encoder.encode(plaintext), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

// Returns 'sent', 'gone' (subscription expired or revoked) or 'failed'.
// `topic` lets the push service replace an undelivered copy instead of queueing a second one.
export async function sendPush(env, deps, subscription, message, topic) {
  const endpoint = pushEndpoint(subscription.endpoint);
  if (!endpoint) return 'gone';
  try {
    const res = await fetchSafe(deps, endpoint, { method: 'POST', headers: {
      Authorization: await vapidAuthorization(env, endpoint, deps.now()),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high',
      ...(topic ? { Topic: topic } : {})
    }, body: await encryptPayload(subscription, JSON.stringify(message)) });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'failed';
  } catch { return 'failed'; }
}

export const READY_MESSAGE = { title: 'Your Treehouse order is ready', body: 'Come on by. Pay at pickup, and bring your ID and medical card.', url: '/app/#order' };
const RECENT = 12 * 3600000, PER_RUN = 10;
// Per-device delivery: a run leases a delivery before sending, so overlapping runs cannot
// both send it. Failures retry after 1, 2, 4 and 8 minutes (5 attempts in all). A run that
// dies mid-send leaves the lease to expire, so that device is retried rather than lost.
export const MAX_ATTEMPTS = 5;
const LEASE = 120000, backoff = attempts => Math.min(60000 * 2 ** (attempts - 1), 900000);

async function claimDelivery(env, orderId, endpoint, now) {
  return env.APP_DB.prepare(`INSERT INTO app_push_deliveries(preorder_id, endpoint, state, attempts, retry_at, updated_at)
    VALUES (?, ?, 'sending', 1, ?, ?)
    ON CONFLICT(preorder_id, endpoint) DO UPDATE SET state = 'sending', attempts = attempts + 1,
      retry_at = excluded.retry_at, updated_at = excluded.updated_at
    WHERE app_push_deliveries.state IN ('sending', 'failed') AND app_push_deliveries.retry_at <= ?
      AND app_push_deliveries.attempts < ${MAX_ATTEMPTS}
    RETURNING attempts`).bind(orderId, endpoint, now + LEASE, now, now).first();
}

// Devices still owed this order's notification: never tried, or failed/interrupted with
// attempts left. Delivered, gone and exhausted devices are finished.
async function pendingDevices(env, row) {
  const { results = [] } = await env.APP_DB.prepare(`SELECT s.endpoint, s.p256dh, s.auth FROM app_push_subscriptions s
    LEFT JOIN app_push_deliveries d ON d.preorder_id = ? AND d.endpoint = s.endpoint
    WHERE s.user_id = ? AND (d.endpoint IS NULL OR (d.state IN ('sending', 'failed') AND d.attempts < ${MAX_ATTEMPTS}))`)
    .bind(row.id, row.user_id).run();
  return results;
}

// Runs on a schedule (every minute). Checks recent open orders whose owners turned on
// notifications, and notifies each device when GrowFlow marks the order Fulfilled.
export async function notifyReadyOrders(env, deps) {
  if (!senderReady(env)) return { checked: 0, notified: 0 };
  const { results = [] } = await env.APP_DB.prepare(`SELECT * FROM app_preorders p
    WHERE p.open = 1 AND p.order_id IS NOT NULL AND p.notified_ready = 0 AND p.created_at > ?
    AND EXISTS (SELECT 1 FROM app_push_subscriptions s WHERE s.user_id = p.user_id)
    ORDER BY p.checked_at LIMIT ${PER_RUN}`).bind(deps.now() - RECENT).run();
  let notified = 0;
  for (const row of results) {
    // Re-check even Fulfilled orders (at most every 30 seconds) so a pickup stops retries.
    const latest = await refreshStatus(env, deps, row);
    if (latest.status !== 'Fulfilled' || !latest.open) continue;
    for (const device of await pendingDevices(env, row)) {
      const claim = await claimDelivery(env, row.id, device.endpoint, deps.now());
      if (!claim) continue; // Another run holds it, or it is waiting for its retry time.
      const outcome = await sendPush(env, deps, device, READY_MESSAGE, row.id.slice(0, 32));
      const now = deps.now();
      if (outcome === 'sent') notified++;
      else if (outcome === 'gone') await env.APP_DB.prepare('DELETE FROM app_push_subscriptions WHERE endpoint = ?').bind(device.endpoint).run();
      else deps.report(claim.attempts >= MAX_ATTEMPTS ? 'PUSH_SEND_GAVE_UP' : 'PUSH_SEND');
      await env.APP_DB.prepare(`UPDATE app_push_deliveries SET state = ?, retry_at = ?, updated_at = ?
        WHERE preorder_id = ? AND endpoint = ?`).bind(outcome === 'failed' ? 'failed' : outcome,
        now + backoff(claim.attempts), now, row.id, device.endpoint).run();
    }
    // The order is finished once no device is still owed a delivery.
    if (!(await pendingDevices(env, row)).length)
      await env.APP_DB.prepare('UPDATE app_preorders SET notified_ready = 1 WHERE id = ?').bind(row.id).run();
  }
  return { checked: results.length, notified };
}

export async function subscribe(env, deps, s, input) {
  const subscription = readSubscription(input);
  if (!subscription) throw new AppError('INPUT', 400);
  // A device belongs to whoever subscribed it last. Keep at most five devices per account.
  await env.APP_DB.batch([
    env.APP_DB.prepare(`INSERT INTO app_push_subscriptions(endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
      created_at = excluded.created_at`).bind(subscription.endpoint, s.id, subscription.p256dh, subscription.auth, deps.now()),
    env.APP_DB.prepare(`DELETE FROM app_push_subscriptions WHERE user_id = ? AND endpoint NOT IN
      (SELECT endpoint FROM app_push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5)`).bind(s.id, s.id)
  ]);
}
export async function unsubscribe(env, s, input) {
  const endpoint = pushEndpoint(input?.endpoint);
  if (!endpoint || Object.keys(input).some(k => k !== 'endpoint')) throw new AppError('INPUT', 400);
  await env.APP_DB.prepare('DELETE FROM app_push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(endpoint, s.id).run();
}
