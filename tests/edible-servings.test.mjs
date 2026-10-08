import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyServings, readServings } from '../server/customer-app/growflow.mjs';
import { cardTags, facetOrder, packageMg, potencyLine } from '../assets/tablet/categories.js';

const edible = (id, size, facets = { 'Per package': 'Up to 100mg' }) => ({ id, category: 'Edibles', facets,
  variants: [{ size, weight: parseFloat(size) }] });

test('edibles with servings get mg per dose; the Per dose filter waits for half of them', () => {
  const menu = { products: [edible('a', '100 mg'), edible('b', '1000 mg', { 'Per package': '1,000mg' }), edible('c', '250 g'),
    { id: 'f', category: 'Flower', facets: {}, variants: [{ size: '3.5 g', weight: 3.5 }] }] };
  applyServings(menu, new Map([['a', 10], ['c', 10], ['f', 5]]));
  assert.deepEqual(menu.products[0].dose, { servings: 10, mg: 10 });
  assert.equal(menu.products[2].dose, undefined, 'no dose without an mg package size');
  assert.equal(menu.products[3].dose, undefined, 'only edibles');
  assert.equal(menu.products[0].facets['Per dose'], undefined, '1 of 3 edibles is too few for the filter');
  applyServings(menu, new Map([['a', 10], ['b', 20]]));
  assert.deepEqual(menu.products.map(p => p.facets['Per dose']), ['5–10mg', '25–50mg', undefined, undefined]);
  assert.equal(potencyLine(menu.products[1], ''), '1000 mg per package · 50 mg per dose (20 servings)');
  assert.equal(cardTags(menu.products[1]), 'Edibles · 1,000mg');
});

test('a refused servings lookup leaves edibles with package totals only', async () => {
  const reported = [];
  const env = { APP_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ until_at: Infinity }) }) }) }, APP_LIMIT_SECRET: 's', GROWFLOW_ORG: 'o' };
  const servings = await readServings(['a'], env, { now: () => 0, report: code => reported.push(code) });
  assert.equal(servings.size, 0);
  assert.match(reported[0], /^SERVINGS_REFRESH_/);
});

test('filter values sort by number; edibles sort by package mg', () => {
  assert.deepEqual(facetOrder(['Over 50mg', '10–25mg', 'Up to 5mg', '5–10mg']), ['Up to 5mg', '5–10mg', '10–25mg', 'Over 50mg']);
  assert.deepEqual(facetOrder(['1,000mg', 'Up to 100mg', '10,000mg', '250–500mg']), ['Up to 100mg', '250–500mg', '1,000mg', '10,000mg']);
  assert.deepEqual(facetOrder(['Single', '2-pack']), ['Single', '2-pack']);
  assert.equal(packageMg(edible('a', '1000 mg')), 1000);
  assert.equal(packageMg(edible('c', '250 g')), -1);
});
