import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, SCHEMA_QUERY, CUSTOMER_QUERY, ORDER_QUERY, DIAGNOSTIC_NAME_QUERY, DIAGNOSTIC_BOTH_QUERY } from '../scripts/mac-token-checker/check-core.mjs';
const fields = names => names.map(name => ({ name }));
const schema = {
  __schema: { queryType: { fields: fields(['findCustomers', 'findOrders']) } },
  customerOutput: { fields: fields(['objectId', 'CurrentPoints', 'PhoneNumber']) },
  customerFilters: { inputFields: fields(['Name', 'PatientName', 'OR', 'IsDeleted', 'IsAnon', 'Disabled', 'Active', 'PatientLicenseNumber', 'MedicalLicenseNumber', 'CustomerStateLicense']) },
  orderOutput: { fields: fields(['CompletedAt', 'Total', 'Status']) },
  orderFilters: { inputFields: fields(['OrderNumber']) },
  stringFilters: { inputFields: fields(['matchesRegex', 'options', 'equalTo']) },
  booleanFilters: { inputFields: fields(['notEqualTo']) },
};
const inputs = { token: 'gfr_FAKE_PRIVATE_TOKEN_SENTINEL', name: 'Synthetic (Private) Person', suffix: 'abc-12', expected: '12.5', receipt: 'RECEIPT-PRIVATE-001' };
const customer = { CurrentPoints: 12.5, PhoneNumber: '+15550001111' };
const order = { CompletedAt: '2026-09-01T12:00:00Z', Total: 987.65, Status: 'COMPLETED_PRIVATE_SENTINEL' };
const connection = node => ({ edges: [{ node }], pageInfo: { hasNextPage: false } });

async function exercise({ input = {}, modify = () => {}, diagnoseCustomer = false, baselineNoMatch = false } = {}) {
  const requests = [], messages = [], delays = [];
  const result = await runCheck({ ...inputs, ...input }, {
    log: line => messages.push(line), sleep: async ms => delays.push(ms), diagnoseCustomer,
    transport: async request => {
      requests.push(structuredClone(request));
      assert.equal(request.token, inputs.token);
      const response = { status: 200, headers: { 'ratelimit-limit': '120', 'ratelimit-remaining': '117', 'ratelimit-reset': '30', 'pagesize-limit': '100' } };
      let document;
      if (request.query === SCHEMA_QUERY) document = { data: structuredClone(schema) };
      else if (request.query === CUSTOMER_QUERY) {
        assert.equal(request.variables.where.Name.matchesRegex, '^Synthetic \\(Private\\) Person$');
        assert.deepEqual(request.variables.where.IsDeleted, { notEqualTo: true });
        assert.equal(request.variables.where.OR.length, 3);
        for (const filter of request.variables.where.OR) assert.deepEqual(Object.values(filter)[0], { matchesRegex: 'ABC-?12$', options: 'i' });
        document = { data: { findCustomers: connection(structuredClone(customer)) } };
        if (baselineNoMatch) document.data.findCustomers.edges = [];
      } else if ([DIAGNOSTIC_NAME_QUERY, DIAGNOSTIC_BOTH_QUERY].includes(request.query)) {
        const nameFields = request.query === DIAGNOSTIC_BOTH_QUERY ? [['byName', 'Name'], ['byPatientName', 'PatientName']] : [['byName', 'Name']];
        document = { data: {} };
        for (const [key, field] of nameFields) {
          const where = request.variables[key];
          assert.equal(where[field].matchesRegex, '^Synthetic \\(Private\\) Person$');
          assert.deepEqual(where.IsDeleted, { notEqualTo: true });
          assert.equal(where.OR.length, 3);
          for (const item of where.OR) assert.deepEqual(Object.values(item)[0], { matchesRegex: 'ABC-?12$', options: 'i' });
          for (const omitted of ['Active', 'Disabled', 'IsAnon']) assert.ok(!(omitted in where));
          document.data[key] = connection({ ...customer, objectId: 'PRIVATE_CUSTOMER_ID' });
        }
      } else if (request.query === ORDER_QUERY) {
        assert.deepEqual(request.variables.where, { OrderNumber: { equalTo: inputs.receipt } });
        document = { data: { findOrders: connection(structuredClone(order)) } };
      } else assert.fail('Unexpected operation');
      await modify(request, response, document);
      return { ...response, body: response.body ?? JSON.stringify(document) };
    },
  });
  const output = messages.join('\n');
  for (const secret of [inputs.token, inputs.name, inputs.receipt, 'ABC-?12$', '+15550001111', '12.5', '987.65', order.CompletedAt, order.Status, 'SENSITIVE_ERROR_SENTINEL', 'PRIVATE_CUSTOMER_ID', 'ANOTHER_PRIVATE_ID']) {
    assert.ok(!output.includes(secret), 'Private value leaked');
  }
  assert.ok(requests.length <= 3, 'Request budget exceeded');
  assert.equal(requests.length, result.calls);
  for (const request of requests.filter(r => r.query !== SCHEMA_QUERY)) assert.ok(request.variables.first > 0 && request.variables.first <= 2);
  return { output, requests, result, delays };
}
test('three narrow reads, hidden data, points match, no automatic retry', async () => {
  const r = await exercise();
  assert.equal(r.requests.length, 3); assert.match(r.output, /POINTS COMPARISON: MATCH/);
  assert.match(r.output, /PHONE: Nonempty/); assert.deepEqual(r.delays, [1000, 1000]);
});
test('customer-only and receipt-only need two calls; blank selection makes zero', async () => {
  assert.equal((await exercise({ input: { receipt: '' } })).requests.length, 2);
  assert.equal((await exercise({ input: { name: '' } })).requests.length, 2);
  assert.equal((await exercise({ input: { name: '', receipt: '' } })).requests.length, 0);
});
test('input failures make no API requests', async () => {
  for (const input of [{ token: 'old-secret' }, { token: 'gfr_a\nb' }, { suffix: 'AB12' }, { suffix: 'abc.*' }, { expected: 'NaN' }, { expected: 'Infinity' }, { expected: '1,000' }, { receipt: 'x\ny' }, { name: 'x\ny' }]) {
    const r = await exercise({ input }); assert.equal(r.requests.length, 0); assert.match(r.output, /INPUT:/);
  }
});
test('points comparison handles zero, mismatch and omitted expected balance', async () => {
  const zero = await exercise({ input: { expected: '0' }, modify: (q, _r, d) => { if (q.query === CUSTOMER_QUERY) d.data.findCustomers.edges[0].node.CurrentPoints = 0; } });
  assert.match(zero.output, /POINTS COMPARISON: MATCH/);
  assert.match((await exercise({ input: { expected: '999' } })).output, /POINTS COMPARISON: MISMATCH/);
  assert.match((await exercise({ input: { expected: '' } })).output, /POINTS COMPARISON: Skipped/);
});
test('blank, duplicate, paginated and incomplete customer results never report verified values', async () => {
  for (const variant of ['empty', 'duplicate', 'more', 'missing-page', 'missing-node']) {
    const r = await exercise({ modify: (q, _r, d) => {
      if (q.query !== CUSTOMER_QUERY) return;
      const c = d.data.findCustomers;
      if (variant === 'empty') c.edges = [];
      if (variant === 'duplicate') c.edges.push(c.edges[0]);
      if (variant === 'more') c.pageInfo.hasNextPage = true;
      if (variant === 'missing-page') delete c.pageInfo;
      if (variant === 'missing-node') delete c.edges[0].node;
    } });
    assert.doesNotMatch(r.output, /POINTS: Numeric|PHONE: Nonempty/); assert.equal(r.requests.length, 3);
  }
});
test('null/string balances and empty phone do not claim usable values', async () => {
  for (const points of [null, '12.5']) {
    const r = await exercise({ modify: (q, _r, d) => { if (q.query === CUSTOMER_QUERY) d.data.findCustomers.edges[0].node = { CurrentPoints: points, PhoneNumber: '' }; } });
    assert.match(r.output, /POINTS: Missing or nonnumeric/); assert.match(r.output, /PHONE: Empty/);
  }
});
test('revoked token stops; customer scope rejection only allows independent selected-receipt check', async () => {
  for (const code of ['UNAUTHENTICATED', 'FORBIDDEN']) {
    const r = await exercise({ modify: (q, _r, d) => {
      if (q.query === CUSTOMER_QUERY) d.errors = [{ message: 'SENSITIVE_ERROR_SENTINEL', extensions: { code } }];
    } });
    assert.equal(r.requests.length, code === 'UNAUTHENTICATED' ? 2 : 3);
    assert.doesNotMatch(r.output, /POINTS: Numeric/); assert.ok(r.output.includes(code));
  }
});
test('partial GraphQL data with errors never passes field checks', async () => {
  const r = await exercise({ modify: (q, _r, d) => { if (q.query === CUSTOMER_QUERY) d.errors = [{ message: 'SENSITIVE_ERROR_SENTINEL' }]; } });
  assert.doesNotMatch(r.output, /POINTS: Numeric/);
});
test('HTTP failures, 429 and redirects stop without any retry', async () => {
  for (const status of [301, 302, 400, 401, 403, 429, 500]) {
    const r = await exercise({ modify: (_q, res) => { res.status = status; res.body = 'SENSITIVE_ERROR_SENTINEL'; if (status === 429) res.headers['retry-after'] = '45'; } });
    assert.equal(r.requests.length, 1); assert.match(r.output, /HTTP STATUS:/);
  }
});
test('quota, retry advice and zero page cap prevent further calls', async () => {
  for (const pair of [['ratelimit-remaining','5'], ['Retry-After','60'], ['pagesize-limit','0'], ['ratelimit-limit','0']]) {
    const r = await exercise({ modify: (_q, res) => { res.headers[pair[0]] = pair[1]; } });
    assert.equal(r.requests.length, 1); assert.match(r.output, /LIMIT: Stopping/);
  }
});
test('page cap one and lower request limit are respected', async () => {
  const r = await exercise({ modify: (q, res) => {
    res.headers['pagesize-limit'] = '1'; res.headers['ratelimit-limit'] = '10';
    if (q.query !== SCHEMA_QUERY) assert.equal(q.variables.first, 1);
  } });
  assert.deepEqual(r.delays, [6000,6000]);
});
test('malicious header content and errors cannot enter status output', async () => {
  const r = await exercise({ modify: (_q, res) => { res.headers['retry-after'] = 'SENSITIVE_ERROR_SENTINEL'; res.headers.extra = inputs.token; } });
  assert.equal(r.requests.length, 3);
  const failed = await exercise({ modify: () => { throw new Error(inputs.token + ' SENSITIVE_ERROR_SENTINEL'); } });
  assert.equal(failed.requests.length, 1); assert.match(failed.output, /Raw error suppressed/);
});
test('malformed JSON and incomplete schema stop safely', async () => {
  const invalid = await exercise({ modify: (_q, res) => { res.body = 'SENSITIVE_ERROR_SENTINEL'; } });
  assert.equal(invalid.requests.length, 1);
  const absent = await exercise({ modify: (_q, _r, d) => { delete d.data.__schema; } });
  assert.equal(absent.requests.length, 1); assert.match(absent.output, /Incomplete metadata/);
});
test('missing customer fields skip that read, without loosening the lookup', async () => {
  const r = await exercise({ modify: (q, _r, d) => { if (q.query === SCHEMA_QUERY) d.data.customerFilters.inputFields = []; } });
  assert.equal(r.requests.length, 2); assert.match(r.output, /CUSTOMER: Required schema fields missing/);
});
test('diagnostic mode stops on original success and never repeats receipt access', async () => {
  const r = await exercise({ diagnoseCustomer: true });
  assert.equal(r.requests.length, 2); assert.match(r.output, /POINTS COMPARISON: MATCH/);
  assert.match(r.output, /ORDER: Not repeated/);
});
test('zero-match diagnostic isolates name choice and optional status filters', async () => {
  const status = await exercise({ diagnoseCustomer: true, baselineNoMatch: true });
  assert.equal(status.requests.length, 3); assert.match(status.output, /Name matched after status restrictions/);
  assert.match(status.output, /POINTS COMPARISON: MATCH/);
  const patientName = await exercise({ diagnoseCustomer: true, baselineNoMatch: true, modify: (q, _r, d) => {
    if (q.query === DIAGNOSTIC_BOTH_QUERY) d.data.byName.edges = [];
  } });
  assert.match(patientName.output, /PatientName matched; Name did not/);
  assert.match(patientName.output, /POINTS COMPARISON: MATCH/);
});
test('different, ambiguous, paginated or incomplete diagnostic identities suppress values', async () => {
  for (const problem of ['different-id', 'duplicate', 'more', 'incomplete', 'missing-id']) {
    const r = await exercise({ diagnoseCustomer: true, baselineNoMatch: true, modify: (q, _r, d) => {
      if (q.query !== DIAGNOSTIC_BOTH_QUERY) return;
      const c = d.data.byPatientName;
      if (problem === 'different-id') c.edges[0].node.objectId = 'ANOTHER_PRIVATE_ID';
      if (problem === 'duplicate') c.edges.push(c.edges[0]);
      if (problem === 'more') c.pageInfo.hasNextPage = true;
      if (problem === 'incomplete') delete c.pageInfo;
      if (problem === 'missing-id') delete c.edges[0].node.objectId;
    } });
    assert.equal(r.requests.length, 3); assert.match(r.output, /DIAGNOSTIC: Ambiguous or incomplete/);
    assert.doesNotMatch(r.output, /POINTS: Numeric|PHONE: Nonempty/);
  }
});
test('zero comparison results keep values unverified', async () => {
  const r = await exercise({ diagnoseCustomer: true, baselineNoMatch: true, modify: (q, _r, d) => {
    if (q.query === DIAGNOSTIC_BOTH_QUERY) { d.data.byName.edges = []; d.data.byPatientName.edges = []; }
  } });
  assert.match(r.output, /No name\/ID match/); assert.doesNotMatch(r.output, /POINTS: Numeric/);
});
test('permission rejection, quota stop or ambiguous initial result never triggers a diagnostic read', async () => {
  for (const problem of ['denied', 'quota', 'duplicate', 'missing-page']) {
    const r = await exercise({ diagnoseCustomer: true, baselineNoMatch: problem === 'quota', modify: (q, res, d) => {
      if (q.query !== CUSTOMER_QUERY) return;
      if (problem === 'denied') d.errors = [{ extensions: { code: 'FORBIDDEN' } }];
      if (problem === 'quota') res.headers['ratelimit-remaining'] = '0';
      if (problem === 'duplicate') d.data.findCustomers.edges.push(d.data.findCustomers.edges[0]);
      if (problem === 'missing-page') delete d.data.findCustomers.pageInfo;
    } });
    assert.equal(r.requests.length, 2);
    assert.ok(r.requests.every(q => ![DIAGNOSTIC_NAME_QUERY, DIAGNOSTIC_BOTH_QUERY, ORDER_QUERY].includes(q.query)));
  }
});
test('missing PatientName uses only supported field; missing objectId cancels comparison', async () => {
  const nameOnly = await exercise({ diagnoseCustomer: true, baselineNoMatch: true, modify: (q, _r, d) => {
    if (q.query === SCHEMA_QUERY) d.data.customerFilters.inputFields = d.data.customerFilters.inputFields.filter(f => f.name !== 'PatientName');
  } });
  assert.equal(nameOnly.requests[2].query, DIAGNOSTIC_NAME_QUERY); assert.match(nameOnly.output, /POINTS COMPARISON: MATCH/);
  const noId = await exercise({ diagnoseCustomer: true, baselineNoMatch: true, modify: (q, _r, d) => {
    if (q.query === SCHEMA_QUERY) d.data.customerOutput.fields = d.data.customerOutput.fields.filter(f => f.name !== 'objectId');
  } });
  assert.equal(noId.requests.length, 2); assert.match(noId.output, /identifier field missing/);
});
