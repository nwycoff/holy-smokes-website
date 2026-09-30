import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { handleStaff } from '../server/staff/index.mjs';
import { handleApp } from '../server/customer-app/index.mjs';
import { hash } from '../server/customer-app/http.mjs';

class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:'); this.db.exec('PRAGMA foreign_keys=ON');
    // Every migration in order, so this matches a real APP_DB.
    for (const file of readdirSync(new URL('../app-migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
      this.db.exec(readFileSync(new URL(`../app-migrations/${file}`, import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const db = this.db;
    return { bind(...v) { return {
      async first() { return db.prepare(sql).get(...v) || null; },
      async run() { const stmt = db.prepare(sql); return { success: true,
        results: stmt.columns().length ? stmt.all(...v) : (stmt.run(...v), []) }; }
    }; } };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const r = []; for (const s of statements) r.push(await s.run()); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
const keys = await generateKeyPair('RS256'), jwk = { ...await exportJWK(keys.publicKey), kid: 'staff-test', alg: 'RS256' };
const origin = 'https://staff.example.test', aud = 'a'.repeat(64), issuer = 'https://synthetic.cloudflareaccess.com';
async function setup() {
  let now = Date.now(), data = { findCustomers: { pageInfo: { hasNextPage: false },
    edges: [{ node: { objectId: 'CustomerOne', Name: 'Synthetic Customer' } }] } };
  const calls = [], logs = [];
  const env = { APP_ENABLED: 'true', APP_ALLOWED_HOSTS: 'staff.example.test', APP_DB: new D1(),
    APP_LIMIT_SECRET: 'synthetic-secret-at-least-thirty-two-characters',
    APP_STAFF_ENABLED: 'true', APP_STAFF_ACCESS_ISSUER: issuer, APP_STAFF_ACCESS_AUD: aud,
    APP_STAFF_EMAILS: 'staff@example.test,other@example.test',
    APP_GROWFLOW_TOKEN: 'gfr_synthetic', GROWFLOW_ORG: 'integrations', GROWFLOW_PATIENT_ID_FIELDS: 'PatientLicenseNumber' };
  const deps = { now: () => now, report: c => logs.push(c), fetch: async (url, init) => {
    calls.push({ url: String(url), init }); assert.equal(init.redirect, 'manual');
    if (String(url).endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    assert.equal(String(url), 'https://retail.growflow.com/c/integrations/graphql');
    return Response.json({ data });
  } };
  const token = async (claims = {}, key = keys.privateKey, alg = 'RS256') => new SignJWT({
    iss: issuer, aud: [aud], sub: 'staff-one', email: 'staff@example.test', type: 'app',
    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, ...claims
  }).setProtectedHeader({ alg, kid: 'staff-test' }).sign(key);
  const jwt = await token();
  async function run(route, { method = route === 'session' ? 'GET' : 'POST', body, assertion = jwt, headers = {}, url = origin } = {}) {
    const csrf = await hash(env.APP_LIMIT_SECRET, `staff-csrf:${assertion}`);
    return handleStaff({ env, request: new Request(`${url}/api/staff/${route}`, { method,
      headers: { 'cf-connecting-ip': '192.0.2.3', 'cf-access-jwt-assertion': assertion,
        origin: url, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-treehouse-csrf': csrf, ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}) }) }, deps);
  }
  const match = async (options = {}) => {
    const response = await run('match', { body: { name: 'Synthetic Customer', lastFive: 'ABC-12' }, ...options });
    return { response, ...(await response.json()) };
  };
  return { env, deps, calls, logs, jwt, token, run, match, advance: t => { now += t; }, setData: d => { data = d; } };
}
const count = (s, table) => s.env.APP_DB.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

test('staff page requires enablement, approved host, verified Access JWT and an allowed individual', async () => {
  const s = await setup();
  assert.equal((await s.run('session')).status, 200);
  assert.equal(s.calls.length, 1); await s.run('session'); assert.equal(s.calls.length, 1);
  s.env.APP_STAFF_ENABLED = 'false'; assert.equal((await s.run('session')).status, 503); s.env.APP_STAFF_ENABLED = 'true';
  assert.equal((await s.run('session', { url: 'https://unapproved.example.test' })).status, 503);
  assert.equal((await s.run('session', { assertion: '' })).status, 401);
  assert.equal((await s.run('session', { assertion: 'forged', headers: { 'cf-access-authenticated-user-email': 'staff@example.test' } })).status, 401);
  const other = await s.token({ email: 'customer@example.test' });
  assert.equal((await s.run('session', { assertion: other })).status, 403);
  s.env.APP_STAFF_EMAILS = 'other@example.test'; assert.equal((await s.run('session')).status, 403);
  assert.equal(count(s, 'app_enrollments'), 0);
});
test('staff authentication rejects bad signatures, issuer, audience, expiry, type, future and service identities', async () => {
  const s = await setup(), wrong = await generateKeyPair('RS256');
  for (const claims of [{ iss: 'https://evil.cloudflareaccess.com' }, { aud: ['b'.repeat(64)] },
    { exp: 1 }, { iat: Math.floor(Date.now() / 1000) + 3600 }, { email: '' }, { type: 'service' }, { sub: '' }]) {
    assert.ok([401, 403].includes((await s.run('session', { assertion: await s.token(claims) })).status));
  }
  assert.equal((await s.run('session', { assertion: await s.token({}, wrong.privateKey) })).status, 401);
  assert.equal(s.calls.filter(c => c.url.includes('growflow')).length, 0);
});
test('staff writes reject cross-site requests, missing origin, bad CSRF and injected customer IDs', async () => {
  const s = await setup();
  for (const headers of [{ origin: 'https://evil.test' }, { origin: '' }, { 'sec-fetch-site': 'same-site' }, { 'x-treehouse-csrf': '' }])
    assert.equal((await s.run('match', { body: { name: 'Synthetic Customer', lastFive: 'ABC12' }, headers })).status, 403);
  assert.equal((await s.run('match', { body: { name: 'Synthetic Customer', lastFive: 'ABC12', customerId: 'Other' } })).status, 400);
  assert.equal((await s.run('issue', { body: { customerId: 'Other', identityChecked: true } })).status, 400);
  assert.equal(s.calls.filter(c => c.url.includes('growflow')).length, 0);
});
test('unique match returns only name and opaque staff-bound ticket; no match, ambiguity and linked accounts cannot issue', async () => {
  const s = await setup(), m = await s.match(); assert.equal(m.response.status, 200);
  assert.equal(m.name, 'Synthetic Customer'); assert.equal(m.ticket.length, 64);
  assert.ok(!JSON.stringify(m).includes('CustomerOne'));
  assert.match(m.response.headers.get('cache-control'), /no-store/);
  const query = JSON.parse(s.calls.find(c => c.url.includes('growflow')).init.body);
  assert.match(query.query, /objectId Name/); assert.ok(!query.query.includes('CurrentPoints'));
  assert.equal(query.variables.where.PatientLicenseNumber.matchesRegex, 'ABC-?12$');
  for (const edges of [[], [{ node: { objectId: 'A', Name: 'A' } }, { node: { objectId: 'B', Name: 'B' } }]]) {
    s.setData({ findCustomers: { pageInfo: { hasNextPage: false }, edges } }); assert.equal((await s.match()).response.status, 400);
  }
  s.setData({ findCustomers: { pageInfo: { hasNextPage: true }, edges: [{ node: { objectId: 'A', Name: 'A' } }] } });
  assert.equal((await s.match()).response.status, 400);
  s.setData({ findCustomers: { pageInfo: { hasNextPage: false }, edges: [{ node: { objectId: 'CustomerOne', Name: 'Synthetic Customer' } }] } });
  s.env.APP_DB.db.prepare('INSERT INTO app_users (id, identity_hash, customer_id, created_at) VALUES (?,?,?,?)').run('user', 'identity', 'CustomerOne', Date.now());
  assert.equal((await s.match()).response.status, 409);
  assert.equal(count(s, 'app_enrollments'), 0);
});
test('issuing requires fresh match owned by same staff and explicit identity check, with replay protection', async () => {
  const s = await setup(), m = await s.match();
  assert.equal((await s.run('issue', { body: { ticket: m.ticket, identityChecked: false } })).status, 400);
  const another = await s.token({ sub: 'staff-two', email: 'other@example.test' });
  assert.equal((await s.run('issue', { assertion: another, body: { ticket: m.ticket, identityChecked: true } })).status, 409);
  const issued = await s.run('issue', { body: { ticket: m.ticket, identityChecked: true } }); assert.equal(issued.status, 200);
  const code = await issued.json(); assert.match(code.code, /^[A-F0-9]{4}(-[A-F0-9]{4}){4}$/);
  assert.equal(code.expiresAt - s.deps.now(), 600000);
  const audit = s.env.APP_DB.db.prepare('SELECT * FROM app_staff_audit').get();
  assert.equal(audit.staff_email, 'staff@example.test'); assert.equal(audit.customer_id, 'CustomerOne');
  assert.equal(audit.event, 'code_issued'); assert.ok(!JSON.stringify(audit).includes(code.code));
  const enrollment = s.env.APP_DB.db.prepare('SELECT * FROM app_enrollments').get();
  assert.equal(enrollment.code_hash, await hash(s.env.APP_LIMIT_SECRET, `enroll:${code.code.replaceAll('-', '')}`));
  assert.equal((await s.run('issue', { body: { ticket: m.ticket, identityChecked: true } })).status, 409);
  assert.equal(count(s, 'app_staff_audit'), 1);
  const expired = await s.match(); s.advance(120001);
  assert.equal((await s.run('issue', { body: { ticket: expired.ticket, identityChecked: true } })).status, 409);
});
test('reissuing replaces old code; linked-after-match and failed audit never issue a code', async () => {
  const s = await setup();
  const first = await s.match(); await s.run('issue', { body: { ticket: first.ticket, identityChecked: true } });
  const old = s.env.APP_DB.db.prepare('SELECT code_hash FROM app_enrollments').get().code_hash;
  const next = await s.match(); await s.run('issue', { body: { ticket: next.ticket, identityChecked: true } });
  assert.equal(count(s, 'app_enrollments'), 1); assert.equal(count(s, 'app_staff_audit'), 2);
  assert.notEqual(s.env.APP_DB.db.prepare('SELECT code_hash FROM app_enrollments').get().code_hash, old);
  const last = await s.match(); s.env.APP_DB.db.prepare('INSERT INTO app_users (id, identity_hash, customer_id, created_at) VALUES (?,?,?,?)').run('user', 'identity', 'CustomerOne', Date.now());
  assert.equal((await s.run('issue', { body: { ticket: last.ticket, identityChecked: true } })).status, 409);
  const a = await setup(), m = await a.match();
  a.env.APP_DB.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON app_staff_audit BEGIN SELECT RAISE(ABORT, 'failure'); END");
  assert.equal((await a.run('issue', { body: { ticket: m.ticket, identityChecked: true } })).status, 503);
  assert.equal(count(a, 'app_enrollments'), 0); assert.equal(count(a, 'app_staff_matches'), 1);
});
test('staff-created code works once with the existing customer account connection endpoint', async () => {
  const s = await setup(), m = await s.match();
  const code = (await (await s.run('issue', { body: { ticket: m.ticket, identityChecked: true } })).json()).code;
  const raw = 'b'.repeat(64), sessionHash = await hash(s.env.APP_LIMIT_SECRET, `session:${raw}`);
  s.env.APP_DB.db.prepare('INSERT INTO app_users (id, identity_hash, customer_id, created_at) VALUES (?,?,NULL,?)').run('account-one', 'synthetic-identity', s.deps.now());
  s.env.APP_DB.db.prepare('INSERT INTO app_sessions VALUES (?,?,?,?)').run(sessionHash, 'account-one', s.deps.now(), s.deps.now() + 600000);
  const request = () => new Request(`${origin}/api/app/enroll`, { method: 'POST', headers: {
    origin, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '192.0.2.3', 'content-type': 'application/json',
    cookie: `__Host-treehouse_session=${raw}`, 'x-treehouse-csrf': ''
  }, body: JSON.stringify({ code }) });
  async function claim() { const req = request(); req.headers.set('x-treehouse-csrf', await hash(s.env.APP_LIMIT_SECRET, `csrf:${raw}`)); return handleApp({ request: req, env: s.env }, s.deps); }
  assert.equal((await claim()).status, 200);
  assert.equal(s.env.APP_DB.db.prepare('SELECT customer_id FROM app_users').get().customer_id, 'CustomerOne');
  assert.equal((await claim()).status, 400); assert.equal(count(s, 'app_enrollments'), 0);
});
test('rate limits, schema failures and redirects fail closed without exposing submitted data', async () => {
  const s = await setup(); s.setData(null);
  const response = await s.match(); assert.equal(response.response.status, 503);
  assert.ok(!JSON.stringify(response).includes('Synthetic Customer')); assert.ok(!JSON.stringify(s.logs).includes('ABC'));
  for (let i = 0; i < 30; i++) await s.run('issue');
  assert.equal((await s.run('issue')).status, 429);
  const r = await setup(); r.deps.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
  assert.equal((await r.run('session')).status, 401); assert.equal(count(r, 'app_enrollments'), 0);
});
