import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { handleCrm } from '../server/crm/index.mjs';
import { runSync, purge } from '../server/crm/sync.mjs';
import { validateDefinition, compile } from '../server/crm/segments.mjs';
import { hash } from '../server/customer-app/http.mjs';
import { sendCampaigns, validateCampaign } from '../server/crm/campaigns.mjs';

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
        : op === 'greaterThanOrEqualTo' ? v >= x : false); });
    const keys = variables.order.map(o => o.replace('_ASC', ''));
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
