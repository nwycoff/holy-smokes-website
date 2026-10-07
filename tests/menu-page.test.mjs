import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleMenuPage, pageParts, renderPage, slugOf, SITEMAP_PATHS } from '../server/site/menu-page.mjs';
import { classifyProduct } from '../server/customer-app/taxonomy.mjs';

const template = await readFile(new URL('../menu.html', import.meta.url), 'utf8');
const notFound = await readFile(new URL('../404.html', import.meta.url), 'utf8');
const item = (id, category, name, extra = {}) => { const placed = classifyProduct(category, name);
  return { id, name, brand: 'Sample Farms', category: placed.department, facets: placed.facets, also: placed.house ? ['Treehouse'] : [],
    ...(placed.house ? { house: true } : {}), flower: ['Flower', 'Smalls', 'Shake'].includes(placed.department), type: 'hybrid',
    thc: [22.4, 22.4], cbd: null, terpenes: [1.25, 1.5], cbdRich: false, variants: [{ size: '1 g', priceCents: 2050, grams: 1, pricePerGramCents: 2050 }], ...extra }; };
const menu = { updatedAt: Date.UTC(2026, 9, 7, 19, 5), stale: false, pricesIncludeTax: true, categories: ['Treehouse', 'Flower', 'Pre-Rolls'],
  products: [item('a', 'Pre-Roll', 'Sample Joint $20 <b>bold</b>', { popular: 2 }), item('b', 'Infused Blunt', 'Sample Blunt 2pk', { popular: 1 }),
    item('c', 'Tree House Top Shelf Flower', 'House Kush'), item('d', 'Top-Shelf Flower', 'Other Kush', { image: 'https://cdn.example.test/d.jpg' })] };
const assets = { fetch: async url => {
  const path = new URL(url).pathname;
  if (path === '/menu.html') return new Response(null, { status: 308, headers: { location: '/menu' } });
  if (path === '/menu') return new Response(template, { headers: { 'content-type': 'text/html' } });
  if (path === '/404.html') return new Response(notFound, { status: 200 });
  return new Response('missing', { status: 404 });
} };
const page = (path, method = 'GET', loadMenu = async () => menu) =>
  handleMenuPage({ request: new Request(`https://www.treehousepharmacy.com${path}`, { method }), env: { ASSETS: assets } }, { loadMenu, report: () => {} });

test('each heading page has its own title, description, canonical, heading and products in the page text', async () => {
  const res = await page('/menu/pre-rolls'), html = await res.text();
  assert.equal(res.status, 200); assert.match(res.headers.get('cache-control'), /max-age=60/);
  assert.match(html, /<title>Pre-Rolls in Ponca City, OK \| Treehouse Pharmacy Menu<\/title>/);
  assert.match(html, /<meta name="description" content="2 products in stock now at Treehouse Pharmacy in Ponca City, OK: joints, blunts/);
  assert.equal((html.match(/<link rel="canonical"/g) || []).length, 1);
  assert.match(html, /<link rel="canonical" href="https:\/\/www.treehousepharmacy.com\/menu\/pre-rolls" \/>/);
  assert.match(html, /<h1 id="menu-title"[^>]*>Pre-Rolls<\/h1>/);
  assert.match(html, /<body data-menu="website" data-category="Pre-Rolls"/);
  assert.equal((html.match(/<article class="product"/g) || []).length, 2);
  assert.match(html, /<div id="products" class="products" aria-busy="false">/);
  assert.match(html, /\$20\.50/); // prices survive the page building
  assert.match(html, /Sample Joint \$20 &lt;b&gt;bold&lt;\/b&gt;/); // names are escaped
  assert.match(html, /<a href="\/menu\/pre-rolls" aria-current="page">Pre-Rolls<span>2<\/span><\/a>/);
  assert.match(html, /<a href="\/menu\/treehouse">Treehouse<span>1<\/span><\/a>/);
  assert.ok(!/href="\/menu\/vapes"/.test(html), 'headings without products are not linked');
  assert.match(html, /<p id="count" role="status">2 finds · Pre-Rolls<\/p>/);
  assert.match(html, /Updated 2:05 PM/);
  const data = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.deepEqual(data[0].itemListElement.map(i => i.name), ['Home', 'Menu', 'Pre-Rolls']);
  assert.equal(data[1].about.address.streetAddress, '1801 N Union St');
  const pages = JSON.parse(html.match(/<script type="application\/json" id="menu-pages">(.*?)<\/script>/)[1]);
  assert.deepEqual(Object.keys(pages), ['All', 'Treehouse', 'Flower', 'Pre-Rolls']);
  assert.equal(pages.Treehouse.title, 'Treehouse Products in Ponca City, OK | Treehouse Pharmacy Menu');
  assert.equal(pages['Pre-Rolls'].path, '/menu/pre-rolls');
});
test('the overview lists every heading and the most popular products first', async () => {
  const html = await (await page('/menu')).text();
  assert.match(html, /<title>Live Menu \| Treehouse Pharmacy/);
  assert.ok(!/data-category=/.test(html));
  const ids = [...html.matchAll(/data-product-id="(\w)"/g)].map(m => m[1]);
  assert.deepEqual(ids.slice(0, 2), ['b', 'a']);
  assert.match(html, /<a href="\/menu" aria-current="page">All<span>4<\/span><\/a>/);
  assert.match(html, /class="product-photo" src="https:\/\/cdn.example.test\/d.jpg"/);
});
test('old links redirect, unknown headings are a real 404, other methods are refused', async () => {
  const old = await page('/menu?category=Pre-Rolls');
  assert.equal(old.status, 301); assert.equal(old.headers.get('location'), 'https://www.treehousepharmacy.com/menu/pre-rolls');
  assert.equal((await page('/menu?category=Nope')).headers.get('location'), 'https://www.treehousepharmacy.com/menu');
  const missing = await page('/menu/not-a-heading');
  assert.equal(missing.status, 404); assert.match(await missing.text(), /couldn’t find that page/);
  assert.equal((await page('/menu', 'POST')).status, 405);
  const head = await page('/menu/flower', 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});
test('when the menu cannot be read, pages still load with their headings and the browser fills in products', async () => {
  const html = await (await page('/menu/edibles', 'GET', async () => { throw new Error('down'); })).text();
  assert.match(html, /<title>Edibles in Ponca City/);
  assert.match(html, /<a href="\/menu\/edibles" aria-current="page">Edibles<\/a>/);
  assert.match(html, /<div id="products" class="products" aria-busy="true"><\/div>/);
  assert.match(html, /Getting the menu ready…/);
});
test('slugs and sitemap pages', () => {
  assert.equal(slugOf('Tinctures & Capsules'), 'tinctures-capsules'); assert.equal(slugOf('CBD & Hemp'), 'cbd-hemp');
  assert.ok(SITEMAP_PATHS.includes('/menu/pre-rolls') && SITEMAP_PATHS.includes('/menu/treehouse') && !SITEMAP_PATHS.includes('/menu/more'));
  assert.throws(() => renderPage('<html></html>', pageParts(null, menu)), /MENU_TEMPLATE/);
});
