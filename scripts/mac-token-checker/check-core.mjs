// Private, owner-operated diagnostic. Never import this into a public web page.
export const ENDPOINT = 'https://retail.growflow.com/c/holysmokesdispensary/graphql';
export const SCHEMA_QUERY = `query TreehouseTokenSchema {
  __schema { queryType { fields { name } } }
  customerOutput: __type(name: "Customers") { fields { name } }
  customerFilters: __type(name: "CustomersWhereInput") { inputFields { name } }
  orderOutput: __type(name: "Orders") { fields { name } }
  orderFilters: __type(name: "OrdersWhereInput") { inputFields { name } }
  stringFilters: __type(name: "StringWhereInput") { inputFields { name } }
  booleanFilters: __type(name: "BooleanWhereInput") { inputFields { name } }
}`;
export const CUSTOMER_QUERY = `query TreehouseTokenCustomer($where: CustomersWhereInput!, $first: Int!) {
  findCustomers(where: $where, first: $first) {
    pageInfo { hasNextPage }
    edges { node { CurrentPoints PhoneNumber } }
  }
}`;
export const ORDER_QUERY = `query TreehouseTokenOrder($where: OrdersWhereInput!, $first: Int!) {
  findOrders(where: $where, first: $first) {
    pageInfo { hasNextPage }
    edges { node { CompletedAt Total Status } }
  }
}`;
export const DIAGNOSTIC_NAME_QUERY = `query TreehouseCustomerNameDiagnostic($byName: CustomersWhereInput!, $first: Int!) {
  byName: findCustomers(where: $byName, first: $first) {
    pageInfo { hasNextPage }
    edges { node { objectId CurrentPoints PhoneNumber } }
  }
}`;
export const DIAGNOSTIC_BOTH_QUERY = `query TreehouseCustomerNamesDiagnostic($byName: CustomersWhereInput!, $byPatientName: CustomersWhereInput!, $first: Int!) {
  byName: findCustomers(where: $byName, first: $first) {
    pageInfo { hasNextPage }
    edges { node { objectId CurrentPoints PhoneNumber } }
  }
  byPatientName: findCustomers(where: $byPatientName, first: $first) {
    pageInfo { hasNextPage }
    edges { node { objectId CurrentPoints PhoneNumber } }
  }
}`;
const has = (fields, name) => Array.isArray(fields) && fields.some(f => f?.name === name);
const all = (fields, names) => names.every(name => has(fields, name));
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const forbiddenControls = /[\x00-\x1f\x7f]/;
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function validateInputs(input) {
  const token = String(input.token ?? '').trim();
  let name = String(input.name ?? '').trim();
  const suffix = String(input.suffix ?? '').trim();
  const expected = String(input.expected ?? '').trim();
  const receipt = String(input.receipt ?? '').trim();
  if (!token.startsWith('gfr_') || token.length <= 4 || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) {
    return { error: 'INPUT: Enter the new gfr_ token only, without Bearer or quotation marks.' };
  }
  if (!name && !receipt) return { error: 'No record selected; no API requests made.' };
  if (name && (name.length < 3 || name.length > 120 || forbiddenControls.test(name) || !/^[A-Za-z0-9]{3}-?[A-Za-z0-9]{2}$/.test(suffix))) {
    return { error: 'INPUT: Check the full name and final five letters/numbers. The dash is optional.' };
  }
  if (name && expected && (!numeric.test(expected) || !Number.isFinite(Number(expected)))) {
    return { error: 'INPUT: Use a numeric current points balance without commas, or leave it blank.' };
  }
  if (receipt.length > 100 || forbiddenControls.test(receipt)) return { error: 'INPUT: Check the exact receipt/order number.' };
  name = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return { token, name, suffix: suffix.replace('-', '').toUpperCase(), expected: name && expected ? Number(expected) : null, receipt };
}

// Dependency injection is used only by local tests. The CLI pins a single HTTPS destination.
export async function runCheck(input, { transport, log, diagnoseCustomer = false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const state = { calls: 0, stopped: false, pageSize: 100, delayMs: 1000 };
  const values = validateInputs(input);
  function limits(headers = {}) {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    for (const label of ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After', 'PageSize-Limit']) {
      const raw = normalized[label.toLowerCase()];
      const text = String(Array.isArray(raw) ? raw[0] : raw ?? '');
      if (!/^\d{1,10}$/.test(text)) continue;
      const n = Number(text);
      log(`LIMIT: ${label} = ${n}`);
      if (label === 'PageSize-Limit') state.pageSize = Math.min(100, n);
      if (label === 'RateLimit-Limit' && n > 0) state.delayMs = Math.max(1000, Math.ceil(60000 / n));
      if ((label === 'RateLimit-Remaining' && n <= 5) || (label === 'Retry-After' && n > 0) ||
          (label === 'RateLimit-Limit' && n === 0) || (label === 'PageSize-Limit' && n === 0)) {
        state.stopped = true;
        log('LIMIT: Stopping before any further request. No automatic retry.');
      }
    }
  }
  function graphqlErrors(errors) {
    if (!Array.isArray(errors)) { log('API DETAIL: Unexpected GraphQL error format.'); state.stopped = true; return; }
    for (const error of errors.slice(0, 10)) {
      const code = error?.extensions?.code;
      const message = String(error?.message ?? '');
      let detail = 'Unclassified GraphQL rejection';
      if (code === 'UNAUTHENTICATED' || /invalid or revoked api token/i.test(message)) {
        detail = 'Token rejected; check token status and expiration'; state.stopped = true;
      } else if (code === 'RATE_LIMITED' || /rate limit|too many requests/i.test(message)) {
        detail = 'Rate limited; wait before another run'; state.stopped = true;
      } else if (code === 'FORBIDDEN' || /permission|forbidden|access denied|unauthori[sz]ed/i.test(message)) {
        detail = 'Permission rejected; check Read scopes and selected stores';
      } else if (/cannot query field|unknown (type|argument)|not defined by type|expected type|validation/i.test(message)) {
        detail = 'Schema or input mismatch; share these status lines for review';
      }
      log(`API DETAIL: ${detail}`);
      if (['UNAUTHENTICATED', 'FORBIDDEN', 'RATE_LIMITED', 'GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_USER_INPUT', 'INTERNAL_SERVER_ERROR'].includes(code)) log(`API CODE: ${code}`);
      for (const location of Array.isArray(error?.locations) ? error.locations.slice(0, 5) : []) {
        if (Number.isInteger(location?.line) && location.line > 0 && location.line < 100000 && Number.isInteger(location?.column) && location.column > 0 && location.column < 100000) {
          log(`QUERY LOCATION: line ${location.line}, column ${location.column}`);
        }
      }
    }
  }
  async function request(label, query, variables = {}) {
    if (state.stopped || state.calls >= 3) return null;
    if (state.calls) await sleep(state.delayMs);
    log(`CHECK: ${label}`);
    state.calls++;
    try {
      const response = await transport({ token: values.token, query, variables });
      limits(response.headers);
      if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
        if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) log(`HTTP STATUS: ${response.status}`);
        log('STOP: HTTP rejection. No redirect or automatic retry.'); state.stopped = true; return null;
      }
      const decoded = JSON.parse(response.body);
      if (decoded?.errors && (!Array.isArray(decoded.errors) || decoded.errors.length)) { graphqlErrors(decoded.errors); return null; }
      if (!decoded?.data || typeof decoded.data !== 'object') { log('RESULT: Expected data missing.'); return null; }
      return decoded.data;
    } catch {
      log('STOP: Network, timeout, or invalid-response failure. Raw error suppressed.'); state.stopped = true; return null;
    }
  }
  function unique(connection, label) {
    if (!Array.isArray(connection?.edges) || typeof connection?.pageInfo?.hasNextPage !== 'boolean') {
      log(`${label}: Incomplete response; record access not confirmed.`); return null;
    }
    if (connection.pageInfo.hasNextPage || connection.edges.length > 1) {
      log(`${label}: Multiple matches; values suppressed.`); return null;
    }
    if (!connection.edges.length) { log(`${label}: Query accepted, no match. Record values not verified.`); return null; }
    const node = connection.edges[0]?.node;
    if (!node || typeof node !== 'object' || Array.isArray(node)) { log(`${label}: Missing record; access not confirmed.`); return null; }
    log(`${label}: Unique record returned; values suppressed.`);
    return node;
  }
  function showCustomerValues(customer) {
    if (typeof customer.CurrentPoints === 'number' && Number.isFinite(customer.CurrentPoints)) {
      log('POINTS: Numeric current balance returned; value suppressed.');
      if (values.expected === null) log('POINTS COMPARISON: Skipped; no expected balance entered.');
      else if (Math.abs(customer.CurrentPoints - values.expected) < 0.000001) log('POINTS COMPARISON: MATCH with the balance you entered.');
      else log('POINTS COMPARISON: MISMATCH. Review the record before enabling lookup.');
    } else log('POINTS: Missing or nonnumeric balance; a usable balance is not confirmed.');
    log(typeof customer.PhoneNumber === 'string' && customer.PhoneNumber.trim()
      ? 'PHONE: Nonempty phone value returned; number suppressed.' : 'PHONE: Empty or missing; a usable number is not confirmed.');
  }
  async function diagnoseMatching(schema, originalWhere) {
    // Only an accepted, complete ZERO-match result may reach here. A rejection,
    // ambiguity, missing data, or quota stop never triggers another customer query.
    if (!has(schema.customerOutput?.fields, 'objectId')) {
      log('DIAGNOSTIC: Required record identifier field missing; comparison skipped.'); return;
    }
    const byName = { Name: originalWhere.Name, OR: originalWhere.OR, IsDeleted: { notEqualTo: true } };
    const hasPatientName = has(schema.customerFilters?.inputFields, 'PatientName');
    const variables = { byName, first: Math.min(2, state.pageSize) };
    if (hasPatientName) variables.byPatientName = { PatientName: originalWhere.Name, OR: originalWhere.OR, IsDeleted: { notEqualTo: true } };
    log('DIAGNOSTIC: Keeping name AND patient-ID ending. Excluding deleted records.');
    log('DIAGNOSTIC: Comparing name fields without Active, Disabled, or IsAnon restrictions.');
    const data = await request('Customer name/status comparison (up to two bounded reads in one request)',
      hasPatientName ? DIAGNOSTIC_BOTH_QUERY : DIAGNOSTIC_NAME_QUERY, variables);
    if (!data) { log('DIAGNOSTIC: Comparison unavailable; no further customer query attempted.'); return; }
    const paths = hasPatientName ? [['byName', 'Name'], ['byPatientName', 'PatientName']] : [['byName', 'Name']];
    const nodes = [];
    let ambiguous = false;
    for (const [key, label] of paths) {
      const connection = data[key];
      const node = unique(connection, 'DIAG ' + label);
      const complete = Array.isArray(connection?.edges) && typeof connection?.pageInfo?.hasNextPage === 'boolean';
      if (!complete || connection.pageInfo.hasNextPage || connection.edges.length > 1 ||
          (connection.edges.length === 1 && (typeof node?.objectId !== 'string' || !node.objectId))) ambiguous = true;
      if (node && typeof node.objectId === 'string' && node.objectId) nodes.push({ node, label });
    }
    if (!hasPatientName) log('DIAG PatientName: Filter absent from the live schema; not attempted.');
    if (ambiguous || new Set(nodes.map(item => item.node.objectId)).size > 1) {
      log('DIAGNOSTIC: Ambiguous or incomplete identity match; all record values suppressed.'); return;
    }
    if (!nodes.length) {
      log('DIAGNOSTIC: No name/ID match with status restrictions omitted. Check stored name and patient-ID ending locally.'); return;
    }
    if (nodes.some(item => item.label === 'Name')) {
      log('DIAGNOSTIC: Name matched after status restrictions were omitted; a status filter may have excluded the earlier result.');
    } else {
      log('DIAGNOSTIC: PatientName matched; Name did not. Name-field choice and/or status restrictions need review.');
    }
    showCustomerValues(nodes[0].node);
    log('DIAGNOSTIC: Sample access only; this does not establish eligibility or approve public lookup rules.');
  }
  try {
    if (values.error) { log(values.error); return state; }
    if (diagnoseCustomer && !values.name) { log('DIAGNOSTIC: A selected customer name and patient-ID ending are required. No calls made.'); return state; }
    log('PASS: Input format accepted. Token access has not yet been verified.');
    const schema = await request('Live schema metadata using the new token', SCHEMA_QUERY);
    if (!schema) return state;
    if (!Array.isArray(schema.__schema?.queryType?.fields)) { log('SCHEMA: Incomplete metadata; no record query attempted.'); return state; }
    log('PASS: Schema returned. This alone does not establish customer or order permissions.');
    for (const field of ['CurrentPoints', 'PhoneNumber', 'SMSConsent']) log(`SCHEMA: Customers.${field} = ${has(schema.customerOutput?.fields, field) ? 'present' : 'absent'}`);
    if (state.stopped) return state;
    if (values.name) {
      const idFields = ['PatientLicenseNumber', 'MedicalLicenseNumber', 'CustomerStateLicense'].filter(field => has(schema.customerFilters?.inputFields, field));
      const ready = has(schema.__schema.queryType.fields, 'findCustomers') && idFields.length &&
        all(schema.customerFilters?.inputFields, ['Name', 'OR', 'IsDeleted']) &&
        all(schema.customerOutput?.fields, ['CurrentPoints', 'PhoneNumber']) &&
        all(schema.stringFilters?.inputFields, ['matchesRegex', 'options']) && has(schema.booleanFilters?.inputFields, 'notEqualTo');
      if (ready) {
        const where = {
          Name: { matchesRegex: '^' + escapeRegex(values.name) + '$', options: 'i' },
          OR: idFields.map(field => ({ [field]: { matchesRegex: values.suffix.slice(0, 3) + '-?' + values.suffix.slice(3) + '$', options: 'i' } })),
          IsDeleted: { notEqualTo: true },
        };
        for (const field of ['IsAnon', 'Disabled']) if (has(schema.customerFilters.inputFields, field)) where[field] = { notEqualTo: true };
        if (has(schema.customerFilters.inputFields, 'Active')) where.Active = { notEqualTo: false };
        const result = await request('Selected customer points and phone permission', CUSTOMER_QUERY, { where, first: Math.min(2, state.pageSize) });
        if (result) {
          const customer = unique(result.findCustomers, 'CUSTOMER');
          if (customer) {
            showCustomerValues(customer);
          } else if (diagnoseCustomer && !state.stopped &&
              result.findCustomers?.pageInfo?.hasNextPage === false &&
              Array.isArray(result.findCustomers?.edges) && result.findCustomers.edges.length === 0) {
            await diagnoseMatching(schema, where);
          }
        } else log('CUSTOMER: Read access not confirmed. No alternative customer route attempted.');
      } else log('CUSTOMER: Required schema fields missing; test skipped.');
    } else log('CUSTOMER: Skipped by operator.');
    if (diagnoseCustomer) { log('ORDER: Not repeated in customer diagnostic mode.'); return state; }
    if (state.stopped) return state;
    if (values.receipt) {
      const ready = has(schema.__schema.queryType.fields, 'findOrders') && has(schema.orderFilters?.inputFields, 'OrderNumber') &&
        all(schema.orderOutput?.fields, ['CompletedAt', 'Total', 'Status']) && has(schema.stringFilters?.inputFields, 'equalTo');
      if (ready) {
        const where = { OrderNumber: { equalTo: values.receipt } };
        if (has(schema.orderFilters.inputFields, 'IsDeleted') && has(schema.booleanFilters?.inputFields, 'notEqualTo')) where.IsDeleted = { notEqualTo: true };
        else log('ORDER FILTER: IsDeleted unavailable; historical/deleted status is not excluded.');
        const result = await request('Selected receipt permission', ORDER_QUERY, { where, first: Math.min(2, state.pageSize) });
        if (result) {
          const order = unique(result.findOrders, 'ORDER');
          if (order) for (const field of ['CompletedAt', 'Total', 'Status']) log(`ORDER FIELD: ${field} = ${order[field] != null ? 'returned (value suppressed)' : 'null or missing'}`);
        } else log('ORDER: Read access not confirmed.');
      } else log('ORDER: Required schema fields missing; test skipped.');
    } else log('ORDER: Skipped by operator.');
    return state;
  } finally {
    log(`REQUESTS MADE: ${state.calls} of maximum 3. No automatic retries.`);
    log('Sample access only. Full history, order items, identity linkage, and marketing consent are not verified.');
    log('No records were changed and no messages or contacts were sent to a marketing provider.');
    log('Share only these status lines. Do not share your token or patient details.');
    for (const key of Object.keys(values)) values[key] = null;
  }
}
