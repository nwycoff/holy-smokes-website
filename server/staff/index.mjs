import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { consumeLimits, lookupVariables, normalizeInput } from '../rewards.mjs';
import { AppError, bodyJSON, enabled, fetchSafe, growflowReady, hash, json, randomToken, sameOrigin } from '../customer-app/http.mjs';
import { staffGuideResponse } from './guide.mjs';
import { withEnrollmentCode } from '../customer-app/enrollment.mjs';
import { queryGrowflow, singleCustomer } from '../customer-app/growflow.mjs';

// Match only one known customer. No patient IDs or balances are requested as output.
const MATCH_QUERY = `query TreehouseStaffMatch($where: CustomersWhereInput!) {
  findCustomers(where: $where, first: 2) {
    pageInfo { hasNextPage } edges { node { objectId Name } }
  }
}`;
const productionFetch = (url, init) => globalThis.fetch(url, init);
const resolvers = new WeakMap();
function config(env) {
  const issuer = String(env.APP_STAFF_ACCESS_ISSUER || '').replace(/\/$/, '');
  const audience = String(env.APP_STAFF_ACCESS_AUD || '');
  const emails = String(env.APP_STAFF_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (env.APP_STAFF_ENABLED !== 'true' || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)
    || !/^[a-f0-9]{64}$/.test(audience) || !emails.length || emails.some(v => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)))
    throw new AppError('STAFF_CONFIG');
  return { issuer, audience, emails };
}
async function authenticate(request, env, deps) {
  const { issuer, audience, emails } = config(env);
  const assertion = request.headers.get('cf-access-jwt-assertion');
  if (!assertion || assertion.length > 16384) throw new AppError('STAFF_AUTH', 401);
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
  } catch { throw new AppError('STAFF_AUTH', 401); }
  if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256
    || typeof payload.email !== 'string' || !emails.includes(payload.email.toLowerCase()))
    throw new AppError('STAFF_FORBIDDEN', 403);
  return {
    email: payload.email.toLowerCase(),
    id: await hash(env.APP_LIMIT_SECRET, `staff:${issuer}:${payload.sub}`),
    csrf: await hash(env.APP_LIMIT_SECRET, `staff-csrf:${assertion}`)
  };
}
async function limited(env, deps, rules) {
  if (!await consumeLimits(env.APP_DB, env.APP_LIMIT_SECRET, rules, deps.now())) throw new AppError('STAFF_LIMIT', 429);
}
export async function handleStaff({ request, env }, overrides = {}) {
  const deps = { fetch: productionFetch, now: Date.now,
    report: code => console.warn(`TREEHOUSE_STAFF_FAILURE ${code}`), ...overrides };
  const url = new URL(request.url), route = url.pathname.replace(/^\/api\/staff\//, '').replace(/\/$/, '');
  const methods = { guide: 'GET', session: 'GET', match: 'POST', issue: 'POST' };
  if (!Object.hasOwn(methods, route)) return json(404, { error: 'Not found.' });
  if (methods[route] !== request.method) return json(405, { error: 'Method not allowed.' }, { Allow: methods[route] });
  if (url.search) return json(400, { error: 'Invalid request.' });
  try {
    if (!enabled(env, url)) throw new AppError('STAFF_CONFIG');
    if (['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))
      || (request.method === 'POST' && !sameOrigin(request))) throw new AppError('STAFF_ORIGIN', 403);
    const ip = request.headers.get('cf-connecting-ip');
    if (!ip) throw new AppError('STAFF_CONFIG');
    await limited(env, deps, [{ subject: `staff-page-ip:${ip}`, max: 60, window: 60000 }]);
    const staff = await authenticate(request, env, deps);
    if (route === 'guide') return staffGuideResponse();
    if (route === 'session') return json(200, { email: staff.email, csrf: staff.csrf, appUrl: `${url.origin}/app/` });
    if (request.headers.get('x-treehouse-csrf') !== staff.csrf) throw new AppError('STAFF_CSRF', 403);
    await limited(env, deps, [{ subject: `staff-page-user:${staff.id}`, max: 30, window: 900000 }]);
    const input = await bodyJSON(request), now = deps.now();
    // Short-lived matches contain only internal record IDs; audit has a bounded retention.
    await env.APP_DB.batch([
      env.APP_DB.prepare('DELETE FROM app_staff_matches WHERE expires_at <= ?').bind(now),
      env.APP_DB.prepare('DELETE FROM app_staff_audit WHERE created_at < ?').bind(now - 180 * 86400000)
    ]);
    if (route === 'match') {
      if (Object.keys(input).some(k => !['name', 'lastFive'].includes(k))) throw new AppError('INPUT', 400);
      const normalized = normalizeInput({ ...input, turnstileToken: 'staff-verified' });
      if (!normalized) throw new AppError('INPUT', 400);
      if (!growflowReady(env)) throw new AppError('GROWFLOW_CONFIG');
      const customer = singleCustomer(await queryGrowflow(env, deps, MATCH_QUERY,
        lookupVariables(normalized, env.GROWFLOW_PATIENT_ID_FIELDS)));
      if (!customer || typeof customer.Name !== 'string' || !customer.Name.trim()) throw new AppError('NO_MATCH', 400);
      const linked = await env.APP_DB.prepare('SELECT id FROM app_users WHERE customer_id = ?').bind(customer.objectId).first();
      if (linked) throw new AppError('ALREADY_LINKED', 409);
      const ticket = randomToken(), expiresAt = now + 120000;
      await env.APP_DB.prepare(`INSERT INTO app_staff_matches(ticket_hash, staff_id, customer_id, expires_at) VALUES (?, ?, ?, ?)`)
        .bind(await hash(env.APP_LIMIT_SECRET, `staff-match:${ticket}`), staff.id, customer.objectId, expiresAt).run();
      return json(200, { ticket, name: customer.Name.trim().slice(0, 200), expiresAt });
    }
    if (Object.keys(input).some(k => !['ticket', 'identityChecked'].includes(k)) || input.identityChecked !== true
      || typeof input.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(input.ticket)) throw new AppError('INPUT', 400);
    const ticketHash = await hash(env.APP_LIMIT_SECRET, `staff-match:${input.ticket}`);
    const expiresAt = now + 600000;
    // Issuance, audit and ticket consumption commit together. Never return an unaudited code.
    const { code, result } = await withEnrollmentCode(env, codeHash => env.APP_DB.batch([
      env.APP_DB.prepare(`INSERT INTO app_enrollments(code_hash, customer_id, expires_at)
        SELECT ?, customer_id, ? FROM app_staff_matches
        WHERE ticket_hash = ? AND staff_id = ? AND expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM app_users WHERE app_users.customer_id = app_staff_matches.customer_id)
        ON CONFLICT(customer_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at
        RETURNING code_hash`).bind(codeHash, expiresAt, ticketHash, staff.id, now),
      env.APP_DB.prepare(`INSERT INTO app_staff_audit(id, staff_id, staff_email, customer_id, event, created_at)
        SELECT ?, ?, ?, e.customer_id, 'code_issued', ? FROM app_enrollments e
        JOIN app_staff_matches m ON m.customer_id = e.customer_id
        WHERE e.code_hash = ? AND m.ticket_hash = ? AND m.staff_id = ? AND m.expires_at > ?`)
        .bind(randomToken(), staff.id, staff.email, now, codeHash, ticketHash, staff.id, now),
      env.APP_DB.prepare('DELETE FROM app_staff_matches WHERE ticket_hash = ? AND staff_id = ?').bind(ticketHash, staff.id)
    ]));
    if (result[0]?.results?.length !== 1) throw new AppError('MATCH_EXPIRED', 409);
    return json(200, { code, expiresAt, appUrl: `${url.origin}/app/` });
  } catch (error) {
    const known = error instanceof AppError, code = known ? error.code : 'INTERNAL';
    try { deps.report(code); } catch { /* Diagnostics never include identity or credentials. */ }
    const messages = {
      STAFF_CONFIG: 'Staff enrollment is not configured yet. Ask the owner to complete setup.',
      STAFF_AUTH: 'Your staff sign-in is missing or expired. Sign in again.',
      STAFF_FORBIDDEN: 'This sign-in does not have staff access. Ask the owner to check your permission.',
      STAFF_CSRF: 'Your staff session changed. Reload this page and try again.',
      STAFF_ORIGIN: 'Reopen the staff page and try again.',
      STAFF_LIMIT: 'Too many attempts. Wait a few minutes before trying again.',
      INPUT: 'Check the name, patient ID ending, and identity confirmation.',
      NO_MATCH: 'No unique eligible customer matched. Check the record in GrowFlow.',
      ALREADY_LINKED: 'This customer is already connected. Help them reset their password instead.',
      MATCH_EXPIRED: 'This match expired, was already used, or the customer is now linked. Find the customer again.'
    };
    return json(known ? error.status : 503, { error: messages[code] || 'Unable to complete this request. Try again later or ask the owner.' },
      known && error.status === 429 ? { 'Retry-After': '900' } : {});
  }
}
