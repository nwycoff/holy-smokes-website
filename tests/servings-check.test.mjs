import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runServingsCheck } from '../scripts/mac-token-checker/servings-core.mjs';

const T = (name, kind = 'OBJECT') => ({ kind, name, ofType: null });
const L = inner => ({ kind: 'LIST', name: null, ofType: inner });
const field = (name, type, args = []) => ({ name, type, args });
const schema = {
  queryType: { fields: [field('findProducts', T('ProductsConnection'), [field('first', T('Int', 'SCALAR')), field('where', T('ProductsWhereInput', 'INPUT_OBJECT'))])] },
  schema: { types: [
    { name: 'ProductsConnection', kind: 'OBJECT', fields: [field('edges', L(T('ProductsEdge')))] },
    { name: 'ProductsEdge', kind: 'OBJECT', fields: [field('node', T('Products'))] },
    { name: 'Products', kind: 'OBJECT', fields: [field('objectId', T('String', 'SCALAR')), field('Name', T('String', 'SCALAR')), field('ServingsPerContainer', T('Float', 'SCALAR'))] },
    { name: 'ProductsWhereInput', kind: 'INPUT_OBJECT', inputFields: [{ name: 'objectId' }] }
  ] }
};

test('servings check finds the Products query, looks up menu edibles by ID and works out mg per dose', async () => {
  const sent = [], logged = [];
  const transport = async ({ token, query, variables }) => {
    sent.push({ token, query, variables });
    const data = query.includes('__schema') ? schema
      : query.includes('findMenus') ? { findMenus: { menuGroups: [{ products: [
        { id: 'a', name: 'Gummies 100mg', category: 'Edibles', unitWeight: 100, unitWeightUOM: 'mg' },
        { id: 'b', name: 'Cookie', category: 'Edibles', unitWeight: 300, unitWeightUOM: 'mg' },
        { id: 'c', name: 'OG Kush', category: 'Flower', unitWeight: 3.5, unitWeightUOM: 'g' }] }] } }
        : { findProducts: { edges: [{ node: { objectId: 'a', Name: 'Gummies 100mg', ServingsPerContainer: 10 } }, { node: { objectId: 'b', ServingsPerContainer: null } }] } };
    return { status: 200, body: JSON.stringify({ data }) };
  };
  assert.equal(await runServingsCheck({ token: 'gfr_secret', menuKey: 'menu-secret' }, { transport, log: l => logged.push(l) }), 0);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2].variables, { where: { objectId: { in: ['a', 'b'] } } });
  assert.match(sent[2].query, /\$where: ProductsWhereInput!\) \{\n  findProducts\(first: 10, where: \$where\) \{ edges \{ node \{ objectId Name ServingsPerContainer/);
  const out = logged.join('\n');
  assert.ok(!out.includes('gfr_secret') && !out.includes('menu-secret'));
  assert.match(out, /OK    findProducts can look products up by objectId/);
  assert.match(out, /SERV  Gummies 100mg: 10 servings → 10 mg per dose \(100 mg package\)/);
  assert.match(out, /SERV  Cookie: servings not filled in/);
  assert.match(out, /COUNT  2 of 2 menu edibles found by ID; 1 have servings filled in/);
});

test('servings check says which request GrowFlow refused, without its raw error text', async () => {
  const logged = [];
  const transport = async ({ query }) => query.includes('__schema') ? { status: 200, body: JSON.stringify({ data: schema }) }
    : { status: 400, body: JSON.stringify({ errors: [{ message: 'Variable "$where" got invalid value secret-detail' }] }) };
  assert.equal(await runServingsCheck({ token: 'gfr_x', menuKey: 'k' }, { transport, log: l => logged.push(l) }), 1);
  const out = logged.join('\n');
  assert.match(out, /FAIL  GrowFlow refused the menu request \(HTTP 400, wrong value type\)/);
  assert.ok(!out.includes('secret-detail'));
});
