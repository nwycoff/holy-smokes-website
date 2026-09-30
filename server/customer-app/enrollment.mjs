import { AppError, hash } from './http.mjs';

// Uniform eight-digit values, including leading zeroes. Discard the uneven tail
// of the uint32 range instead of introducing modulo bias.
export function enrollmentCode(fill = values => crypto.getRandomValues(values)) {
  const values = new Uint32Array(1);
  for (let attempt = 0; attempt < 32; attempt++) {
    fill(values);
    if (values[0] < 4200000000) return String(values[0] % 100000000).padStart(8, '0');
  }
  throw new AppError('ENROLLMENT_BUSY');
}

export function normalizeEnrollmentCode(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const trimmed = value.trim();
  if (/^(?:[0-9]{8}|[0-9]{4}[ -][0-9]{4})$/.test(trimmed)) return trimmed.replace(/[ -]/g, '');
  // Previously issued codes remain usable until their original expiry.
  if (/^(?:[A-Fa-f0-9]{20}|[A-Fa-f0-9]{4}(?:-[A-Fa-f0-9]{4}){4})$/.test(trimmed))
    return trimmed.replaceAll('-', '').toUpperCase();
  return null;
}

function codeCollision(error) {
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
    if (/UNIQUE constraint failed: app_enrollments\.code_hash(?:\b|$)/.test(error.message || '')) return true;
  }
  return false;
}

// The primary key is the final collision guard, including concurrent issuers.
// commit must be a single write or atomic batch so a collision rolls everything back.
export async function withEnrollmentCode(env, commit, fill) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = enrollmentCode(fill), codeHash = await hash(env.APP_LIMIT_SECRET, `enroll:${code}`);
    if (await env.APP_DB.prepare('SELECT customer_id FROM app_enrollments WHERE code_hash = ?').bind(codeHash).first()) continue;
    try {
      const result = await commit(codeHash);
      return { code: `${code.slice(0, 4)} ${code.slice(4)}`, result };
    } catch (error) {
      if (!codeCollision(error)) throw error;
    }
  }
  throw new AppError('ENROLLMENT_BUSY');
}
