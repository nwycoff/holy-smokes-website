// Compares the live GrowFlow schema with what the customer app's preorder code sends.
// Reads type definitions only (introspection) plus one status lookup for a made-up
// order ID to confirm the token's scope. No customer, order or menu data is requested.
const REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
export const SCHEMA_QUERY = `query TreehousePreorderSchema {
  queryType: __type(name: "Query") { fields { name args { name type { ${REF} } } type { ${REF} } } }
  mutationType: __type(name: "Mutation") { fields { name args { name type { ${REF} } } type { ${REF} } } }
  customers: __type(name: "Customers") { fields { name type { ${REF} } } }
  customerFilters: __type(name: "CustomersWhereInput") { inputFields { name } }
  preorderInput: __type(name: "PreorderInput") { inputFields { name type { ${REF} } } }
  customerInput: __type(name: "CustomerInput") { inputFields { name type { ${REF} } } }
  orderItemInput: __type(name: "OrderItemInput") { inputFields { name type { ${REF} } } }
  preorderType: __type(name: "PreorderType") { enumValues { name } }
  customerTypes: __type(name: "CustomerTypes") { enumValues { name } }
  preorderStatuses: __type(name: "PreorderStatuses") { enumValues { name } }
  createResponse: __type(name: "CreatePreorderResponse") { fields { name type { ${REF} } } }
  preorderResponse: __type(name: "PreorderResponse") { fields { name type { ${REF} } } }
}`;
export const PROBE_QUERY = `query TreehousePreorderScopeProbe($orderId: String!) {
  preorderStatus(orderId: $orderId) { success }
}`;
export const PROBE_ORDER_ID = 'treehouse-schema-check-not-a-real-order';

// Exactly what server/customer-app sends and reads.
const SENT = {
  preorderInput: ['preOrderType', 'preOrderTotal', 'customer', 'orderItems', 'nameForOrder', 'preOrderNote'],
  customerInput: ['id', 'type', 'firstName', 'lastName', 'dob'],
  orderItemInput: ['productId', 'qty', 'weight']
};
const CUSTOMER_FIELDS = ['objectId', 'Name', 'Birthday', 'CustomerType', 'CurrentPoints'];
const CUSTOMER_FILTERS = ['objectId', 'IsDeleted', 'IsAnon', 'Disabled', 'Active'];
const KNOWN_STATUSES = ['New', 'Pending', 'Completed', 'Canceled', 'Unfulfilled', 'Held', 'InTransit', 'Fulfilled', 'Cart'];

export function typeName(t) {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${typeName(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeName(t.ofType)}]`;
  return t.name || '?';
}
const named = t => t?.kind === 'NON_NULL' || t?.kind === 'LIST' ? named(t.ofType) : t?.name;
const byName = list => new Map((list || []).map(item => [item.name, item]));

export function compareSchema(data) {
  const lines = [];
  let problems = 0;
  const ok = text => lines.push(`OK    ${text}`);
  const diff = text => { problems++; lines.push(`DIFF  ${text}`); };
  const note = text => lines.push(`NOTE  ${text}`);

  const operation = (group, name, args, returns) => {
    const field = byName(data?.[`${group}Type`]?.fields).get(name);
    if (!field) { diff(`${group} ${name} is missing from the live schema.`); return null; }
    const actualArgs = byName(field.args);
    const signature = `${name}(${(field.args || []).map(a => `${a.name}: ${typeName(a.type)}`).join(', ')}) → ${typeName(field.type)}`;
    const missing = args.filter(a => !actualArgs.has(a));
    const extraRequired = (field.args || []).filter(a => a.type?.kind === 'NON_NULL' && !args.includes(a.name));
    if (missing.length || extraRequired.length || named(field.type) !== returns)
      diff(`${group} ${signature}; app expects arguments ${args.join(', ')} returning ${returns}.`);
    else ok(`${group} ${signature}`);
    return field;
  };
  operation('mutation', 'createPreorder', ['menuKey', 'preorder'], 'CreatePreorderResponse');
  operation('query', 'preorderStatus', ['orderId'], 'CreatePreorderResponse');
  operation('query', 'findCustomers', ['where', 'first'], named(byName(data?.queryType?.fields).get('findCustomers')?.type) || '?');

  for (const [key, label] of [['preorderInput', 'PreorderInput'], ['customerInput', 'CustomerInput'], ['orderItemInput', 'OrderItemInput']]) {
    const fields = data?.[key]?.inputFields;
    if (!fields) { diff(`${label} type is missing from the live schema.`); continue; }
    const map = byName(fields);
    for (const name of SENT[key]) {
      if (map.has(name)) ok(`${label}.${name}: ${typeName(map.get(name).type)}`);
      else diff(`${label}.${name} does not exist, but the app sends it.`);
    }
    for (const field of fields) if (field.type?.kind === 'NON_NULL' && !SENT[key].includes(field.name))
      diff(`${label}.${field.name}: ${typeName(field.type)} is required, but the app does not send it.`);
    const unused = fields.filter(f => f.type?.kind !== 'NON_NULL' && !SENT[key].includes(f.name)).map(f => f.name);
    if (unused.length) note(`${label} optional fields the app leaves out: ${unused.join(', ')}`);
  }

  const enumCheck = (key, label, required) => {
    const values = (data?.[key]?.enumValues || []).map(v => v.name);
    if (!values.length) { diff(`${label} enum is missing from the live schema.`); return values; }
    const missing = required.filter(v => !values.includes(v));
    if (missing.length) diff(`${label} lacks ${missing.join(', ')}; values are ${values.join(', ')}.`);
    else ok(`${label}: ${values.join(', ')}`);
    return values;
  };
  enumCheck('preorderType', 'PreorderType', ['Pickup']);
  enumCheck('customerTypes', 'CustomerTypes', ['Medical', 'Recreational']);
  const statuses = enumCheck('preorderStatuses', 'PreorderStatuses', ['Completed', 'Canceled']);
  const unknown = statuses.filter(s => !KNOWN_STATUSES.includes(s));
  if (unknown.length) note(`Statuses the app has no wording for (treated as open orders): ${unknown.join(', ')}`);

  const responseFields = (key, label, wanted) => {
    const map = byName(data?.[key]?.fields);
    if (!map.size) { diff(`${label} type is missing from the live schema.`); return; }
    const missing = wanted.filter(w => !map.has(w));
    if (missing.length) diff(`${label} lacks ${missing.join(', ')}.`);
    else ok(`${label}: ${wanted.map(w => `${w}: ${typeName(map.get(w).type)}`).join(', ')}`);
  };
  responseFields('createResponse', 'CreatePreorderResponse', ['success', 'order']);
  responseFields('preorderResponse', 'PreorderResponse', ['id', 'orderNumber', 'status']);

  const customers = byName(data?.customers?.fields);
  if (!customers.size) diff('Customers type is missing from the live schema.');
  for (const name of CUSTOMER_FIELDS) {
    if (customers.has(name)) ok(`Customers.${name}: ${typeName(customers.get(name).type)}`);
    else if (customers.size) diff(`Customers.${name} does not exist, but the app reads it.`);
  }
  const lookalikes = [...customers.keys()].filter(n => !CUSTOMER_FIELDS.includes(n)
    && /name$|birth|dob|customertype/i.test(n));
  if (lookalikes.length) note(`Other name/birth/type fields on Customers (names only): ${lookalikes.join(', ')}`);
  // GrowFlow requires customer.medicalLicenseNumber for medical preorders.
  const licenses = [...customers.keys()].filter(n => /licen|patient|medical/i.test(n));
  note(licenses.length ? `Readable license/patient fields on Customers: ${licenses.join(', ')}`
    : 'Customers exposes no readable license/patient fields (search filters only).');
  const filters = new Set((data?.customerFilters?.inputFields || []).map(f => f.name));
  const missingFilters = CUSTOMER_FILTERS.filter(f => !filters.has(f));
  if (missingFilters.length) diff(`CustomersWhereInput lacks ${missingFilters.join(', ')}.`);
  else ok(`CustomersWhereInput: ${CUSTOMER_FILTERS.join(', ')}`);
  return { lines, problems };
}

// Classifies the scope probe without echoing GrowFlow's raw error text.
export function classifyProbe(response) {
  if (response.status === 401) return 'FAIL  Token rejected (invalid, disabled, expired or revoked).';
  if (response.status === 429) return 'STOP  Rate limited. Wait a minute before running again.';
  let payload;
  try { payload = JSON.parse(response.body); } catch { return `FAIL  Unexpected HTTP ${response.status} response.`; }
  const messages = (payload?.errors || []).map(e => `${e?.message || ''} ${e?.extensions?.code || ''}`).join(' ');
  if (/insufficient permissions|forbidden/i.test(messages)) return 'FAIL  This token lacks the Create preorders scope.';
  if (/unauthenticated|invalid or revoked/i.test(messages)) return 'FAIL  Token rejected (invalid, disabled, expired or revoked).';
  if (payload?.data?.preorderStatus?.success === true) return 'NOTE  A made-up order ID reported success; treat status checks with care.';
  return 'OK    Create preorders scope accepted (the made-up order ID was not found, as expected).';
}

export async function runPreorderSchemaCheck(token, { transport, log }) {
  if (!/^gfr_\S+$/.test(token || '')) { log('FAIL  That does not look like a GrowFlow token (starts with gfr_).'); return 1; }
  const response = await transport({ token, query: SCHEMA_QUERY, variables: {}, maxBytes: 8388608 });
  if (response.status === 429) { log('STOP  Rate limited. Wait a minute before running again.'); return 1; }
  let payload;
  try { payload = JSON.parse(response.body); } catch { payload = null; }
  if (response.status !== 200 || !payload?.data) {
    log(response.status === 401 ? 'FAIL  Token rejected (invalid, disabled, expired or revoked).'
      : `FAIL  Could not read the schema (HTTP ${response.status}). No retry.`);
    return 1;
  }
  log('Schema comparison (type definitions only):');
  const { lines, problems } = compareSchema(payload.data);
  for (const line of lines) log(line);
  log('');
  log('Scope check (one status lookup for a made-up order ID):');
  const probe = classifyProbe(await transport({ token, query: PROBE_QUERY, variables: { orderId: PROBE_ORDER_ID } }));
  log(probe);
  log('');
  log(problems ? `RESULT ${problems} difference(s) found. Send these lines to your developer before testing orders.`
    : probe.startsWith('OK') ? 'RESULT The live schema matches what the app sends. Ready for the supervised test order.'
      : 'RESULT The schema matches, but see the scope check above.');
  return problems || !probe.startsWith('OK') ? 1 : 0;
}
