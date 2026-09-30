import { b64url, fromB64url } from './http.mjs';

// Optional "remember my license number". GrowFlow's API cannot read license numbers back, so
// a customer who opts in has theirs saved here, encrypted with AES-256-GCM under
// APP_LICENSE_KEY (a Cloudflare secret, separate from every other key). The ciphertext is bound
// to the app account (additional data), so it cannot be moved to another account. The full
// number is only decrypted while placing an order and is never returned, logged or cached;
// customers see the last four characters.
export function licenseMemoryReady(env) {
  return env.APP_LICENSE_MEMORY_ENABLED === 'true' && fromB64url(env.APP_LICENSE_KEY || '')?.length === 32;
}
const key = env => crypto.subtle.importKey('raw', fromB64url(env.APP_LICENSE_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
const context = userId => new TextEncoder().encode(`treehouse-license:v1:${userId}`);

export const licenseHint = license => license.replace(/-/g, '').slice(-4);

export async function sealLicense(env, userId, license) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(userId) },
    await key(env), new TextEncoder().encode(license));
  return `v1.${b64url(iv)}.${b64url(sealed)}`;
}

// Returns the license, or null if the value is missing, altered, from another account or
// sealed under a different key.
export async function openLicense(env, userId, value) {
  const [version, iv, sealed] = String(value || '').split('.');
  const ivBytes = fromB64url(iv), sealedBytes = fromB64url(sealed);
  if (version !== 'v1' || ivBytes?.length !== 12 || !sealedBytes?.length) return null;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes,
      additionalData: context(userId) }, await key(env), sealedBytes));
  } catch { return null; }
}

export async function saveLicense(env, userId, license) {
  await env.APP_DB.prepare('UPDATE app_users SET license_enc = ?, license_hint = ? WHERE id = ?')
    .bind(await sealLicense(env, userId, license), licenseHint(license), userId).run();
  return licenseHint(license);
}
export async function forgetLicense(env, userId) {
  await env.APP_DB.prepare('UPDATE app_users SET license_enc = NULL, license_hint = NULL WHERE id = ?').bind(userId).run();
}
