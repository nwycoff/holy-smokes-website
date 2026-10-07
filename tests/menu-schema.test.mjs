import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMenuSchemaCheck, readSchema, sampleQueries } from '../scripts/mac-token-checker/menu-schema-core.mjs';

const T = (name, kind = 'OBJECT') => ({ kind, name, ofType: null });
const L = inner => ({ kind: 'LIST', name: null, ofType: inner });
const field = (name, type) => ({ name, type });
const schemaData = {
  queryType: { fields: [field('findMenus', T('Menu')), field('findInventory', T('InventoryConnection'))] },
  schema: { types: [
    { name: 'Menu', kind: 'OBJECT', fields: [field('menuGroups', L(T('MenuGroup')))] },
    { name: 'MenuGroup', kind: 'OBJECT', fields: [field('name', T('String', 'SCALAR')), field('products', L(T('MenuProduct')))] },
    { name: 'MenuProduct', kind: 'OBJECT', fields: [field('name', T('String', 'SCALAR')), field('packages', L(T('MenuPackage')))] },
    { name: 'MenuPackage', kind: 'OBJECT', fields: [field('id', T('String', 'SCALAR')), field('testResults', T('TestResults'))] },
    { name: 'TestResults', kind: 'OBJECT', fields: [field('uom', T('String', 'SCALAR')), field('cbd', T('Float', 'SCALAR')),
      field('totalTerpenes', T('Float', 'SCALAR')), field('terpenes', L(T('Terpene')))] },
    { name: 'Terpene', kind: 'OBJECT', fields: [field('name', T('String', 'SCALAR')), field('value', T('Float', 'SCALAR'))] },
    { name: 'InventoryConnection', kind: 'OBJECT', fields: [field('edges', L(T('InventoryEdge')))] },
    { name: 'InventoryEdge', kind: 'OBJECT', fields: [field('node', T('Inventory'))] },
    { name: 'Inventory', kind: 'OBJECT', fields: [field('Qty', T('Float', 'SCALAR')), field('StorageLocation', T('Object', 'SCALAR'))] }
  ] }
};

test('menu checker finds terpene fields and builds sample queries from the live schema', () => {
  const schema = readSchema(schemaData), text = schema.lines.join('\n');
  assert.match(text, /TestResults\): uom: String, cbd: Float, totalTerpenes: Float, terpenes: \[Terpene\]/);
  assert.match(text, /TERP  Terpene fields anywhere in the API: TestResults.totalTerpenes: Float, TestResults.terpenes: \[Terpene\]/);
  assert.match(text, /Inventory.StorageLocation: Object \(SCALAR\)/);
  const { menu, inventory } = sampleQueries(schema);
  assert.match(menu, /testResults \{ uom cbd totalTerpenes terpenes \{ name value \} \}/);
  assert.match(inventory, /StorageLocation \} \} \}/);
});

test('menu checker sends the menu key only to the sample query and never prints it or the token', async () => {
  const sent = [], logged = [];
  const transport = async ({ token, query, variables }) => {
    sent.push({ token, query, variables });
    const data = query.includes('__schema') ? schemaData
      : query.includes('findInventory') ? { findInventory: { edges: [{ node: { Qty: 3, StorageLocation: { Name: 'Back', IsSellable: false } } }] } }
        : { findMenus: { menuGroups: [{ name: 'Flower', products: [
          { name: 'Calm Day', category: 'Flower', packages: [{ id: 'p1', testResults: { uom: '%', totalTerpenes: 2.1, terpenes: [{ name: 'Myrcene', value: 0.9 }] } }] },
          { name: 'Plain', category: 'Flower', packages: [{ id: 'p2', testResults: { uom: '%', cbd: 0.1 } }] }] }] } };
    return { status: 200, body: JSON.stringify({ data }) };
  };
  assert.equal(await runMenuSchemaCheck({ token: 'gfr_secret_value', menuKey: 'menu-key-secret' }, { transport, log: l => logged.push(l) }), 0);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map(s => s.variables), [{}, {}, { menuKey: 'menu-key-secret' }]);
  const out = logged.join('\n');
  assert.ok(!out.includes('gfr_secret_value') && !out.includes('menu-key-secret'));
  assert.match(out, /ROOM   Qty 3 · StorageLocation \{"Name":"Back","IsSellable":false\}/);
  assert.match(out, /SAMPLE Calm Day \[Flower\] totalTerpenes=2.1 \| terpenes=\[\{"name":"Myrcene","value":0.9\}\]/);
  assert.match(out, /COUNT  1 of 2 menu products have terpene results/);
});
