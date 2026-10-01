import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { AppError, bodyJSON, fetchSafe, hash, json, randomToken, sameOrigin } from '../customer-app/http.mjs';
import { crmReady, forgetStatements } from './sync.mjs';
import { GROUPS, members, preview, validateDefinition } from './segments.mjs';

// Owner/manager CRM at /crm/, behind its own Cloudflare Access application. Every request is
// re-verified here (signature, issuer, audience, approved email). Customer names are fetched
// live from GrowFlow for display and never stored; list views, exports and removals are audited.
const DAY = 86400000;
const resolvers = new WeakMap();
function config(env) {
  const issuer = String(env.CRM_ACCESS_ISSUER || '').replace(/\/$/, '');
  const audience = String(env.CRM_ACCESS_AUD || '');
  const emails = String(env.CRM_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (env.CRM_ENABLED !== 'true' || !crmReady(env) || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)
    || !/^[a-f0-9]{64}$/.test(audience) || !emails.length || emails.some(v => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
    || typeof env.CRM_SECRET !== 'string' || env.CRM_SECRET.length < 32)
    throw new AppError('CRM_CONFIG');
  return { issuer, audience, emails };
}
async function authenticate(request, env, deps) {
  const { issuer, audience, emails } = config(env);
  const assertion = request.headers.get('cf-access-jwt-assertion');
  if (!assertion || assertion.length > 16384) throw new AppError('CRM_AUTH', 401);
  let cache = resolvers.get(deps.fetch);
  if (!cache) { cache = new Map(); resolvers.set(deps.fetch, cache); }
  let keys = cache.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      cacheMaxAge: 300000, cooldownDuration: 30000, timeoutDuration: 10000,
      [customFetch]: (url, init) => fetchSafe(deps, url, init)
    });
    if (cache.size >= 4) cache.clear();
    cache.set(issuer, keys);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(assertion, keys, {
      issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email', 'type'],
      currentDate: new Date(deps.now()), clockTolerance: 5, maxTokenAge: '8h'
    }));
  } catch { throw new AppError('CRM_AUTH', 401); }
  if (payload.type !== 'app' || typeof payload.email !== 'string' || !emails.includes(payload.email.toLowerCase()))
    throw new AppError('CRM_FORBIDDEN', 403);
  return { email: payload.email.toLowerCase(), csrf: await hash(env.CRM_SECRET, `crm-csrf:${assertion}`) };
}

async function limit(env, deps, key, max, windowMs = 60000) {
  const now = deps.now(), bucket = Math.floor(now / windowMs);
  const row = await env.CRM_DB.prepare(`INSERT INTO crm_limits(key, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`)
    .bind(await hash(env.CRM_SECRET, `${key}:${bucket}`), (bucket + 1) * windowMs).first();
  if (!row || row.hits > max) throw new AppError('CRM_LIMIT', 429);
}
async function audit(env, deps, actor, action, detail) {
  await env.CRM_DB.prepare('INSERT INTO crm_audit(id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(randomToken(), deps.now(), actor, action, detail ? JSON.stringify(detail).slice(0, 2000) : null).run();
}

// Live display names from GrowFlow (read-only CRM token). Nothing here is written anywhere.
const NAMES_QUERY = `query TreehouseCrmNames($ids: [ID!]) {
  findCustomers(where: { objectId: { in: $ids } }, first: 100) { edges { node { objectId Name } } }
}`;
async function names(env, deps, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const res = await fetchSafe(deps, `https://retail.growflow.com/c/${env.GROWFLOW_ORG}/graphql`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.CRM_GROWFLOW_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: NAMES_QUERY, variables: { ids: ids.slice(i, i + 100) } })
    }, 20000);
    if (!res.ok) throw new AppError(res.status === 429 ? 'CRM_RATE_LIMITED' : 'CRM_NAMES');
    const payload = await res.json();
    if (payload.errors?.length) throw new AppError('CRM_NAMES');
    for (const edge of payload.data?.findCustomers?.edges || [])
      if (typeof edge?.node?.objectId === 'string') out.set(edge.node.objectId, String(edge.node.Name || '').trim().slice(0, 120));
  }
  return out;
}

async function overview(env, now) {
  const db = env.CRM_DB, ago = d => now - d * DAY;
  const totals = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM crm_customers WHERE last_visit >= ?) AS active_30,
      (SELECT COUNT(*) FROM crm_customers WHERE last_visit >= ?) AS active_90,
      (SELECT COUNT(*) FROM crm_customers WHERE last_visit >= ?) AS active_365,
      (SELECT COUNT(*) FROM crm_customers WHERE last_visit < ? AND last_visit >= ?) AS lapsed_60_180,
      (SELECT COUNT(*) FROM crm_customers WHERE first_seen >= ? AND last_visit IS NOT NULL) AS new_30,
      (SELECT COUNT(*) FROM crm_customers WHERE birth_month = ? AND last_visit >= ?) AS birthdays_month,
      (SELECT COUNT(*) FROM crm_customers WHERE app_linked = 1) AS app_linked,
      (SELECT COUNT(*) FROM crm_customers WHERE app_push = 1) AS app_push,
      (SELECT COUNT(*) FROM crm_customers WHERE points >= 225 AND last_visit >= ?) AS can_redeem,
      (SELECT COUNT(*) FROM crm_orders WHERE completed_at >= ?) AS visits_30,
      (SELECT COALESCE(SUM(total_cents), 0) FROM crm_orders WHERE completed_at >= ?) AS revenue_30_cents,
      (SELECT COUNT(*) FROM crm_orders WHERE completed_at >= ? AND completed_at < ?) AS visits_prev_30,
      (SELECT COALESCE(SUM(total_cents), 0) FROM crm_orders WHERE completed_at >= ? AND completed_at < ?) AS revenue_prev_30_cents,
      (SELECT COUNT(*) FROM crm_orders WHERE completed_at >= ? AND is_preorder = 1) AS preorders_30`)
    .bind(ago(30), ago(90), ago(365), ago(60), ago(180), ago(30), new Date(now).getMonth() + 1, ago(365), ago(365),
      ago(30), ago(30), ago(60), ago(30), ago(60), ago(30), ago(30)).first();
  const { results: categories = [] } = await db.prepare(`SELECT category_group AS grp, SUM(net_cents) AS cents, COUNT(DISTINCT customer_id) AS customers
    FROM crm_lines WHERE sold_at >= ? AND returned = 0 GROUP BY category_group ORDER BY cents DESC`).bind(ago(90)).run();
  const { results: brands = [] } = await db.prepare(`SELECT l.brand_id AS id, COALESCE(b.name, 'Unknown') AS name, SUM(l.net_cents) AS cents,
    COUNT(DISTINCT l.customer_id) AS customers FROM crm_lines l LEFT JOIN crm_brands b ON b.id = l.brand_id
    WHERE l.sold_at >= ? AND l.returned = 0 AND l.brand_id IS NOT NULL GROUP BY l.brand_id ORDER BY cents DESC LIMIT 10`).bind(ago(90)).run();
  const { results: sync = [] } = await db.prepare('SELECT source, since, caught_up_at, updated_at FROM crm_sync_state').bind().run();
  return { totals, categories, brands, sync, now };
}

export async function handleCrm({ request, env }, overrides = {}) {
  const deps = { fetch: (url, init) => globalThis.fetch(url, init), now: Date.now,
    report: code => console.warn(`TREEHOUSE_CRM_FAILURE ${code}`), ...overrides };
  const url = new URL(request.url), route = url.pathname.replace(/^\/api\/crm\//, '').replace(/\/$/, '');
  const allowed = { session: 'GET', overview: 'GET', brands: 'GET', segments: 'GET', audit: 'GET',
    preview: 'POST', customers: 'POST', 'segments/save': 'POST', 'segments/delete': 'POST', forget: 'POST' };
  if (!allowed[route]) return json(404, { error: 'Not found.' });
  if (allowed[route] !== request.method) return json(405, { error: 'Method not allowed.' }, { Allow: allowed[route] });
  try {
    const user = await authenticate(request, env, deps);
    await limit(env, deps, `crm:${user.email}`, 120);
    if (request.method === 'POST' && (!sameOrigin(request) || request.headers.get('x-crm-csrf') !== user.csrf))
      throw new AppError('CRM_CSRF', 403);
    const now = deps.now(), db = env.CRM_DB;
    if (route === 'session') return json(200, { email: user.email, csrf: user.csrf, groups: GROUPS });
    if (route === 'overview') return json(200, await overview(env, now));
    if (route === 'brands') {
      const { results = [] } = await db.prepare(`SELECT b.id, b.name, SUM(l.net_cents) AS cents FROM crm_brands b
        JOIN crm_lines l ON l.brand_id = b.id AND l.sold_at >= ? AND l.returned = 0 GROUP BY b.id ORDER BY cents DESC LIMIT 100`)
        .bind(now - 365 * DAY).run();
      return json(200, { brands: results.map(({ id, name }) => ({ id, name })) });
    }
    if (route === 'segments') {
      const { results = [] } = await db.prepare('SELECT id, name, definition, created_by, updated_at FROM crm_segments ORDER BY name').bind().run();
      return json(200, { segments: results.map(s => ({ ...s, definition: JSON.parse(s.definition) })) });
    }
    if (route === 'audit') {
      const { results = [] } = await db.prepare('SELECT at, actor, action, detail FROM crm_audit ORDER BY at DESC LIMIT 100').bind().run();
      return json(200, { audit: results });
    }
    const input = await bodyJSON(request);
    if (route === 'preview') return json(200, await preview(db, validateDefinition(input.definition), now));
    if (route === 'customers') {
      const def = validateDefinition(input.definition), sort = ['spend', 'recent', 'visits', 'points'].includes(input.sort) ? input.sort : 'spend';
      await limit(env, deps, `crm-list:${user.email}`, 20);
      const rows = await members(db, def, now, sort, 200);
      const named = rows.length ? await names(env, deps, rows.map(r => r.id)) : new Map();
      await audit(env, deps, user.email, 'view_customers', { definition: def, sort, shown: rows.length });
      return json(200, { customers: rows.map(r => ({ ...r, name: named.get(r.id) || null })) });
    }
    if (route === 'segments/save') {
      const def = validateDefinition(input.definition);
      const name = typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80) : '';
      if (!name) throw new AppError('SEGMENT_NAME', 400);
      const segmentId = typeof input.id === 'string' && /^[a-f0-9]{64}$/.test(input.id) ? input.id : randomToken();
      await db.prepare(`INSERT INTO crm_segments(id, name, definition, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at`)
        .bind(segmentId, name, JSON.stringify(def), user.email, now, now).run();
      await audit(env, deps, user.email, 'save_segment', { name });
      return json(200, { id: segmentId });
    }
    if (route === 'segments/delete') {
      if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw new AppError('INPUT', 400);
      await db.prepare('DELETE FROM crm_segments WHERE id = ?').bind(input.id).run();
      await audit(env, deps, user.email, 'delete_segment', null);
      return json(200, { deleted: true });
    }
    if (route === 'forget') {
      // A customer's request to be removed. Their GrowFlow record is untouched.
      if (typeof input.customerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.customerId)) throw new AppError('INPUT', 400);
      await db.batch(forgetStatements(db, input.customerId));
      await audit(env, deps, user.email, 'forget_customer', null);
      return json(200, { forgotten: true });
    }
  } catch (error) {
    // Unexpected errors are logged as a fixed category, never their text.
    const text = String(error?.message || ''), known = error instanceof AppError;
    const code = known ? error.code : /overloaded|too many|busy|locked/i.test(text) ? 'CRM_DB_BUSY'
      : /timeout|timed out/i.test(text) ? 'CRM_DB_TIMEOUT' : /D1_|SQLITE|no such|constraint/i.test(text) ? 'CRM_DB_ERROR' : 'INTERNAL';
    // Database messages describe SQL, not rows; numbers are masked anyway.
    const detail = code.startsWith('CRM_DB_') ? ` ${text.replace(/\d+/g, '#').slice(0, 200)}` : '';
    try { deps.report(code + detail); } catch { /* Logging never breaks a response. */ }
    const messages = { CRM_AUTH: 'Please sign in again.', CRM_FORBIDDEN: 'This account is not approved for the CRM.',
      CRM_CONFIG: 'The CRM is not set up yet.', CRM_LIMIT: 'Too many requests. Please wait a minute.',
      CRM_CSRF: 'Please reload the page and try again.', SEGMENT_RULES: 'Please check the segment rules.',
      SEGMENT_NAME: 'Please give the segment a name.', CRM_RATE_LIMITED: 'GrowFlow is busy. Please try again in a minute.',
      INPUT: 'Please check the information and try again.',
      CRM_DB_BUSY: 'The CRM is busy loading history from GrowFlow. Please try again in a moment.',
      CRM_DB_TIMEOUT: 'That took too long while history is loading. Please try again in a moment.' };
    return json(known ? error.status : 503, { error: messages[code] || 'The CRM is temporarily unavailable.' });
  }
}
