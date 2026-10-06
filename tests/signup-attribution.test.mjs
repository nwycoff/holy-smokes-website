import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { visit, startAcquisition, acquisitionForLogin, verifiedAcquisition, linkedAcquisition, reachableAcquisition, VISIT_COOKIE } from '../server/customer-app/acquisition.mjs';
import { signupReport, saveSignupSpend, validateSignupSpend } from '../server/crm/acquisition.mjs';
import { onRequest as qrRedirect } from '../functions/go/[source].js';
import { hash } from '../server/customer-app/http.mjs';
const DAY = 86400000, now = Date.UTC(2026, 9, 6, 16);
class D1 {
  constructor(dir) {
    this.db = new DatabaseSync(':memory:'); this.db.exec('PRAGMA foreign_keys = ON');
    for (const file of readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(f => f.endsWith('.sql')).sort())
      this.db.exec(readFileSync(new URL(`../${dir}/${file}`, import.meta.url), 'utf8'));
  }
  prepare(sql) { const db = this.db; return { bind(...v) { return {
    async first() { return db.prepare(sql).get(...v) || null; },
    async run() { const s = db.prepare(sql); return { results: s.columns().length ? s.all(...v) : (s.run(...v), []), success: true }; }
  }; } }; }
  async batch(stmts) { this.db.exec('BEGIN'); try { const r = []; for (const s of stmts) r.push(await s.run()); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; } }
}
const setup = () => ({ APP_DB: new D1('app-migrations'), CRM_DB: new D1('crm-migrations'),
  APP_SIGNUP_TRACKING_ENABLED: 'true', APP_LIMIT_SECRET: 'test-only-attribution-secret-over-32-characters' });
const req = cookie => new Request('https://www.example.test/api/app/signup/visit', { headers: { cookie: cookie || '' } });
const deps = { now: () => now, report: () => {} };
const addUser = (env, id, customer = null) => env.APP_DB.db.prepare('INSERT INTO app_users(id, identity_hash, customer_id, created_at) VALUES (?, ?, ?, ?)').run(id, id, customer, now);

test('QR redirects are fixed, do not set credentials, and reject unknown sources and writes', () => {
  const response = qrRedirect({ request: new Request('https://www.example.test/go/register-1?next=https://evil.test'), params: { source: 'register-1' } });
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/app/?from=register-1#setup');
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const source of ['direct', '__proto__', 'https://evil.test']) assert.equal(qrRedirect({ request: req(), params: { source } }).status, 404);
  assert.equal(qrRedirect({ request: new Request('https://example.test', { method: 'POST' }), params: { source: 'register-1' } }).status, 405);
});
test('first-party visits deduplicate, keep first source, expire, and honor privacy signals', async () => {
  const env = setup(), response = await visit(req(), env, deps, { source: 'bag-card-v1' });
  const cookie = response.headers.get('set-cookie').split(';')[0]; assert.ok(cookie.startsWith(VISIT_COOKIE));
  assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  await visit(req(cookie), env, deps, { source: 'register-1' });
  assert.equal(env.APP_DB.db.prepare('SELECT COUNT(*) n FROM app_signup_visits').get().n, 1);
  assert.equal(env.APP_DB.db.prepare('SELECT source FROM app_signup_visits').get().source, 'bag-card-v1');
  assert.ok(!JSON.stringify(env.APP_DB.db.prepare('SELECT * FROM app_signup_visits').all()).includes(cookie.split('=')[1]));
  const denied = await visit(req(cookie), env, { ...deps, trackingDenied: true }, { source: 'website' });
  assert.equal((await denied.json()).recorded, false);
  await assert.rejects(visit(req(), env, deps, { source: 'patient-id-12345' }), /INPUT/);
  await visit(req(cookie), env, { ...deps, now: () => now + 31 * DAY }, { source: 'register-2' });
  assert.equal(env.APP_DB.db.prepare('SELECT COUNT(*) n FROM app_signup_visits').get().n, 2);
  await visit(req(), env, { ...deps, now: () => now + 220 * DAY }, { source: 'website' });
  assert.equal(env.APP_DB.db.prepare('SELECT COUNT(*) n FROM app_signup_visits').get().n, 1);
});
test('a first source survives OAuth state consumption and milestones need actual consent and device', async () => {
  const env = setup(), r = await visit(req(), env, deps, { source: 'register-2' }), cookie = r.headers.get('set-cookie').split(';')[0];
  const id = await hash(env.APP_LIMIT_SECRET, `signup-visit:${cookie.split('=')[1]}`);
  env.APP_DB.db.prepare('INSERT INTO app_logins VALUES (?, ?, ?, ?)').run('state', 'verifier', 'nonce', now + 600000);
  await startAcquisition(req(cookie), env, 'state', now);
  const captured = await acquisitionForLogin(env, 'state'); assert.equal(captured, id);
  env.APP_DB.db.prepare('DELETE FROM app_logins WHERE state_hash = ?').run('state');
  assert.equal(await acquisitionForLogin(env, 'state'), null);
  addUser(env, 'user', 'customer'); await verifiedAcquisition(env, 'user', captured, now); await linkedAcquisition(env, 'user', now);
  await reachableAcquisition(env, 'user', now); assert.equal(env.APP_DB.db.prepare('SELECT reachable_at FROM app_signup_visits').get().reachable_at, null);
  env.APP_DB.db.prepare(`INSERT INTO app_marketing_prefs(user_id, topics, updated_at) VALUES (?, ?, ?)`).run('user', '["specials"]', now);
  await reachableAcquisition(env, 'user', now); assert.equal(env.APP_DB.db.prepare('SELECT reachable_at FROM app_signup_visits').get().reachable_at, null);
  env.APP_DB.db.prepare('INSERT INTO app_push_subscriptions(endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('endpoint', 'user', 'synthetic-key', 'synthetic-auth', now);
  await reachableAcquisition(env, 'user', now);
  assert.equal(env.APP_DB.db.prepare('SELECT reachable_at FROM app_signup_visits').get().reachable_at, now);
  env.APP_DB.db.prepare('DELETE FROM app_users WHERE id = ?').run('user');
  assert.equal(env.APP_DB.db.prepare('SELECT COUNT(*) n FROM app_signup_visits').get().n, 0);
});
test('CRM report aggregates only subsequent completed sales, discloses no identities, and costs are idempotent', async () => {
  const env = setup(); addUser(env, 'private-user', 'private-customer');
  env.APP_DB.db.prepare('INSERT INTO app_signup_visits VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('visit', 'bag-card-v1', now - 10 * DAY, now - 10 * DAY, 'private-user', now - 10 * DAY, now - 9 * DAY, null);
  const insert = env.CRM_DB.db.prepare('INSERT INTO crm_orders VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('old-order', 'private-customer', now - 11 * DAY, 9900, 0, 'Completed', now);
  insert.run('later-order', 'private-customer', now - 8 * DAY, 4000, 1, 'Completed', now);
  const cost = { id: 'a'.repeat(32), source: 'bag-card-v1', cents: 1500, date: '2026-10-05' };
  await saveSignupSpend(env, cost, 'staff@example.test', now); await saveSignupSpend(env, cost, 'staff@example.test', now);
  assert.equal(env.CRM_DB.db.prepare('SELECT COUNT(*) n FROM crm_signup_spend').get().n, 1);
  assert.equal(env.CRM_DB.db.prepare('SELECT COUNT(*) n FROM crm_audit').get().n, 1);
  const report = await signupReport(env, now, 30), row = report.rows.find(r => r.source === 'bag-card-v1');
  assert.equal(row.linked, 1); assert.equal(row.verified, 1); assert.equal(row.revenue_cents, 4000);
  assert.equal(row.preorder_customers, 1); assert.equal(row.visit_customers, 1); assert.equal(row.spend_cents, 1500);
  assert.ok(!JSON.stringify(report).includes('private-')); assert.ok(!JSON.stringify(report).includes('staff@example'));
  await assert.rejects(signupReport(env, now, 999), /INPUT/);
  for (const change of [{ cents: -1 }, { cents: 1.5 }, { date: '2026-02-30' }, { date: '2027-01-01' }, { source: '__proto__' }])
    assert.throws(() => validateSignupSpend({ ...cost, ...change }, now), /INPUT/);
});
