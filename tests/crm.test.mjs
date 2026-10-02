import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { handleCrm } from '../server/crm/index.mjs';
import { runSync, purge } from '../server/crm/sync.mjs';
import { validateDefinition, compile } from '../server/crm/segments.mjs';
import { hash } from '../server/customer-app/http.mjs';
import { linkTarget, recordTap, sendCampaigns, sendOwnerAlerts, tapToken, validateCampaign } from '../server/crm/campaigns.mjs';
import { tickAssistant, SYSTEM } from '../server/crm/assistant.mjs';
import { maybeVerify } from '../server/crm/verify.mjs';
import { sendWelcomeGifts, welcomeForCustomer } from '../server/crm/welcome.mjs';

class D1 {
  constructor(dir) {
    this.db = new DatabaseSync(':memory:');
    for (const file of readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(f => f.endsWith('.sql')).sort())
      this.db.exec(readFileSync(new URL(`../${dir}/${file}`, import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const db = this.db;
    return { bind(...v) { return {
      async first() { return db.prepare(sql).get(...v) || null; },
      async run() { const stmt = db.prepare(sql); return { success: true, results: stmt.columns().length ? stmt.all(...v) : (stmt.run(...v), []) }; }
    }; } };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const r = []; for (const s of statements) r.push(await s.run()); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
const DAY = 86400000;
const keys = await generateKeyPair('RS256'), jwk = { ...await exportJWK(keys.publicKey), kid: 'crm-test', alg: 'RS256' };
const origin = 'https://www.example.test', aud = 'c'.repeat(64), issuer = 'https://synthetic.cloudflareaccess.com';

// A tiny in-memory GrowFlow: pages through records sorted by updatedAt, honoring since/skip.
function growflow(now) {
  const store = { orders: [], lines: [], customers: [] }, queries = [], failNext = { count: 0 };
  const root = { findOrders: 'orders', findOrderItems: 'lines', findCustomers: 'customers' };
  const fetch = async (url, init) => {
    assert.equal(init.redirect, 'manual');
    if (String(url).endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    assert.equal(init.headers.Authorization, 'Bearer gfr_crm_read_only');
    const { query, variables } = JSON.parse(init.body); queries.push({ query, variables });
    if (query.includes('TreehouseCrmNames'))
      return Response.json({ data: { findCustomers: { edges: variables.ids.map(id => ({ node: { objectId: id, Name: `Name of ${id}` } })) } } });
    assert.ok(!/\bOR\b/.test(JSON.stringify(variables.where)), 'no either/or queries');
    const field = Object.keys(root).find(f => query.includes(`${f}(`));
    const test = (r, w) => w.AND ? w.AND.every(x => test(r, x)) : Object.entries(w).every(([k, c]) => {
      const v = k === 'CompletedAt' || k === 'SoldAt' ? r[k] : r[k];
      return Object.entries(c).every(([op, x]) => op === 'equalTo' ? v === x : op === 'greaterThan' ? v > x
        : op === 'greaterThanOrEqualTo' ? v >= x : op === 'lessThan' ? v < x : op === 'in' ? x.includes(v) : false); });
    const keys = (variables.order || ['objectId_ASC']).map(o => o.replace('_ASC', ''));
    const all = store[root[field]].filter(r => test(r, variables.where))
      .sort((a, b) => keys.reduce((n, k) => n || String(a[k]).localeCompare(String(b[k])), 0));
    if (failNext.count > 0 && variables.first > 25) { failNext.count--; return new Response('busy', { status: 503 }); }
    const page = all.slice(0, variables.first);
    return Response.json({ data: { [field]: { pageInfo: { hasNextPage: all.length > variables.first }, edges: page.map(node => ({ node })) } } });
  };
  return { store, queries, fetch, failNext };
}
async function setup() {
  let now = Date.UTC(2026, 9, 1, 15);
  const gf = growflow(now), logs = [];
  const env = { CRM_ENABLED: 'true', CRM_DB: new D1('crm-migrations'), APP_DB: new D1('app-migrations'),
    CRM_GROWFLOW_TOKEN: 'gfr_crm_read_only', GROWFLOW_ORG: 'integrations',
    CRM_ACCESS_ISSUER: issuer, CRM_ACCESS_AUD: aud, CRM_EMAILS: 'owner@example.test,manager@example.test',
    CRM_SECRET: 'synthetic-crm-secret-at-least-thirty-two-chars' };
  const deps = { now: () => now, report: c => logs.push(c), fetch: gf.fetch };
  const token = (claims = {}) => new SignJWT({ iss: issuer, aud: [aud], sub: 'owner-1', email: 'owner@example.test', type: 'app',
    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'crm-test' }).sign(keys.privateKey);
  const jwt = await token();
  async function run(route, body, { assertion = jwt, headers = {} } = {}) {
    const csrf = await hash(env.CRM_SECRET, `crm-csrf:${assertion}`), method = body === undefined ? 'GET' : 'POST';
    return handleCrm({ env, request: new Request(`${origin}/api/crm/${route}`, { method, headers: { 'cf-access-jwt-assertion': assertion,
      origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-crm-csrf': csrf, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }, deps);
  }
  const at = days => new Date(now - days * DAY).toISOString();
  const order = (id, customer, daysAgo, total, extra = {}) => gf.store.orders.push({ objectId: id, updatedAt: at(daysAgo), CompletedAt: at(daysAgo),
    Status: 'Completed', Total: total, IsPreOrder: false, Customer: { objectId: customer }, ...extra });
  const line = (id, customer, daysAgo, cents, type, brand, extra = {}) => gf.store.lines.push({ objectId: id, updatedAt: at(daysAgo), SoldAt: at(daysAgo),
    Status: 'Sold', NetPrice: cents, Customer: { objectId: customer }, Brand: { objectId: brand, Name: `Brand ${brand}` },
    ProductCategory: { objectId: `cat-${type}`, Name: type, Type: type }, ...extra });
  const customer = (id, extra = {}) => gf.store.customers.push({ objectId: id, updatedAt: at(1), createdAt: at(400),
    Birthday: '1980-10-15T00:00:00.000Z', CustomerType: 'Medical', CurrentPoints: 120, Name: 'Never stored', PhoneNumber: '5550100', ...extra });
  return { env, deps, gf, logs, jwt, token, run, order, line, customer, advance: t => { now += t; }, now: () => now,
    db: env.CRM_DB.db, sync: (pages = 50) => runSync(env, deps, pages) };
}
function seed(s) {
  s.customer('A', { CurrentPoints: 640 }); s.customer('B', { Birthday: '1990-03-02T00:00:00.000Z' }); s.customer('C');
  s.order('o1', 'A', 5, 4000); s.order('o2', 'A', 20, 6000); s.order('o3', 'A', 40, 3000); s.order('o4', 'A', 70, 2500);
  s.order('o5', 'B', 100, 9000); s.order('o6', 'C', 2, 1500, { IsPreOrder: true });
  s.order('o7', 'C', 3, 8800, { Status: 'Canceled' }); s.order('o8', null, 4, 1000, { Customer: null });
  s.line('l1', 'A', 5, 4000, 'Concentrate', 'b1'); s.line('l2', 'A', 20, 6000, 'Flower', 'b2'); s.line('l3', 'B', 100, 9000, 'Edible', 'b3');
  s.line('l4', 'C', 2, 1500, 'Pre-Roll', 'b2'); s.line('l5', 'C', 2, 700, 'Gummies', 'b3', { ReturnedAt: new Date().toISOString() });
}

test('sync keeps lean, pseudonymous facts: no names, phones or full birth dates', async () => {
  const s = await setup(); seed(s); await s.sync();
  const columns = ['crm_customers', 'crm_orders', 'crm_lines'].flatMap(t => s.db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
  for (const banned of ['name', 'phone', 'email', 'birthday', 'license', 'address']) assert.ok(!columns.some(c => c.toLowerCase().includes(banned)), banned);
  const dump = JSON.stringify(['crm_customers', 'crm_orders', 'crm_lines'].map(t => s.db.prepare(`SELECT * FROM ${t}`).all()));
  assert.ok(!dump.includes('Never stored') && !dump.includes('5550100') && !dump.includes('1980'));
  assert.deepEqual(s.db.prepare('SELECT id, birth_month, points FROM crm_customers ORDER BY id').all().map(r => ({ ...r })),
    [{ id: 'A', birth_month: 10, points: 640 }, { id: 'B', birth_month: 3, points: 120 }, { id: 'C', birth_month: 10, points: 120 }]);
  assert.deepEqual(s.db.prepare('SELECT id FROM crm_orders ORDER BY id').all().map(r => r.id), ['o1', 'o2', 'o3', 'o4', 'o5', 'o6']);
  assert.equal(s.db.prepare("SELECT category_group FROM crm_lines WHERE id = 'l4'").get().category_group, 'flower');
  assert.equal(s.db.prepare("SELECT returned FROM crm_lines WHERE id = 'l5'").get().returned, 1);
  assert.ok(s.gf.queries.every(q => !/Name\b(?! \})|PhoneNumber|Email|License|Address/.test(q.query.replace(/Brand \{ objectId Name \}|ProductCategory \{ objectId Name Type \}/g, ''))));
});
test('incremental sync resumes after the last record, survives equal timestamps, and applies status changes', async () => {
  const s = await setup();
  for (let i = 0; i < 230; i++) s.order(`bulk${i}`, 'A', 10, 100); // 230 orders sharing one updatedAt
  await s.sync(1); assert.equal(s.db.prepare('SELECT count(*) n FROM crm_orders').get().n, 100);
  await s.sync(50); assert.equal(s.db.prepare('SELECT count(*) n FROM crm_orders').get().n, 230);
  const o = s.gf.store.orders.find(x => x.objectId === 'bulk5'); o.Status = 'Voided'; o.VoidedAt = new Date(s.now()).toISOString(); o.updatedAt = new Date(s.now()).toISOString();
  await s.sync(); assert.equal(s.db.prepare('SELECT count(*) n FROM crm_orders').get().n, 229);
  assert.ok(s.db.prepare("SELECT caught_up_at FROM crm_sync_state WHERE source = 'orders'").get().caught_up_at);
});
test('retention removes detail after 24 months and inactive customers after 36; deleted GrowFlow customers vanish', async () => {
  const s = await setup(); seed(s); await s.sync();
  s.advance(800 * DAY); await purge(s.env, s.now());
  assert.equal(s.db.prepare('SELECT count(*) n FROM crm_lines').get().n, 0);
  assert.equal(s.db.prepare('SELECT count(*) n FROM crm_customers').get().n, 3); // last visit < 36 months ago
  s.advance(400 * DAY); await purge(s.env, s.now());
  assert.equal(s.db.prepare('SELECT count(*) n FROM crm_customers').get().n, 0);
  const t = await setup(); seed(t); await t.sync();
  const c = t.gf.store.customers.find(x => x.objectId === 'A'); c.IsDeleted = true; c.updatedAt = new Date(t.now()).toISOString();
  await t.sync(); assert.equal(t.db.prepare("SELECT count(*) n FROM crm_orders WHERE customer_id = 'A'").get().n, 0);
});
test('segment rules are validated strictly and compiled with parameters only', () => {
  for (const bad of [{}, null, { lastVisit: { minDays: 90, maxDays: 30 } }, { visits: { days: 0, min: 1 } }, { categories: { groups: ['x'], days: 30 } },
    { brands: { ids: ["b1' OR 1=1 --"], days: 30 } }, { birthday: 'tomorrow' }, { app: 'yes' }, { pointsMin: -1 }, { evil: 1 }])
    assert.throws(() => validateDefinition(bad));
  const { where, params } = compile(validateDefinition({ brands: { ids: ['b1'], days: 30 }, spend: { days: 90, min: 50 } }), Date.now());
  assert.ok(!where.includes('b1')); assert.ok(params.includes('b1')); assert.ok(params.includes(5000));
});
test('the CRM requires a verified Access login from an approved person, and CSRF on changes', async () => {
  const s = await setup();
  assert.equal((await s.run('session')).status, 200);
  assert.equal((await s.run('session', undefined, { assertion: '' })).status, 401);
  assert.equal((await s.run('session', undefined, { assertion: 'forged' })).status, 401);
  assert.equal((await s.run('session', undefined, { assertion: await s.token({ email: 'stranger@example.test' }) })).status, 403);
  assert.equal((await s.run('session', undefined, { assertion: await s.token({ aud: ['d'.repeat(64)] }) })).status, 401);
  assert.equal((await s.run('preview', { definition: { pointsMin: 1 } }, { headers: { 'x-crm-csrf': 'wrong' } })).status, 403);
  assert.equal((await s.run('preview', { definition: { pointsMin: 1 } }, { headers: { origin: 'https://evil.example' } })).status, 403);
  s.env.CRM_ENABLED = 'false'; assert.equal((await s.run('session')).status, 503);
});
test('overview, segments and live names work end to end, and list views are audited without customer data', async () => {
  const s = await setup(); seed(s); await s.sync();
  const o = await (await s.run('overview')).json();
  assert.equal(o.totals.active_30, 2); assert.equal(o.totals.visits_30, 3); assert.equal(o.totals.revenue_30_cents, 11500);
  assert.equal(o.totals.preorders_30, 1); assert.equal(o.categories[0].grp, 'flower');
  const regulars = await (await s.run('preview', { definition: { visits: { days: 90, min: 4 } } })).json();
  assert.equal(regulars.customers, 1);
  const lapsed = await (await s.run('preview', { definition: { lastVisit: { minDays: 60, maxDays: 180 } } })).json();
  assert.equal(lapsed.customers, 1);
  const edibles = await (await s.run('preview', { definition: { categories: { groups: ['edible'], days: 30 } } })).json();
  assert.equal(edibles.customers, 0); // C's gummies were returned
  const list = await (await s.run('customers', { definition: { spend: { days: 365, min: 1 } }, sort: 'spend' })).json();
  assert.deepEqual(list.customers.map(c => [c.id, c.name, c.spend_90_cents]), [['A', 'Name of A', 15500], ['C', 'Name of C', 1500], ['B', 'Name of B', 0]]);
  const audit = s.db.prepare('SELECT actor, action, detail FROM crm_audit').all();
  assert.equal(audit.length, 1); assert.equal(audit[0].actor, 'owner@example.test'); assert.ok(!audit[0].detail.includes('Name of'));
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM crm_customers').all()).includes('Name of'));
});
test('saved segments, customer removal, and app adoption flags', async () => {
  const s = await setup(); seed(s);
  s.env.APP_DB.db.exec("INSERT INTO app_users(id, identity_hash, customer_id, created_at) VALUES ('u1', 'h1', 'A', 1)");
  s.env.APP_DB.db.exec("INSERT INTO app_push_subscriptions(endpoint, user_id, p256dh, auth, created_at) VALUES ('https://fcm.googleapis.com/x', 'u1', 'k', 'a', 1)");
  await s.sync();
  assert.deepEqual({ ...s.db.prepare("SELECT app_linked, app_push FROM crm_customers WHERE id = 'A'").get() }, { app_linked: 1, app_push: 1 });
  const saved = await (await s.run('segments/save', { name: 'Regulars', definition: { visits: { days: 90, min: 4 } } })).json();
  assert.equal((await (await s.run('segments')).json()).segments[0].name, 'Regulars');
  await s.run('segments/delete', { id: saved.id }); assert.equal((await (await s.run('segments')).json()).segments.length, 0);
  assert.equal((await s.run('forget', { customerId: 'A' })).status, 200);
  assert.equal(s.db.prepare("SELECT count(*) n FROM crm_orders WHERE customer_id = 'A'").get().n, 0);
  assert.equal(s.db.prepare("SELECT count(*) n FROM crm_customers WHERE id = 'A'").get().n, 0);
  assert.deepEqual(s.db.prepare('SELECT action FROM crm_audit ORDER BY at').all().map(a => a.action).sort(), ['delete_segment', 'forget_customer', 'save_segment']);
});

test('re-reading unchanged records and app flags writes nothing (D1 bills every row written)', async () => {
  const s = await setup(); seed(s);
  s.env.APP_DB.db.exec("INSERT INTO app_users(id, identity_hash, customer_id, created_at) VALUES ('u1', 'h1', 'A', 1)");
  await s.sync();
  s.db.exec('CREATE TABLE writes (n INTEGER); INSERT INTO writes VALUES (0);');
  for (const t of ['crm_customers', 'crm_orders', 'crm_lines', 'crm_brands', 'crm_categories'])
    s.db.exec(`CREATE TRIGGER count_${t} AFTER UPDATE ON ${t} BEGIN UPDATE writes SET n = n + 1; END;`);
  s.db.exec('DELETE FROM crm_sync_state'); s.advance(60000);
  await s.sync(); await s.sync();
  assert.equal(s.db.prepare('SELECT n FROM writes').get().n, 0);
  s.env.APP_DB.db.exec("UPDATE app_users SET customer_id = 'B' WHERE id = 'u1'");
  Object.assign(s.gf.store.customers.find(c => c.objectId === 'C'), { CurrentPoints: 300, updatedAt: new Date(s.now()).toISOString() });
  await s.sync();
  assert.equal(s.db.prepare('SELECT n FROM writes').get().n, 3); // A unlinked, B linked, C's points
  assert.deepEqual(s.db.prepare('SELECT id FROM crm_customers WHERE app_linked = 1').all().map(r => r.id), ['B']);
});
test('a run stops starting pages after its time budget so minute runs never overlap', async () => {
  const s = await setup();
  for (let i = 0; i < 1000; i++) s.order(`slow${i}`, 'A', 10 + i / 100, 100);
  let t = s.now();
  const result = await runSync(s.env, { ...s.deps, now: () => (t += 10000) }, 40, 45000);
  assert.ok(result.pages >= 1 && result.pages <= 4, `ran ${result.pages} pages`);
});
test('Deals & news counts only opted-in customers who have a device, and can be targeted', async () => {
  const s = await setup(); seed(s);
  const app = s.env.APP_DB.db;
  app.exec("INSERT INTO app_users(id, identity_hash, customer_id, created_at) VALUES ('u1', 'h1', 'A', 1), ('u2', 'h2', 'B', 1), ('u3', 'h3', 'C', 1)");
  app.exec("INSERT INTO app_push_subscriptions(endpoint, user_id, p256dh, auth, created_at) VALUES ('https://fcm.googleapis.com/a', 'u1', 'k', 'a', 1), ('https://fcm.googleapis.com/c', 'u3', 'k', 'a', 1)");
  app.exec(`INSERT INTO app_marketing_prefs(user_id, topics, updated_at) VALUES ('u1', '["events"]', 1), ('u2', '["events"]', 1), ('u3', '[]', 1)`);
  await s.sync();
  assert.deepEqual(s.db.prepare('SELECT id FROM crm_customers WHERE app_marketing = 1').all().map(r => r.id), ['A']);
  const p = await (await s.run('preview', { definition: { app: 'marketing' } })).json();
  assert.equal(p.customers, 1); assert.equal(p.appMarketing, 1);
  assert.equal((await (await s.run('overview')).json()).totals.app_marketing, 1);
  app.exec("UPDATE app_marketing_prefs SET topics = '[]' WHERE user_id = 'u1'"); await s.sync();
  assert.equal(s.db.prepare('SELECT count(*) n FROM crm_customers WHERE app_marketing = 1').get().n, 0);
});
test('long-time customers are not removed while their order history is still loading', async () => {
  const s = await setup();
  s.customer('Old', { createdAt: new Date(s.now() - 2000 * DAY).toISOString() });
  for (let i = 0; i < 150; i++) s.order(`h${i}`, 'X', 300 - i, 100);
  s.order('recent', 'Old', 3, 5000);
  await s.sync(3); // one page each: customers loaded, orders only partly
  assert.equal(s.db.prepare("SELECT count(*) n FROM crm_customers WHERE id = 'Old'").get().n, 1);
  await s.sync();
  assert.ok(s.db.prepare("SELECT last_visit FROM crm_customers WHERE id = 'Old'").get().last_visit);
});
test('a busy GrowFlow gets smaller pages, and one failing source does not stop the others', async () => {
  const s = await setup(); seed(s);
  s.gf.failNext.count = 1; await s.sync();
  assert.equal(s.db.prepare('SELECT count(*) n FROM crm_orders').get().n, 6);
  assert.ok(s.gf.queries.some(q => q.variables.first === 25));
  const t = await setup(); seed(t);
  const base = t.deps.fetch; t.deps.fetch = async (url, init) => String(init?.body || '').includes('findOrders(') ? new Response('down', { status: 500 }) : base(url, init);
  await t.sync();
  assert.equal(t.db.prepare('SELECT count(*) n FROM crm_orders').get().n, 0);
  assert.equal(t.db.prepare('SELECT count(*) n FROM crm_lines').get().n, 5);
  assert.ok(t.logs.includes('CRM_HTTP_500_ORDERS'));
});
test('only orders and lines inside the 24-month window are requested', async () => {
  const s = await setup(); s.customer('A');
  s.order('old', 'A', 900, 5000, { updatedAt: new Date(s.now() - 2 * DAY).toISOString() }); s.order('new', 'A', 5, 1000);
  await s.sync();
  assert.deepEqual(s.db.prepare('SELECT id FROM crm_orders').all().map(r => r.id), ['new']);
  assert.ok(s.gf.queries.filter(q => q.query.includes('findOrders(')).every(q => JSON.stringify(q.variables.where).includes('CompletedAt')));
});

// --- Deals & news campaigns ---
async function phone(n) {
  const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
    p256dh: Buffer.from(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))).toString('base64url'),
    auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') };
}
async function campaigns() {
  const s = await setup(); seed(s);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  Object.assign(s.env, { CRM_CAMPAIGNS_ENABLED: 'true', APP_PUSH_ENABLED: 'true', APP_PUSH_SUBJECT: 'mailto:owner@example.test',
    APP_VAPID_PUBLIC_KEY: Buffer.from(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))).toString('base64url'),
    APP_VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)) });
  const pushes = [], base = s.deps.fetch;
  s.deps.fetch = async (url, init) => {
    if (new URL(String(url)).hostname !== 'fcm.googleapis.com') return base(url, init);
    pushes.push({ url: String(url), headers: init.headers }); return new Response('', { status: 201 });
  };
  const app = s.env.APP_DB.db;
  async function optIn(customer, topics) {
    const user = `user-${customer}`, device = await phone(customer);
    app.prepare('INSERT INTO app_users(id, identity_hash, customer_id, created_at) VALUES (?, ?, ?, 1)').run(user, `h-${customer}`, customer);
    app.prepare('INSERT INTO app_push_subscriptions(endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 1)').run(device.endpoint, user, device.p256dh, device.auth);
    app.prepare('INSERT INTO app_marketing_prefs(user_id, topics, updated_at) VALUES (?, ?, 1)').run(user, JSON.stringify(topics));
  }
  await optIn('A', ['new_arrivals', 'events']); await optIn('B', ['events']); await optIn('C', ['new_arrivals']);
  await s.sync();
  const draft = (extra = {}) => ({ name: 'October arrivals', topic: 'new_arrivals', body: 'New arrivals just landed. Tap to see what’s new.',
    link: 'menu', definition: null, audienceLabel: 'Everyone', holdoutPct: 0, ...extra });
  // A fresh Access token per request, since these tests move the clock forward by days.
  const call = async (route, body) => s.run(route, body, { assertion: await s.token() });
  const send = async extra => (await (await call('campaigns/send', { campaign: draft(extra) })).json()).id;
  const states = id => Object.fromEntries(s.db.prepare('SELECT customer_id, state FROM crm_campaign_recipients WHERE campaign_id = ?').all(id).map(r => [r.customer_id, r.state]));
  return { ...s, app, pushes, optIn, draft, call, send, states, deliver: () => sendCampaigns(s.env, s.deps) };
}

test('campaign wording stays discreet and claim-free; every topic, including specials, can be sent', () => {
  const env = {}, now = Date.UTC(2026, 9, 1, 15), base = { name: 'X', topic: 'events', body: 'Join us Saturday for our anniversary party!',
    link: 'home', holdoutPct: 10 };
  assert.equal(validateCampaign(base, env, now).sendAt, now);
  const code = extra => { try { validateCampaign({ ...base, ...extra }, env, now); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code({ body: 'Fresh THC carts just landed, come see' }), 'CAMPAIGN_DISCREET');
  assert.equal(code({ body: 'New gummies are in. Tap to see.' }), 'CAMPAIGN_DISCREET');
  assert.equal(code({ body: 'Our best picks for pain relief are here' }), 'CAMPAIGN_CLAIMS');
  assert.equal(code({ body: 'Hi' }), 'CAMPAIGN_LENGTH');
  assert.equal(code({ topic: 'specials' }), 'ok');
  assert.equal(code({ link: 'https://example.test' }), 'INPUT');
  assert.equal(code({ holdoutPct: 50 }), 'INPUT');
  assert.equal(code({ sendAt: now + 40 * DAY }), 'CAMPAIGN_TIME');
  assert.equal(code({ extra: 1 }), 'INPUT');
});

test('a campaign reaches only customers opted in to its topic, narrowed by segment rules, and is sent once', async () => {
  const s = await campaigns();
  const preview = async extra => (await s.call('campaigns/preview', { campaign: s.draft(extra) })).json();
  assert.deepEqual(await preview(), { optedIn: 2, weeklyLimit: 0, heldBack: 0, reach: 2, waitsForMorning: false });
  assert.equal((await preview({ definition: { categories: { groups: ['concentrate'], days: 90 } } })).reach, 1);
  const id = await s.send();
  await s.deliver(); await s.deliver();
  assert.deepEqual(s.states(id), { A: 'sent', C: 'sent' });
  assert.equal(s.pushes.length, 2);
  const headers = s.pushes[0].headers;
  assert.equal(headers.Urgency, 'normal'); assert.equal(headers.Topic, id.slice(0, 32));
  assert.ok(Number(headers.TTL) <= 10 * 3600, 'expires before 8 pm Central');
  const list = (await (await s.call('campaigns')).json()).campaigns;
  assert.equal(list[0].status, 'sent'); assert.equal(list[0].counts.sent, 2);
  assert.deepEqual(s.db.prepare('SELECT action FROM crm_audit').all().map(a => a.action), ['send_campaign']);
});

test('no more than 2 a week per person, nothing late at night, and a changed mind is respected', async () => {
  const s = await campaigns();
  const one = await s.send({ topic: 'events' }); await s.deliver();
  const two = await s.send({ topic: 'events' }); await s.deliver();
  const three = await s.send({ topic: 'events' });
  assert.equal((await (await s.call('campaigns/preview', { campaign: s.draft({ topic: 'events' }) })).json()).weeklyLimit, 2);
  await s.deliver();
  assert.deepEqual([s.states(one), s.states(two), s.states(three)], [{ A: 'sent', B: 'sent' }, { A: 'sent', B: 'sent' }, { A: 'capped', B: 'capped' }]);
  // 9 pm Central: waits until morning, and anyone who opts out meanwhile is skipped.
  s.advance(8 * DAY + 11 * 3600000);
  const late = await s.send();
  await s.deliver(); assert.deepEqual(s.states(late), {});
  s.app.exec("UPDATE app_marketing_prefs SET topics = '[\"events\"]' WHERE user_id = 'user-C'");
  s.advance(12 * 3600000); await s.deliver();
  assert.deepEqual(s.states(late), { A: 'sent' });
  const before = s.pushes.length; s.advance(60000); await s.deliver(); assert.equal(s.pushes.length, before);
});

test('held-back customers are never sent it, and results compare both groups over 7 days', async () => {
  const s = await campaigns();
  for (let i = 0; i < 40; i++) await s.optIn(`P${i}`, ['events']);
  const id = await s.send({ topic: 'events', holdoutPct: 20 });
  await s.deliver();
  const st = s.states(id), held = Object.values(st).filter(x => x === 'holdout').length, sent = Object.values(st).filter(x => x === 'sent').length;
  assert.ok(held >= 1 && held <= 20, `held back ${held}`); assert.equal(sent + held, 42); assert.equal(s.pushes.length, sent);
  const sentOne = Object.keys(st).find(k => st[k] === 'sent');
  s.order('after1', sentOne, -2, 5000); s.advance(3 * DAY); await s.sync();
  const r = (await (await s.call('campaigns')).json()).campaigns[0].results;
  assert.equal(r.sent.people, sent); assert.equal(r.sent.visited, 1); assert.equal(r.holdout.people, held); assert.equal(r.holdout.visited, 0);
});

test('test sends go only to the sender’s own record, any hour, and never count toward the limit', async () => {
  const s = await campaigns();
  assert.equal((await s.call('campaigns/test', { campaign: s.draft() })).status, 400);
  assert.equal((await s.call('settings/test-customer', { customerId: 'B' })).status, 200);
  s.advance(11 * 3600000); // 9 pm Central
  assert.equal((await s.call('campaigns/test', { campaign: s.draft() })).status, 200);
  await s.deliver();
  assert.equal(s.pushes.length, 1); assert.ok(s.pushes[0].url.endsWith('device-B'));
  assert.equal((await (await s.call('campaigns')).json()).campaigns.length, 0);
  assert.equal((await (await s.call('campaigns/preview', { campaign: s.draft({ topic: 'events' }) })).json()).weeklyLimit, 0);
});

test('canceled campaigns are not sent; campaigns stay off until enabled; removing a customer removes their sends', async () => {
  const s = await campaigns();
  const later = await s.send({ sendAt: s.now() + 3600000 });
  assert.equal((await s.call('campaigns/cancel', { id: later })).status, 200);
  s.advance(2 * 3600000); await s.deliver(); assert.equal(s.pushes.length, 0);
  assert.equal((await s.call('campaigns/cancel', { id: later })).status, 409);
  const id = await s.send(); await s.deliver();
  await s.call('forget', { customerId: 'A' });
  assert.deepEqual(s.states(id), { C: 'sent' });
  s.env.CRM_CAMPAIGNS_ENABLED = 'false';
  assert.equal((await s.call('campaigns')).status, 503);
  assert.deepEqual(await sendCampaigns(s.env, s.deps), { sent: 0 });
});

test('automatic messages go daily at 11 am to people who newly match, at most once per cooldown, until paused', async () => {
  const s = await campaigns(); // 10 am Central
  const auto = { name: 'Thank-you points', topic: 'events', body: 'Thanks for being a regular! Your points are waiting in the app.',
    link: 'rewards', definition: { pointsMin: 100 }, audienceLabel: 'Points 100+', holdoutPct: 0, cooldownDays: 30 };
  assert.equal((await s.call('automations/create', { automation: { ...auto, cooldownDays: 3 } })).status, 400);
  assert.equal((await s.call('automations/create', { automation: { ...auto, body: 'Your THC rewards' } })).status, 400);
  const { id } = await (await s.call('automations/create', { automation: auto })).json();
  const sentTo = () => s.db.prepare(`SELECT r.customer_id, r.state FROM crm_campaign_recipients r JOIN crm_campaigns c ON c.id = r.campaign_id
    WHERE c.automation_id = ? ORDER BY c.started_at, r.customer_id`).all(id).map(r => `${r.customer_id}:${r.state}`);
  await s.deliver(); assert.deepEqual(sentTo(), []); // before 11 am
  s.advance(3600000); await s.deliver(); await s.deliver();
  assert.deepEqual(sentTo(), ['A:sent', 'B:sent']); // C chose other topics; once per day
  s.customer('D', { CurrentPoints: 300, updatedAt: new Date(s.now()).toISOString() }); await s.optIn('D', ['events']);
  s.advance(DAY); await s.sync(); await s.deliver();
  assert.deepEqual(sentTo(), ['A:sent', 'B:sent', 'D:sent']); // only the newcomer; A and B are within 30 days
  const list = await (await s.call('campaigns')).json();
  assert.equal(list.campaigns.length, 0); assert.equal(list.automations[0].results.sent.people, 3); assert.equal(list.automations[0].active, true);
  await s.call('automations/active', { id, active: false });
  s.advance(31 * DAY + 3600000); await s.deliver(); // +1 hour: daylight saving ends on Nov 1
  assert.equal(sentTo().length, 3); // paused
  await s.call('automations/active', { id, active: true }); await s.deliver();
  assert.deepEqual(sentTo().slice(3), ['A:sent', 'B:sent', 'D:sent']); // after the cooldown, still matching
  assert.deepEqual(s.db.prepare("SELECT action FROM crm_audit WHERE action LIKE '%automation%' ORDER BY at").all().map(a => a.action),
    ['create_automation', 'pause_automation', 'resume_automation']);
});

test('"only once" automatic messages never repeat, and held-back people stay held back', async () => {
  const s = await campaigns(); s.advance(3600000);
  for (let i = 0; i < 30; i++) await s.optIn(`Q${i}`, ['events']);
  const { id } = await (await s.call('automations/create', { automation: { name: 'Welcome', topic: 'events', body: 'Welcome to Deals & news from Treehouse!',
    link: 'home', definition: null, audienceLabel: 'Everyone', holdoutPct: 20, cooldownDays: 0 } })).json();
  await s.deliver();
  const first = s.db.prepare(`SELECT r.customer_id, r.state FROM crm_campaign_recipients r JOIN crm_campaigns c ON c.id = r.campaign_id
    WHERE c.automation_id = ?`).all(id);
  assert.equal(first.length, 32); assert.ok(first.some(r => r.state === 'holdout'));
  s.advance(400 * DAY); await s.deliver();
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM crm_campaigns WHERE automation_id = ?').get(id).n, 1);
});

test('campaigns can open the menu to one section or brand; the filter travels apart from the URL', () => {
  assert.deepEqual(linkTarget('rewards'), { url: '/app/#rewards' });
  assert.deepEqual(linkTarget('menu:category:Concentrates'), { url: '/app/#menu', filter: 'category=Concentrates' });
  assert.deepEqual(linkTarget('menu:brand:Sample & Co'), { url: '/app/#menu', filter: 'brand=Sample%20%26%20Co' });
  for (const bad of ['menu:color:x', 'menu:brand:', `menu:brand:${'x'.repeat(61)}`, 'menu:brand:a\nb', 'menu:brand: padded', 'https://example.test', null])
    assert.equal(linkTarget(bad), null, String(bad));
  const ok = validateCampaign({ name: 'X', topic: 'new_arrivals', body: 'New from a brand you love. Tap to see.', link: 'menu:brand:Sample Brand', holdoutPct: 0 }, {}, Date.now());
  assert.equal(ok.link, 'menu:brand:Sample Brand');
});

// --- Campaign assistant (Claude is replaced by a scripted stand-in) ---
function fakeClaude(script) {
  const calls = [];
  return { calls, beta: { messages: { create: async params => {
    calls.push(JSON.parse(JSON.stringify(params)));
    const step = script[calls.length - 1];
    if (!step) throw new Error('unexpected extra call');
    return { model: params.model, usage: { input_tokens: 20000, output_tokens: 1500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...step };
  } } } };
}
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
async function assistant(extraEnv = {}) {
  const s = await campaigns();
  Object.assign(s.env, { CRM_ASSISTANT_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key-not-real', ...extraEnv });
  s.app.prepare("INSERT INTO app_cache(key, value, updated_at) VALUES ('menu:summary', ?, 1)").run(JSON.stringify({ updatedAt: s.now(), categories: ['Flower', 'Concentrates'],
    products: [{ id: 'p1', name: 'Sample Haze', brand: 'Brand b2', category: 'Flower' }, { id: 'p2', name: 'Live Sauce', brand: 'Brand b1', category: 'Concentrates' }] }));
  const tick = claude => tickAssistant(s.env, { ...s.deps, anthropic: claude });
  return { ...s, tick };
}
const draft = (extra = {}) => ({ name: 'Brand b1 drop', topic: 'new_arrivals', body: 'New from a brand you love just landed. Tap to see what’s new.',
  link: 'menu:brand:Brand b1', definition: { brands: { ids: ['b1'], days: 180 } }, audienceLabel: 'Brand b1 buyers', holdoutPct: 10, sendAt: null, ...extra });

test('the assistant reviews totals through tools and leaves suggestions for people to approve', async () => {
  const s = await assistant();
  assert.equal((await s.call('assistant/run', { kind: 'weekly' })).status, 200);
  const claude = fakeClaude([
    { stop_reason: 'tool_use', content: [use('t1', 'get_shop_overview'), use('t2', 'get_menu'), use('t3', 'list_campaigns'), use('t4', 'list_brands')] },
    { stop_reason: 'tool_use', content: [use('t5', 'check_campaign', draft({ body: 'Fresh THC carts from Brand b1 just landed' }))] },
    { stop_reason: 'tool_use', content: [use('t6', 'suggest_campaign', { title: 'Tell Brand b1 fans about the new drop', reasoning: 'They buy it often.', campaign: draft() }),
      use('t7', 'add_note', { note: 'Brand b1 fans are the biggest brand audience (1 opted in).' })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Quiet week. I suggested one brand alert.' }] }
  ]);
  const result = await s.tick(claude);
  assert.equal(result.status, 'done'); assert.equal(result.suggestions, 1); assert.equal(claude.calls.length, 4);
  const first = claude.calls[0];
  assert.equal(first.model, 'claude-opus-5-5'); assert.equal(first.fallbacks, 'default'); assert.deepEqual(first.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(first.system, SYSTEM); assert.match(first.messages[0].content, /weekly plan/);
  const results = claude.calls.slice(1).flatMap(c => c.messages.at(-1).content);
  assert.ok(!/customer_?id|user-A|identity/i.test(JSON.stringify(results)), 'tools return totals only');
  const checked = claude.calls[2].messages.at(-1).content[0];
  assert.equal(checked.is_error, true); assert.match(checked.content, /lock screen/);
  assert.deepEqual(JSON.parse(results.find(r => r.tool_use_id === 't2').content).sections.map(x => x.name).sort(), ['Concentrates', 'Flower']);
  const run = s.db.prepare("SELECT status, summary, cost_micro, model FROM crm_assistant_runs").get();
  assert.equal(run.status, 'done'); assert.match(run.summary, /Quiet week/); assert.equal(run.cost_micro, 4 * (4 * 20000 + 20 * 1500));
  const view = await (await s.call('assistant')).json();
  assert.equal(view.suggestions.length, 1); assert.equal(view.notes.length, 1); assert.equal(view.spentCents, 44);
  // Approving creates exactly that campaign; nothing was sent before.
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM crm_campaigns').get().n, 0);
  assert.equal((await s.call('assistant/decide', { id: view.suggestions[0].id, decision: 'approved' })).status, 200);
  const made = s.db.prepare('SELECT name, link, created_by, status FROM crm_campaigns').get();
  assert.deepEqual({ ...made }, { name: 'Brand b1 drop', link: 'menu:brand:Brand b1', created_by: 'owner@example.test (from assistant)', status: 'scheduled' });
  assert.equal((await s.call('assistant/decide', { id: view.suggestions[0].id, decision: 'dismissed' })).status, 409);
  assert.deepEqual(s.db.prepare("SELECT action FROM crm_audit WHERE action LIKE '%assistant%' OR action LIKE '%suggestion%' ORDER BY at").all().map(a => a.action),
    ['assistant_run', 'approve_suggestion']);
});

test('the assistant runs on schedule, learns from dismissals, and stops at its limits and budget', async () => {
  const s = await assistant(); // Thursday 10 am Central
  const daily = fakeClaude([
    { stop_reason: 'tool_use', content: [1, 2, 3].map(i => use(`s${i}`, 'suggest_campaign', { title: `Idea ${i}`, reasoning: 'Because.', campaign: draft({ name: `Idea ${i}` }) })) },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Two ideas.' }] }]);
  assert.equal((await s.tick(daily)).suggestions, 2); // daily limit
  assert.equal(daily.calls[0].model, 'claude-sonnet-5-5');
  assert.equal(await s.tick(fakeClaude([])), null); // once per day
  const view = await (await s.call('assistant')).json();
  await s.call('assistant/decide', { id: view.suggestions[0].id, decision: 'dismissed', note: 'Too soon after the last brand alert' });
  s.advance(3 * DAY + 23 * 3600000); // Monday 9 am
  const weekly = fakeClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Report.' }] }]);
  await s.tick(weekly);
  assert.match(weekly.calls[0].messages[0].content, /Too soon after the last brand alert/);
  assert.match(weekly.calls[0].messages[0].content, /weekly plan/);
  s.advance(17 * 3600000); assert.equal(await s.tick(fakeClaude([])), null); // 2 am: nothing scheduled
  // Budget: once this month's spending reaches the cap, runs stop before calling Claude.
  s.env.CRM_ASSISTANT_BUDGET_CENTS = '20'; // earlier runs this month spent 22 cents
  await s.call('assistant/run', { kind: 'daily' });
  const none = fakeClaude([]);
  assert.equal((await s.tick(none)).status, 'budget'); assert.equal(none.calls.length, 0);
  // A run that keeps calling tools stops at its size limit.
  s.env.CRM_ASSISTANT_BUDGET_CENTS = '100000';
  await s.call('assistant/run', { kind: 'daily' });
  const loop = fakeClaude(Array.from({ length: 30 }, (_, i) => ({ stop_reason: 'tool_use', content: [use(`l${i}`, 'get_shop_overview')] })));
  const stopped = await s.tick(loop);
  assert.equal(stopped.status, 'limit'); assert.ok(loop.calls.length <= 12);
});

test('assistant routes stay off until enabled, and the worker does nothing without its key', async () => {
  const s = await campaigns();
  assert.equal((await s.call('assistant')).status, 503);
  s.env.CRM_ASSISTANT_ENABLED = 'true';
  assert.equal((await s.call('assistant')).status, 200);
  assert.equal((await s.call('assistant/run', { kind: 'monthly' })).status, 400);
  assert.equal(await tickAssistant(s.env, { ...s.deps, anthropic: fakeClaude([]) }), null);
});

test('results follow the funnel: taps, visits, app orders, buying what was featured, and opt-outs', async () => {
  const s = await campaigns();
  s.env.APP_LIMIT_SECRET = 'synthetic-limit-secret-for-tap-codes-123';
  for (let i = 0; i < 30; i++) await s.optIn(`P${i}`, ['events']);
  const id = await s.send({ topic: 'events', holdoutPct: 20, link: 'menu:brand:Brand b1' });
  await s.deliver();
  const st = s.states(id), sent = Object.keys(st).filter(k => st[k] === 'sent'), held = Object.keys(st).filter(k => st[k] === 'holdout');
  const [one, two] = sent;
  // A tap is recorded once, and only with a valid code.
  await recordTap(s.env, await tapToken(s.env, id, one), s.now() + 60000);
  await recordTap(s.env, await tapToken(s.env, id, one), s.now() + 120000);
  await assert.rejects(recordTap(s.env, `${id}.${two}.${'0'.repeat(64)}`, s.now()));
  await assert.rejects(recordTap(s.env, 'nonsense', s.now()));
  s.order('buy1', one, -1, 4000, { IsPreOrder: true }); s.line('buy1-l', one, -1, 4000, 'Concentrate', 'b1');
  s.order('visit2', two, -2, 1500); s.line('visit2-l', two, -2, 1500, 'Flower', 'b2');
  s.app.prepare("INSERT INTO app_marketing_consent_log(user_id, at, topics, source) VALUES (?, ?, '[]', 'account')").run(`user-${two}`, s.now() + 3600000);
  if (held.length) s.app.prepare("INSERT INTO app_marketing_consent_log(user_id, at, topics, source) VALUES (?, ?, '[\"new_arrivals\"]', 'account')").run(`user-${held[0]}`, s.now() + 5 * DAY);
  s.advance(3 * DAY); await s.sync();
  const r = (await (await s.call('campaigns')).json()).campaigns[0].results;
  assert.equal(r.featured, 'Brand b1');
  assert.deepEqual({ ...r.sent, people: undefined }, { people: undefined, tapped: 1, visited: 2, cents: 5500, appOrders: 1, bought: 1, optedOut: 1 });
  assert.equal(r.sent.people, sent.length); assert.equal(r.holdout.people, held.length);
  assert.equal(r.holdout.optedOut, 0); // changed later than 2 days after the send
  assert.equal(r.holdout.tapped, undefined);
});

test('scheduled assistant runs update owners who asked, on their own phones; manual runs and quiet days do not', async () => {
  const s = await assistant(); // Thursday 10 am: the daily check is due
  assert.equal((await s.call('settings/assistant-updates', { on: true })).status, 400); // no test phone yet
  await s.call('settings/test-customer', { customerId: 'B' });
  assert.equal((await s.call('settings/assistant-updates', { on: true })).status, 200);
  assert.deepEqual((await (await s.call('assistant')).json()).me, { testPhone: true, notify: true });
  const quiet = fakeClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'All good, nothing to change.' }] }]);
  await s.tick(quiet);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM crm_owner_alerts').get().n, 0);
  await s.call('assistant/run', { kind: 'weekly' });
  await s.tick(fakeClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Manual plan.' }] }]));
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM crm_owner_alerts').get().n, 0); // asked for in the CRM: no ping
  s.advance(DAY); // Friday's daily check flags a problem
  await s.tick(fakeClaude([{ stop_reason: 'tool_use', content: [use('a1', 'alert_owners', { message: 'Opt-outs jumped after Tuesday’s message.' })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Watch opt-outs.' }] }]));
  const before = s.pushes.length;
  await sendOwnerAlerts(s.env, s.deps); // the notifier runs every minute
  s.advance(3 * DAY - 3600000); // Monday 9 am weekly plan with one suggestion
  await s.tick(fakeClaude([{ stop_reason: 'tool_use', content: [use('w1', 'suggest_campaign', { title: 'Brand alert', reasoning: 'Fans.', campaign: draft() })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Plan ready.' }] }]));
  assert.deepEqual(s.db.prepare('SELECT body FROM crm_owner_alerts ORDER BY created_at').all().map(a => a.body),
    ['Daily check: Opt-outs jumped after Tuesday’s message.', 'Weekly plan ready: 1 suggestion to review.']);
  await sendOwnerAlerts(s.env, s.deps); await sendOwnerAlerts(s.env, s.deps); // each update goes once
  assert.equal(s.pushes.length - before, 2); assert.ok(s.pushes.slice(before).every(p => p.url.endsWith('device-B')));
});

test('a one-time check re-reads customers, orders and items from GrowFlow and records how well they match', async () => {
  const s = await setup(); seed(s); // Thursday 10 am Central
  for (let i = 0; i < 5; i++) s.order(`y${i}`, 'A', 1, 1000 + i); // yesterday
  s.line('yl1', 'B', 1, 2500, 'Edible', 'b3'); s.line('yl2', 'C', 1, 900, 'Flower', 'b2');
  await s.sync();
  assert.equal(await maybeVerify(s.env, s.deps), false); // off unless labelled
  // Drift that the check should catch: a missed order, a changed price, and points changed after the sync.
  s.order('missed', 'B', 1, 7777); s.db.exec("UPDATE crm_lines SET net_cents = 1 WHERE id = 'yl2'");
  s.env.CRM_VERIFY_ONCE = 'october';
  assert.equal(await maybeVerify(s.env, s.deps), true);
  assert.equal(await maybeVerify(s.env, s.deps), false); // once per label
  const row = s.db.prepare("SELECT action, actor, detail FROM crm_audit WHERE id = 'verify:october'").get();
  assert.equal(row.action, 'data_check'); assert.equal(row.actor, 'system');
  const r = JSON.parse(row.detail);
  assert.equal(r.customers.checked, 2); assert.equal(r.customers.found, 2); // visited in the last 90 days: A and C
  assert.equal(r.customers.birthMonth.match, 2); assert.equal(r.customers.type.match, 2); assert.equal(r.customers.points.match, 2);
  const y = r.orderDays[0];
  assert.equal(y.expected, 6); assert.equal(y.crm, 5); assert.deepEqual(y.missingInCrm, ['missed']); assert.equal(y.differentDetails, 0);
  assert.equal(r.items.expected, 2); assert.equal(r.items.price.mismatch, 1); assert.equal(r.items.brand.match, 2);
  assert.ok(!/Never stored|5550100/.test(row.detail), 'no personal details');
});

test('the welcome gift: one code per customer when they turn on Deals & news, sent once, daytime only', async () => {
  const s = await campaigns(); // A, B and C are opted in with phones; Thursday 10 am Central
  const save = welcome => s.call('welcome/save', { welcome });
  const offer = { on: true, description: 'a pre-roll for a penny', message: 'Thanks for turning on Deals & news! Your welcome gift code is {code}. Show it at checkout.', endsOn: null };
  assert.deepEqual(await sendWelcomeGifts(s.env, s.deps), { sent: 0 }); // off until turned on
  assert.equal((await save({ ...offer, message: 'Thanks! Show this at checkout.' })).status, 400); // no {code}
  assert.equal((await save({ ...offer, message: 'Your free pre-roll code is {code}' })).status, 400); // lock screen wording
  assert.equal((await save({ ...offer, description: 'relief for your pain' })).status, 400); // health claim
  assert.equal((await save({ ...offer, description: '' })).status, 400);
  assert.equal((await save(offer)).status, 200);
  assert.equal((await sendWelcomeGifts(s.env, s.deps)).sent, 3);
  const codes = s.db.prepare('SELECT customer_id, code FROM crm_welcome_gifts ORDER BY customer_id').all();
  assert.deepEqual(codes.map(c => c.customer_id), ['A', 'B', 'C']);
  assert.ok(codes.every(c => /^TH-[A-HJ-NP-Z2-9]{4}$/.test(c.code)));
  assert.equal(new Set(codes.map(c => c.code)).size, 3);
  assert.equal(s.pushes.length, 3);
  assert.ok(s.pushes.every(p => /^[0-9a-f]{32}$/.test(p.headers.Topic)), 'topics in the form Apple accepts');
  // Once per customer, ever: another run, or turning it off and on again, sends nothing new.
  s.app.exec("UPDATE app_marketing_prefs SET topics = '[]' WHERE user_id = 'user-A'");
  s.app.exec("UPDATE app_marketing_prefs SET topics = '[\"events\"]' WHERE user_id = 'user-A'");
  assert.equal((await sendWelcomeGifts(s.env, s.deps)).sent, 0);
  assert.equal((await welcomeForCustomer(s.env, 'A', s.now())).code, codes[0].code);
  assert.equal((await welcomeForCustomer(s.env, 'A', s.now())).description, 'a pre-roll for a penny');
  // A new subscriber after 8 pm waits for the morning.
  await s.optIn('D', ['rewards']); s.advance(11 * 3600000); // 9 pm
  assert.equal((await sendWelcomeGifts(s.env, s.deps)).sent, 0);
  s.advance(12 * 3600000); // 9 am
  assert.equal((await sendWelcomeGifts(s.env, s.deps)).sent, 1);
  // After the last day, nothing more is sent and codes stop showing in the app.
  await save({ ...offer, endsOn: '2026-10-02' });
  await s.optIn('E', ['rewards']); s.advance(DAY);
  assert.equal((await sendWelcomeGifts(s.env, s.deps)).sent, 0);
  assert.equal(await welcomeForCustomer(s.env, 'A', s.now()), null);
  assert.deepEqual(s.db.prepare("SELECT action FROM crm_audit WHERE action = 'welcome_gift'").all().length, 2);
  await s.call('forget', { customerId: 'B' });
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM crm_welcome_gifts WHERE customer_id = 'B'").get().n, 0);
});
