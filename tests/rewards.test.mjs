import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRewards, lookupVariables, normalizeInput } from '../server/rewards.mjs';

const migration = readFileSync(new URL('../migrations/0001_rewards_limits.sql', import.meta.url), 'utf8');
let sequence = 0;
class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(migration); }
  prepare(sql) {
    const database = this.db;
    return { bind(...values) {
      const statement = database.prepare(sql);
      return {
        async first() { return statement.get(...values) || null; },
        async run() {
          const results = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
          return { success: true, results };
        }
      };
    } };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT'); return results;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
function setup(options = {}) {
  const env = {
    REWARDS_ENABLED: 'true', REWARDS_ALLOWED_HOSTS: 'preview.example.test',
    GROWFLOW_ORG: 'integrations', GROWFLOW_PATIENT_ID_FIELD: 'PatientLicenseNumber',
    GROWFLOW_API_TOKEN: `gfr_test-only-secret-${++sequence}`,
    TURNSTILE_SITE_KEY: 'test-sitekey', TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    REWARDS_RATE_SECRET: 'test-only-hmac-secret-longer-than-32-characters', REWARDS_DB: new D1(),
    ...options.env
  };
  let time = 1800000000000;
  const calls = [];
  const deps = { now: () => time, fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('siteverify')) return Response.json(options.challenge || {
      success: true, hostname: 'preview.example.test', action: 'points-lookup'
    });
    assert.equal(url, 'https://retail.growflow.com/c/integrations/graphql');
    assert.equal(init.headers.Authorization, `Bearer ${env.GROWFLOW_API_TOKEN}`);
    if (options.upstreamError) throw new Error('SECRET upstream response with patient data');
    return Response.json(options.data || { data: { findCustomers: {
      edges: [{ node: { CurrentPoints: options.points ?? 225 } }], pageInfo: { hasNextPage: false }
    } } }, { status: options.status || 200, headers: options.headers || {} });
  } };
  async function run(input = {}, headers = {}, path = '/api/rewards/points', method = 'POST') {
    const request = new Request(`https://preview.example.test${path}`, {
      method, headers: { 'content-type': 'application/json', origin: 'https://preview.example.test',
        'cf-connecting-ip': '192.0.2.1', 'sec-fetch-site': 'same-origin', ...headers },
      ...(method === 'POST' ? { body: JSON.stringify({ name: 'Synthetic Patient', lastFive: '00001',
        turnstileToken: 'test-proof', ...input }) } : {})
    });
    const work = [];
    const response = await handleRewards({ request, env, waitUntil: p => work.push(p) }, deps);
    await Promise.all(work);
    return { response, body: await response.json() };
  }
  return { env, calls, run, advance: ms => { time += ms; } };
}

test('unique match returns only balance and never customer metadata', async () => {
  const s = setup(); const { response, body } = await s.run();
  assert.equal(response.status, 200); assert.deepEqual(body, { points: 225 });
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  const { query, variables } = JSON.parse(s.calls.find(x => x.url.endsWith('/graphql')).init.body);
  assert.match(query, /first: 2/);
  assert.match(query, /node \{ CurrentPoints \}/);
  assert.doesNotMatch(query, /Birthday|PhoneNumber|Email|objectId|mutation/);
  assert.deepEqual(variables.where.PatientLicenseNumber, { matchesRegex: '000-?01$', options: 'i' });
  assert.equal(variables.where.Name.matchesRegex, '^Synthetic Patient$');
  assert.equal(variables.where.IsDeleted.notEqualTo, true);
});

test('zero and fractional balances are valid; null never becomes zero', async () => {
  assert.deepEqual((await setup({ points: 0 }).run()).body, { points: 0 });
  assert.deepEqual((await setup({ points: 12.5 }).run()).body, { points: 12.5 });
  const s = setup({ data: { data: { findCustomers: {
    edges: [{ node: { CurrentPoints: null } }], pageInfo: { hasNextPage: false }
  } } } });
  assert.equal((await s.run()).response.status, 503);
});

test('regex metacharacters in names stay literal', () => {
  const input = normalizeInput({ name: 'Ana.* (Test)', lastFive: '00001', turnstileToken: 'proof' });
  assert.equal(lookupVariables(input, 'PatientLicenseNumber').where.Name.matchesRegex, '^Ana\\.\\* \\(Test\\)$');
});

test('invalid inputs never trigger customer lookup', async () => {
  for (const value of [{ lastFive: '.*123' }, { lastFive: 12345 }, { lastFive: '123456' },
    { name: 'A\nB' }, { name: [] }, { name: 'a'.repeat(121) }, { graphql: 'mutation {}' },
    { turnstileToken: '' }, { turnstileToken: 'x'.repeat(5000) }]) {
    const s = setup(); assert.equal((await s.run(value)).response.status, 400);
    assert.equal(s.calls.length, 0);
  }
});

test('zero, duplicate, partial and paginated matches all fail without revealing why', async () => {
  const cases = [[], [{ node: { CurrentPoints: 2 } }, { node: { CurrentPoints: 3 } }],
    [null, { node: { CurrentPoints: 3 } }]];
  const bodies = [];
  for (const edges of cases) {
    const s = setup({ data: { data: { findCustomers: { edges, pageInfo: { hasNextPage: false } } } } });
    const { response, body } = await s.run();
    assert.equal(response.status, 400); bodies.push(body);
  }
  assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(bodies[0], bodies[2]);
  const s = setup({ data: { data: { findCustomers: {
    edges: [{ node: { CurrentPoints: 3 } }], pageInfo: { hasNextPage: true }
  } } } });
  assert.deepEqual((await s.run()).body, bodies[0]);
});

test('missing config, unverified ID field and unknown hostname fail closed', async () => {
  for (const env of [{ REWARDS_ENABLED: 'false' }, { REWARDS_DB: null },
    { GROWFLOW_PATIENT_ID_FIELD: '' }, { GROWFLOW_PATIENT_ID_FIELD: 'objectId' },
    { REWARDS_ALLOWED_HOSTS: 'other.example.test' }, { GROWFLOW_API_TOKEN: '' },
    { GROWFLOW_API_TOKEN: 'old-oauth-credential' }, { GROWFLOW_API_TOKEN: 'gfr_unsafe\nheader' },
    { GROWFLOW_PATIENT_ID_FIELDS: 'PatientLicenseNumber,objectId' },
    { GROWFLOW_PATIENT_ID_FIELDS: 'PatientLicenseNumber,PatientLicenseNumber' },
    { REWARDS_RATE_SECRET: 'short' }]) {
    const s = setup({ env }); assert.equal((await s.run()).response.status, 503);
    const config = await s.run({}, {}, '/api/rewards/config', 'GET');
    assert.deepEqual(config.body, { enabled: false }); assert.equal(s.calls.length, 0);
  }
});

test('public config exposes only readiness and a public Turnstile sitekey', async () => {
  assert.deepEqual((await setup().run({}, {}, '/api/rewards/config', 'GET')).body,
    { enabled: true, siteKey: 'test-sitekey' });
});

test('foreign origin, missing origin and cross-site requests are rejected', async () => {
  for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
    const s = setup(); assert.equal((await s.run({}, headers)).response.status, 403);
    assert.equal(s.calls.length, 0);
  }
});

test('GET and query-string lookups are rejected', async () => {
  const s = setup();
  assert.equal((await s.run({}, {}, '/api/rewards/points', 'GET')).response.status, 405);
  assert.equal((await s.run({}, {}, '/api/rewards/points?name=test')).response.status, 400);
  assert.equal(s.calls.length, 0);
});

test('invalid, foreign-host and wrong-action bot proofs cannot query GrowFlow', async () => {
  for (const challenge of [{ success: false }, { success: true, hostname: 'other', action: 'points-lookup' },
    { success: true, hostname: 'preview.example.test', action: 'other' }]) {
    const s = setup({ challenge }); assert.equal((await s.run()).response.status, 400);
    assert.equal(s.calls.length, 1);
  }
});

test('IP limits still apply when names are rotated', async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) assert.equal((await s.run({ name: `Synthetic Person ${i}` })).response.status, 200);
  assert.equal((await s.run({ name: 'Synthetic Other' })).response.status, 429);
});

test('name limits apply across IPs and guessed suffixes', async () => {
  const s = setup();
  for (let i = 0; i < 5; i++) assert.equal((await s.run({ lastFive: `0000${i}` },
    { 'cf-connecting-ip': `192.0.2.${i}` })).response.status, 200);
  assert.equal((await s.run({ lastFive: '99999' }, { 'cf-connecting-ip': '192.0.2.200' })).response.status, 429);
  const records = s.env.REWARDS_DB.db.prepare('SELECT * FROM rewards_limits').all();
  assert.ok(records.every(row => /^[a-f0-9]{64}$/.test(row.key)));
  assert.doesNotMatch(JSON.stringify(records), /Synthetic|192\.0\.2|99999/);
});

test('deployment-wide points-query budget caps requests at 15 per minute', async () => {
  const s = setup();
  for (let i = 0; i < 15; i++) assert.equal((await s.run({ name: `Person ${i}` },
    { 'cf-connecting-ip': `192.0.2.${i}` })).response.status, 200);
  assert.equal((await s.run({ name: 'Person Extra' }, { 'cf-connecting-ip': '192.0.2.200' })).response.status, 429);
  assert.equal(s.calls.filter(c => c.url.endsWith('/graphql')).length, 15);
});

test('upstream failures and GraphQL errors never leak raw error text or partial points', async () => {
  for (const options of [{ upstreamError: true }, { status: 403, data: { error: 'SECRET detail' } },
    { data: { errors: [{ message: 'SECRET' }], data: { findCustomers: {
      edges: [{ node: { CurrentPoints: 123 } }], pageInfo: { hasNextPage: false }
    } } } }]) {
    const s = setup(options); const { response, body } = await s.run();
    assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(body), /SECRET|123/);
    assert.deepEqual(Object.keys(body), ['error']);
  }
});

test('low remaining GrowFlow quota and HTTP 429 cause shared backoff', async () => {
  for (const options of [{ headers: { 'ratelimit-remaining': '20', 'ratelimit-reset': '120' } },
    { status: 429, headers: { 'ratelimit-reset': '120' } }]) {
    const s = setup(options); await s.run();
    assert.equal((await s.run({ name: 'Another Patient' })).response.status, 503);
    assert.equal(s.calls.filter(c => c.url.endsWith('/graphql')).length, 1);
  }
});

test('limiter failure does not allow a lookup', async () => {
  const s = setup(); s.env.REWARDS_DB.batch = async () => { throw new Error('DB offline'); };
  assert.equal((await s.run()).response.status, 503); assert.equal(s.calls.length, 0);
});

test('self-service token goes only to GraphQL, with no OAuth exchange or refresh', async () => {
  const s = setup(); await s.run(); await s.run();
  assert.equal(s.calls.filter(c => c.url.endsWith('/graphql')).length, 2);
  assert.equal(s.calls.filter(c => c.url.includes('/oauth/token')).length, 0);
  const previousToken = s.env.GROWFLOW_API_TOKEN;
  s.env.GROWFLOW_API_TOKEN = 'gfr_rotated-test-only-secret';
  s.advance(3600000); const result = await s.run();
  assert.equal(result.response.status, 200);
  assert.equal(s.calls.filter(c => c.url.endsWith('/graphql')).at(-1).init.headers.Authorization,
    'Bearer gfr_rotated-test-only-secret');
  assert.doesNotMatch(JSON.stringify(result.body), /gfr_|secret/);
  const otherCalls = s.calls.filter(c => !c.url.endsWith('/graphql'));
  assert.ok(otherCalls.every(c => !String(c.init.body).includes(previousToken)
    && !String(c.init.body).includes(s.env.GROWFLOW_API_TOKEN)));
});

test('combined matching uses the exact successful Mac checker identity restrictions', async () => {
  const candidateFields = 'PatientLicenseNumber,MedicalLicenseNumber,CustomerStateLicense';
  const s = setup({ env: { GROWFLOW_PATIENT_ID_FIELDS: candidateFields } });
  const { response, body } = await s.run({ lastFive: 'abc-12' });
  assert.equal(response.status, 200); assert.deepEqual(body, { points: 225 });
  const { variables, query } = JSON.parse(s.calls.find(c => c.url.endsWith('/graphql')).init.body);
  assert.deepEqual(variables.where, {
    Name: { matchesRegex: '^Synthetic Patient$', options: 'i' },
    OR: candidateFields.split(',').map(field => ({ [field]: { matchesRegex: 'ABC-?12$', options: 'i' } })),
    IsDeleted: { notEqualTo: true }, IsAnon: { notEqualTo: true },
    Disabled: { notEqualTo: true }, Active: { notEqualTo: false }
  });
  assert.doesNotMatch(query, /PhoneNumber|objectId|PatientName|mutation/);
});

test('ambiguous matches across configured ID fields never return a balance', async () => {
  const s = setup({ env: { GROWFLOW_PATIENT_ID_FIELDS: 'PatientLicenseNumber,MedicalLicenseNumber,CustomerStateLicense' },
    data: { data: { findCustomers: { edges: [{ node: { CurrentPoints: 12 } }, { node: { CurrentPoints: 99 } }], pageInfo: { hasNextPage: false } } } } });
  const result = await s.run();
  assert.equal(result.response.status, 400); assert.deepEqual(Object.keys(result.body), ['error']);
});

test('revoked or insufficient-scope self-service tokens fail without retries or data leaks', async () => {
  for (const code of ['UNAUTHENTICATED', 'FORBIDDEN']) {
    const s = setup({ data: { errors: [{ message: 'gfr_PRIVATE_UPSTREAM_TOKEN', extensions: { code } }],
      data: { findCustomers: { edges: [{ node: { CurrentPoints: 789 } }], pageInfo: { hasNextPage: false } } } } });
    assert.equal((await s.run()).response.status, 503);
    const again = await s.run({ name: 'Another Person' });
    assert.equal(again.response.status, 503); assert.doesNotMatch(JSON.stringify(again.body), /gfr_|789/);
    assert.equal(s.calls.filter(c => c.url.endsWith('/graphql')).length, 1);
  }
});


test('alphanumeric ID suffixes accept the fixed dash and case variants without broad matching', async () => {
  for (const suffix of ['ZPA-NW', 'zpanw', 'ZpA-nW', 'AB1-02', '001-02']) {
    const input = normalizeInput({ name: 'Synthetic Patient', lastFive: suffix, turnstileToken: 'proof' });
    assert.ok(input);
    const filter = lookupVariables(input, 'PatientLicenseNumber').where.PatientLicenseNumber;
    const pattern = new RegExp(filter.matchesRegex, filter.options);
    const compact = suffix.replace('-', '');
    assert.ok(pattern.test(`PREFIX-${compact.slice(0, 3)}-${compact.slice(3)}`));
    assert.ok(pattern.test(`PREFIX-${compact.toLowerCase()}`));
    assert.equal(pattern.test(`PREFIX-${compact}9`), false);
    assert.equal(pattern.test(`PREFIX-${compact.slice(0, 2)}-${compact.slice(2)}`), false);
    assert.equal((await setup().run({ lastFive: suffix })).response.status, 200);
  }
  for (const lastFive of ['ZP-ANW', 'ZPA--NW', 'ZPA NW', 'ZPA_NW', 'ZPA.*', 'ABCDE\n', 'ＡBC12']) {
    const s = setup();
    assert.equal((await s.run({ lastFive })).response.status, 400);
    assert.equal(s.calls.length, 0);
  }
});
