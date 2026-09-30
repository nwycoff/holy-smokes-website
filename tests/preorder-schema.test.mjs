import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSchema, classifyProbe, runPreorderSchemaCheck, PROBE_ORDER_ID } from '../scripts/mac-token-checker/preorder-schema-core.mjs';

const T = name => ({ kind: /^[A-Z][a-z]+(Input|Response|Types?|Statuses)$|^Customers|^Preorder/.test(name) ? 'OBJECT' : 'SCALAR', name });
const req = t => ({ kind: 'NON_NULL', ofType: t });
const list = t => ({ kind: 'LIST', ofType: t });
const f = (name, type, args) => ({ name, type, ...(args ? { args } : {}) });
const e = (...names) => ({ enumValues: names.map(name => ({ name })) });
// Mirrors the example retailGraphQLSchema.graphql that the app was written against.
function example() {
  return {
    queryType: { fields: [
      f('preorderStatus', T('CreatePreorderResponse'), [f('orderId', req(T('String')))]),
      f('findCustomers', req(T('CustomersConnection')), [f('where', T('CustomersWhereInput')), f('first', T('Int'))])] },
    mutationType: { fields: [f('createPreorder', T('CreatePreorderResponse'),
      [f('menuKey', req(T('String'))), f('preorder', req(T('PreorderInput')))])] },
    customers: { fields: ['objectId', 'Name', 'Birthday', 'CustomerType', 'CurrentPoints', 'PatientName'].map(n => f(n, T('String'))) },
    customerFilters: { inputFields: ['objectId', 'IsDeleted', 'IsAnon', 'Disabled', 'Active', 'Name'].map(name => ({ name })) },
    preorderInput: { inputFields: [f('preOrderType', req(T('PreorderType'))), f('preOrderTotal', req(T('Int'))),
      f('customer', req(T('CustomerInput'))), f('deliveryAddress', T('DeliveryAddressInput')),
      f('orderItems', req(list(T('OrderItemInput')))), f('preOrderNote', T('String')), f('nameForOrder', T('String')),
      f('contactPhoneNumber', T('String')), f('completeBefore', T('Int')), f('completeAfter', T('Int'))] },
    customerInput: { inputFields: [f('type', req(T('CustomerTypes'))), f('firstName', req(T('String'))),
      f('lastName', req(T('String'))), f('dob', req(T('DateTime'))), f('id', T('String')), f('email', T('String'))] },
    orderItemInput: { inputFields: [f('productId', req(T('String'))), f('qty', req(T('Float'))), f('weight', T('Float')),
      f('packageIds', list(T('String')))] },
    preorderType: e('Pickup', 'Delivery'), customerTypes: e('Recreational', 'Medical'),
    preorderStatuses: e('New', 'Pending', 'Completed', 'Canceled', 'Unfulfilled', 'Held', 'InTransit', 'Fulfilled', 'Cart'),
    createResponse: { fields: [f('success', req(T('Boolean'))), f('order', T('PreorderResponse'))] },
    preorderResponse: { fields: [f('id', T('String')), f('orderNumber', T('String')), f('status', T('PreorderStatuses'))] }
  };
}

test('the example schema matches what the app sends', () => {
  const { lines, problems } = compareSchema(example());
  assert.equal(problems, 0, lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith('OK    mutation createPreorder(menuKey: String!, preorder: PreorderInput!)')));
  assert.ok(lines.some(l => l.includes('PatientName')));
  assert.ok(lines.some(l => l.startsWith('NOTE') && l.includes('Readable license/patient fields on Customers: PatientName')));
  assert.ok(lines.some(l => l === 'NOTE  No readable purchase-limit fields on Customers, Orders or Stores.'));
  const withLimits = { ...example(), orders: { fields: [f('TimedPurchaseLimitsObjs', list(T('ArrayResult')))] },
    customerFields: { inputFields: [{ name: 'PatientPurchaseLimits' }, { name: 'ExtendedLimits' }, { name: 'Name' }] } };
  const limitLines = compareSchema(withLimits).lines;
  assert.ok(limitLines.some(l => l.includes('Readable purchase-limit fields: Orders.TimedPurchaseLimitsObjs: [ArrayResult]')));
  assert.ok(limitLines.some(l => l.includes('written or filtered but not read: PatientPurchaseLimits, ExtendedLimits')));
});
test('renamed fields, new required inputs and missing enum values are reported', () => {
  const s = example();
  s.customers.fields = s.customers.fields.filter(x => x.name !== 'Birthday');
  s.customerInput.inputFields.push(f('storeId', req(T('String'))));
  s.orderItemInput.inputFields = s.orderItemInput.inputFields.filter(x => x.name !== 'weight');
  s.customerTypes = e('Recreational');
  s.preorderStatuses.enumValues.push({ name: 'ReadyForPickup' });
  s.mutationType.fields = [];
  const { lines, problems } = compareSchema(s);
  assert.equal(problems, 5, lines.join('\n'));
  for (const text of ['Customers.Birthday', 'CustomerInput.storeId', 'OrderItemInput.weight', 'CustomerTypes lacks Medical', 'createPreorder is missing'])
    assert.ok(lines.some(l => l.startsWith('DIFF') && l.includes(text)), text);
  assert.ok(lines.some(l => l.startsWith('NOTE') && l.includes('ReadyForPickup')));
});
test('scope probe is classified without echoing raw errors', () => {
  const body = errors => ({ status: 200, body: JSON.stringify({ errors, data: null }) });
  assert.match(classifyProbe(body([{ message: 'Insufficient Permissions' }])), /lacks the Create preorders scope/);
  assert.match(classifyProbe(body([{ message: 'Invalid or revoked API token', extensions: { code: 'UNAUTHENTICATED' } }])), /Token rejected/);
  assert.match(classifyProbe(body([{ message: 'Order secret-detail not found' }])), /^OK/);
  assert.ok(!classifyProbe(body([{ message: 'Order secret-detail not found' }])).includes('secret-detail'));
  assert.match(classifyProbe({ status: 429, body: '' }), /Rate limited/);
});
test('runs two requests, never a mutation, and rejects non-tokens before sending', async () => {
  const sent = [], log = [];
  const transport = async request => {
    sent.push(request);
    return request.query.includes('__type') ? { status: 200, body: JSON.stringify({ data: example() }) }
      : { status: 200, body: JSON.stringify({ errors: [{ message: 'not found' }], data: { preorderStatus: null } }) };
  };
  assert.equal(await runPreorderSchemaCheck('gfr_synthetic', { transport, log: l => log.push(l) }), 0);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(r => /^query /.test(r.query) && !r.query.includes('createPreorder(')));
  assert.equal(sent[1].variables.orderId, PROBE_ORDER_ID);
  assert.ok(log.at(-1).includes('Ready for the supervised test order'));
  assert.ok(!log.join('\n').includes('gfr_synthetic'));
  assert.equal(await runPreorderSchemaCheck('not-a-token', { transport, log: () => {} }), 1);
  assert.equal(sent.length, 2);
});
