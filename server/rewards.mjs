// Read-only points lookup. Never add GraphQL mutations or raw response logging.
const QUERY = `query TreehousePoints($where: CustomersWhereInput!) {
  findCustomers(where: $where, first: 2) {
    pageInfo { hasNextPage }
    edges { node { CurrentPoints } }
  }
}`;
const ID_FIELDS = new Set([
  'PatientLicenseNumber', 'MedicalLicenseNumber', 'CustomerStateLicense'
]);
const UNAVAILABLE = 'Points lookup is temporarily unavailable. Please ask your budtender.';
const NO_MATCH = 'We could not verify those details. Please check them or ask your budtender.';
const LIMITED = 'Please wait before trying again, or ask your budtender for your balance.';
function idFields(specification) {
  if (typeof specification !== 'string') return null;
  const fields = specification.split(',').map(field => field.trim());
  if (!fields.length || fields.length > ID_FIELDS.size || fields.some(field => !ID_FIELDS.has(field))
    || new Set(fields).size !== fields.length) return null;
  return fields;
}
const fieldSetting = env => env.GROWFLOW_PATIENT_ID_FIELDS ?? env.GROWFLOW_PATIENT_ID_FIELD;
const validToken = token => typeof token === 'string' && token.startsWith('gfr_')
  && token.length > 4 && token.length <= 4096 && !/[\s\u0000-\u001f\u007f]/u.test(token);

const response = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Vary': 'Origin',
    ...extra
  }
});

export function configuration(env, url) {
  const hosts = String(env.REWARDS_ALLOWED_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean);
  return env.REWARDS_ENABLED === 'true'
    && url.protocol === 'https:' && hosts.includes(url.hostname)
    && /^[a-z0-9-]+$/.test(env.GROWFLOW_ORG || '')
    && Boolean(idFields(fieldSetting(env)))
    && validToken(env.GROWFLOW_API_TOKEN)
    && Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY
      && env.REWARDS_RATE_SECRET?.length >= 32 && env.REWARDS_DB);
}

export function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (Object.keys(input).some(key => !['name', 'lastFive', 'turnstileToken'].includes(key))) return null;
  if (typeof input.name !== 'string' || typeof input.lastFive !== 'string'
    || typeof input.turnstileToken !== 'string') return null;
  // Reject controls before whitespace normalization. Preserve punctuation/diacritics.
  if (/[\u0000-\u001f\u007f]/u.test(input.name)) return null;
  const name = input.name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (name.length < 3 || name.length > 120 || !/^[A-Za-z0-9]{3}-?[A-Za-z0-9]{2}$/.test(input.lastFive)
    || input.turnstileToken.length < 1 || input.turnstileToken.length > 2048) return null;
  return { name, lastFive: input.lastFive.replace('-', '').toUpperCase(), turnstileToken: input.turnstileToken };
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function lookupVariables(input, specification) {
  const fields = idFields(specification);
  if (!fields) throw new Error('Invalid patient ID fields');
  const suffix = { matchesRegex: `${input.lastFive.slice(0, 3)}-?${input.lastFive.slice(3)}$`, options: 'i' };
  const filter = fields.length === 1 ? { [fields[0]]: suffix }
    : { OR: fields.map(field => ({ [field]: { ...suffix } })) };
  return { where: {
    Name: { matchesRegex: `^${escapeRegex(input.name)}$`, options: 'i' },
    ...filter,
    IsDeleted: { notEqualTo: true },
    IsAnon: { notEqualTo: true },
    Disabled: { notEqualTo: true },
    Active: { notEqualTo: false }
  } };
}

async function digest(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}

export async function consumeLimits(db, secret, specs, now) {
  const statements = [];
  for (const spec of specs) {
    const bucket = Math.floor(now / spec.window);
    const key = await digest(secret, `${spec.subject}:${spec.window}:${bucket}`);
    statements.push(db.prepare(`INSERT INTO rewards_limits (key, hits, expires_at)
      VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`)
      .bind(key, (bucket + 1) * spec.window));
  }
  // D1 batch executes transactionally; concurrent requests cannot bypass counters.
  const results = await db.batch(statements);
  if (results.length !== specs.length || results.some(r => !r.success
    || !Number.isInteger(r.results?.[0]?.hits))) throw new Error('Rate limit unavailable');
  return results.every((r, i) => r.results[0].hits <= specs[i].max);
}

async function rememberBackoff(db, key, until) {
  await db.prepare(`INSERT INTO rewards_backoff (key, until_at) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET until_at = MAX(until_at, excluded.until_at)`)
    .bind(key, until).run();
}

async function upstream(url, options, deps) {
  return deps.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
}

async function limitedJSON(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  if (Number(request.headers.get('content-length')) > 4096 || !request.body) return null;
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

export async function handleRewards(context, overrides = {}) {
  const { request, env } = context;
  const deps = { fetch: globalThis.fetch, now: Date.now, ...overrides };
  const url = new URL(request.url);
  if (url.search) return response(400, { error: NO_MATCH });
  const route = url.pathname.replace(/\/$/, '');
  if (!['/api/rewards/config', '/api/rewards/points'].includes(route))
    return response(404, { error: 'Not found.' });
  if (route.endsWith('/config')) {
    if (request.method !== 'GET') return response(405, { error: 'Method not allowed.' });
    const enabled = configuration(env, url);
    return response(200, { enabled, ...(enabled ? { siteKey: env.TURNSTILE_SITE_KEY } : {}) });
  }
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' });
  if (!configuration(env, url)) return response(503, { error: UNAVAILABLE });
  if (request.headers.get('origin') !== url.origin
    || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site')))
    return response(403, { error: NO_MATCH });
  // Only trust the edge's IP header, never a client-supplied X-Forwarded-For.
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return response(503, { error: UNAVAILABLE });

  const started = deps.now();
  let backoffKey;
  try {
    const now = deps.now();
    const allowedIP = await consumeLimits(env.REWARDS_DB, env.REWARDS_RATE_SECRET,
      [{ subject: `ip:${ip}`, window: 900000, max: 10 },
       { subject: 'all-attempts', window: 60000, max: 60 }], now);
    if (!allowedIP) return response(429, { error: LIMITED }, { 'Retry-After': '900' });
    const input = normalizeInput(await limitedJSON(request));
    if (!input) return response(400, { error: NO_MATCH });

    const challenge = await upstream('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY,
        response: input.turnstileToken, remoteip: ip })
    }, deps);
    const verdict = challenge.ok ? await challenge.json() : {};
    if (!verdict.success || verdict.hostname !== url.hostname || verdict.action !== 'points-lookup')
      return response(400, { error: NO_MATCH });

    const allowed = await consumeLimits(env.REWARDS_DB, env.REWARDS_RATE_SECRET,
      [{ subject: `name:${input.name.toLowerCase()}`, window: 900000, max: 5 },
       { subject: `name:${input.name.toLowerCase()}`, window: 86400000, max: 20 },
       { subject: 'growflow-queries', window: 60000, max: 15 }], now);
    if (!allowed) return response(429, { error: LIMITED }, { 'Retry-After': '900' });

    backoffKey = await digest(env.REWARDS_RATE_SECRET, `upstream:${env.GROWFLOW_ORG}`);
    const backoff = await env.REWARDS_DB.prepare('SELECT until_at FROM rewards_backoff WHERE key = ?')
      .bind(backoffKey).first();
    if (backoff?.until_at > now) return response(503, { error: UNAVAILABLE });
    const result = await upstream(`https://retail.growflow.com/c/${env.GROWFLOW_ORG}/graphql`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.GROWFLOW_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: lookupVariables(input, fieldSetting(env)) })
    }, deps);
    const reset = Number(result.headers.get('ratelimit-reset'));
    const remaining = result.headers.has('ratelimit-remaining')
      ? Number(result.headers.get('ratelimit-remaining')) : NaN;
    if (result.status === 429 || (Number.isFinite(remaining) && remaining <= 20)) {
      const retry = result.headers.get('retry-after');
      const retryDelay = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - now;
      const delay = Math.max(60000, Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0,
        Number.isFinite(retryDelay) && retryDelay > 0 ? retryDelay : 0);
      await rememberBackoff(env.REWARDS_DB, backoffKey, now + delay);
    }
    if (!result.ok) throw new Error('Points unavailable');
    const data = await result.json();
    if (data.errors?.length || !data.data?.findCustomers) throw new Error('Points unavailable');
    const { edges, pageInfo } = data.data.findCustomers;
    if (!Array.isArray(edges) || typeof pageInfo?.hasNextPage !== 'boolean') throw new Error('Points unavailable');
    // Do not filter null edges: an incomplete/ambiguous match must never become a unique match.
    if (edges.length !== 1 || pageInfo.hasNextPage) return response(400, { error: NO_MATCH });
    const points = edges[0]?.node?.CurrentPoints;
    if (typeof points !== 'number' || !Number.isFinite(points)) throw new Error('Points unavailable');
    return response(200, { points });
  } catch {
    // No upstream text, names, patient IDs, tokens, or request bodies in errors/logs.
    if (backoffKey) {
      try { await rememberBackoff(env.REWARDS_DB, backoffKey, deps.now() + 60000); } catch { /* fail closed */ }
    }
    return response(503, { error: UNAVAILABLE });
  } finally {
    // Expiring keyed hashes only; bounded cleanup keeps old counters out of storage.
    const cleanup = env.REWARDS_DB.prepare(`DELETE FROM rewards_limits WHERE key IN
      (SELECT key FROM rewards_limits WHERE expires_at < ? LIMIT 500)`)
      .bind(started).run().catch(() => {});
    context.waitUntil?.(cleanup);
  }
}
