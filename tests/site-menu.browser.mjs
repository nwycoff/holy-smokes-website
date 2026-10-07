// The website's Menu page (menu.html) runs the shared menu (assets/tablet/menu.js) in website mode.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { classifyProduct, DEPARTMENTS, HOUSE } from '../server/customer-app/taxonomy.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
const item = (i, category, name, extra = {}) => { const placed = classifyProduct(category, name);
  return { id:`p${i}`, name, brand:'Sample Farms', category:placed.department, facets:placed.facets, also:placed.house ? [HOUSE] : [],
    ...(placed.house ? { house:true } : {}), sourceCategory:category, flower:['Flower','Smalls','Shake'].includes(placed.department), type:'hybrid',
    thc:[22,22], cbd:null, terpenes:[1.2,1.2], cbdRich:false, variants:[{ size:'3.5 g', priceCents:2000 + i * 100, grams:3.5, pricePerGramCents:571, available:10 }], ...extra }; };
const products = [item(1,'Pre-Pack Flower 3.5g','Sample Kush',{ image:'/images/img6.png' }), item(2,'Tree House Small Bud','House Smalls'), item(3,'Pre-Roll','Sample Joint'),
  item(4,'Infused Blunt','Sample Blunt 2pk'), item(5,'510 Carts','Sample Cart')];
const menu = { products, categories:[HOUSE, ...DEPARTMENTS.filter(d => products.some(p => p.category === d))], pricesIncludeTax:true, updatedAt:Date.now(), stale:false };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/api/app/menu') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ ...menu, updatedAt:Date.now() })); }
  if (!url.pathname.startsWith('/assets/') && !url.pathname.startsWith('/images/') && url.pathname !== '/menu.html') { res.writeHead(404); return res.end(); }
  try { const body = await readFile(path.join(root, decodeURIComponent(url.pathname))); res.writeHead(200, {'Content-Type': types[path.extname(url.pathname)] || 'text/plain'}); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
try {
  const errors = [];
  const page = await browser.newPage({ viewport:{ width:1280, height:900 } });
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('https://cdn.tailwindcss.com/**', r => r.fulfill({ contentType:'text/javascript', body:'window.tailwind={};' }));
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await page.clock.install();
  await page.goto(`${base}/menu.html?category=Pre-Rolls`);
  await page.waitForFunction(() => document.querySelectorAll('.product').length === 2);
  assert.match(await page.locator('#categories [aria-pressed="true"]').textContent(), /^Pre-Rolls/, 'a linked heading opens on that heading');
  assert.equal(await page.locator('#refine').evaluate(d => d.open), true, 'filters are open beside the products on wide screens');
  await page.locator('#categories button', { hasText:'Treehouse' }).click();
  assert.equal(new URL(page.url()).searchParams.get('category'), 'Treehouse', 'the chosen heading is kept in the address');
  assert.equal(await page.locator('.product').count(), 1);
  await page.locator('#categories button', { hasText:/^All/ }).click();
  assert.equal(new URL(page.url()).searchParams.has('category'), false);
  assert.equal(await page.locator('.product-photo').count(), 1, 'product photos show on the website');
  await page.clock.runFor(150000);
  assert.equal(await page.locator('#categories [aria-pressed="true"]').textContent().then(t => t.startsWith('All')), true);
  await page.locator('#categories button', { hasText:'Vapes' }).click(); await page.clock.runFor(150000);
  assert.match(await page.locator('#categories [aria-pressed="true"]').textContent(), /^Vapes/, 'the website never resets itself after idle time');
  const phone = await browser.newPage({ viewport:{ width:390, height:844 }, isMobile:true, hasTouch:true });
  phone.on('pageerror', e => errors.push(String(e)));
  await phone.route('https://cdn.tailwindcss.com/**', r => r.fulfill({ contentType:'text/javascript', body:'window.tailwind={};' }));
  await phone.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await phone.goto(`${base}/menu.html`); await phone.waitForSelector('.product');
  assert.equal(await phone.locator('#refine').evaluate(d => d.open), false, 'filters fold away on phones');
  await phone.locator('#categories button', { hasText:'Pre-Rolls' }).click();
  assert.equal(await phone.locator('#categories #category-facets').count(), 0, 'sub-filters sit below the swipeable headings on phones');
  assert.equal(await phone.locator('#category-facets').count(), 1);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no sideways scrolling');
  assert.deepEqual(errors, []);
  console.log('PASS: website Menu page: linked headings, address kept, photos, no idle reset, phone layout, no errors.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
