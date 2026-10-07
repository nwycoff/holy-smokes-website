// The website's Menu page (menu.html) runs the shared menu (assets/tablet/menu.js) in website mode.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { classifyProduct, DEPARTMENTS, HOUSE } from '../server/customer-app/taxonomy.mjs';
import { handleMenuPage } from '../server/site/menu-page.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
const item = (i, category, name, extra = {}) => { const placed = classifyProduct(category, name);
  return { id:`p${i}`, name, brand:'Sample Farms', category:placed.department, facets:placed.facets, also:placed.house ? [HOUSE] : [],
    ...(placed.house ? { house:true } : {}), sourceCategory:category, flower:['Flower','Smalls','Shake'].includes(placed.department), type:'hybrid',
    thc:[22,22], cbd:null, terpenes:[1.2,1.2], cbdRich:false, variants:[{ size:'3.5 g', priceCents:2000 + i * 100, grams:3.5, pricePerGramCents:571, available:10 }], ...extra }; };
const products = [item(1,'Pre-Pack Flower 3.5g','Sample Kush',{ image:'/images/img6.png' }), item(2,'Tree House Small Bud','House Smalls'), item(3,'Pre-Roll','Sample Joint'),
  item(4,'Infused Blunt','Sample Blunt 2pk'), item(5,'510 Carts','Sample Cart')];
const menu = { products, categories:[HOUSE, ...DEPARTMENTS.filter(d => products.some(p => p.category === d))], pricesIncludeTax:true, updatedAt:Date.now(), stale:false };
// Menu pages go through the real page function (server/site/menu-page.mjs), as on Cloudflare.
const assets = { fetch: async url => { const name = new URL(url).pathname;
  try { return new Response(await readFile(path.join(root, name === '/menu' ? '/menu.html' : name)), { headers:{ 'content-type':'text/html' } }); }
  catch { return new Response('missing', { status:404 }); } } };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/api/app/menu') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ ...menu, updatedAt:Date.now() })); }
  if (url.pathname === '/menu' || url.pathname.startsWith('/menu/')) {
    const page = await handleMenuPage({ request:new Request(`https://www.treehousepharmacy.com${url.pathname}${url.search}`), env:{ ASSETS:assets } },
      { loadMenu:async () => menu, report:() => {} });
    res.writeHead(page.status, Object.fromEntries(page.headers)); return res.end(await page.text());
  }
  if (!url.pathname.startsWith('/assets/') && !url.pathname.startsWith('/images/')) { res.writeHead(404); return res.end(); }
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
  // What a search engine's first pass sees: the page with JavaScript off.
  const plain = await browser.newPage({ javaScriptEnabled:false });
  await plain.goto(`${base}/menu/pre-rolls`);
  assert.equal(await plain.locator('.product').count(), 2, 'products are in the page itself');
  assert.equal(await plain.title(), 'Pre-Rolls in Ponca City, OK | Treehouse Pharmacy Menu');
  assert.equal(await plain.locator('#categories a[href="/menu/treehouse"]').count(), 1, 'headings are real links');
  await plain.close();
  await page.clock.install();
  await page.goto(`${base}/menu/pre-rolls`);
  // Tailwind is stubbed out here, so give the header its real logo size and hide the mobile menu.
  await page.addStyleTag({ content:'#mainNav img, footer img { width:40px; height:40px; } #mobileMenu { display:none; }' });
  await page.clock.runFor(1000);
  await page.waitForSelector('#category-facets', { timeout:10000 }); // the live menu has loaded and the script has taken over
  assert.match(await page.locator('#categories [aria-current="page"]').textContent(), /^Pre-Rolls/, 'the page opens on its heading');
  // The page clock is faked, so poll from here in real time.
  let logo = false;
  for (let i = 0; i < 50 && !logo; i++) { logo = await page.locator('#mainNav img').evaluate(img => img.complete && img.naturalWidth > 0); if (!logo) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(logo, 'the logo loads on heading pages');
  assert.equal(await page.locator('#refine').evaluate(d => d.open), true, 'filters are open beside the products on wide screens');
  assert.equal(await page.locator('#category-facets').count(), 1, 'the heading has its sub-filters');
  await page.getByRole('checkbox', { name:/Multipacks/ }).check();
  assert.equal(await page.locator('.product').count(), 1);
  await page.locator('#clear').click();
  assert.equal(await page.locator('.product').count(), 2, 'clearing filters keeps the page heading');
  // Headings switch in place: no reload, the screen stays put, and the address and page details follow.
  await page.evaluate(() => { window.__samePage = true; scrollTo({ top:120, behavior:'instant' }); });
  const before = await page.evaluate(() => scrollY);
  await page.locator('#categories a', { hasText:'Treehouse' }).click();
  await page.waitForURL('**/menu/treehouse');
  assert.equal(await page.evaluate(() => window.__samePage), true, 'no page reload');
  assert.equal(await page.evaluate(() => scrollY), before, 'the screen does not jump to the top');
  assert.equal(await page.locator('.product').count(), 1);
  assert.equal(await page.title(), 'Treehouse Products in Ponca City, OK | Treehouse Pharmacy Menu');
  assert.equal(await page.locator('#menu-title').textContent(), 'Treehouse Products');
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://www.treehousepharmacy.com/menu/treehouse');
  assert.match(await page.locator('#categories [aria-current="page"]').textContent(), /^Treehouse/);
  await page.goBack(); await page.waitForURL('**/menu/pre-rolls');
  assert.equal(await page.locator('.product').count(), 2, 'Back returns to the previous heading');
  assert.equal(await page.locator('#menu-title').textContent(), 'Pre-Rolls');
  // Scrolled down into the products: switching brings the products back into view, not the page top.
  await page.evaluate(() => scrollTo({ top:document.body.scrollHeight, behavior:'instant' }));
  await page.locator('#categories a', { hasText:/^All/ }).evaluate(a => a.click());
  await page.waitForURL(url => new URL(url).pathname === '/menu');
  await page.clock.runFor(2000); await page.waitForTimeout(1200); // smooth scrolling runs on real time
  const layoutTop = await page.locator('.layout').evaluate(el => el.getBoundingClientRect().top);
  assert.ok(layoutTop >= 0 && layoutTop < 200, `products in view after switching (layout top ${layoutTop})`);
  assert.ok(await page.evaluate(() => scrollY) > 0, 'not sent to the top of the page');
  assert.equal(await page.locator('.product-photo').count(), 1, 'product photos show on the website');
  await page.locator('#search').fill('Cart'); await page.clock.runFor(150000);
  assert.equal(await page.locator('#search').inputValue(), 'Cart', 'the website never resets itself after idle time');
  const old = await page.request.get(`${base}/menu?category=Pre-Rolls`, { maxRedirects:0 });
  assert.equal(old.status(), 301); assert.equal(old.headers().location, 'https://www.treehousepharmacy.com/menu/pre-rolls');
  const phone = await browser.newPage({ viewport:{ width:390, height:844 }, isMobile:true, hasTouch:true });
  phone.on('pageerror', e => errors.push(String(e)));
  await phone.route('https://cdn.tailwindcss.com/**', r => r.fulfill({ contentType:'text/javascript', body:'window.tailwind={};' }));
  await phone.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType:'text/css', body:'' }));
  await phone.goto(`${base}/menu`); await phone.waitForSelector('.product');
  assert.equal(await phone.locator('#refine').evaluate(d => d.open), false, 'filters fold away on phones');
  await phone.goto(`${base}/menu/pre-rolls`); await phone.waitForFunction(() => document.getElementById('category-facets'));
  assert.equal(await phone.locator('#categories #category-facets').count(), 0, 'sub-filters sit below the swipeable headings on phones');
  assert.equal(await phone.locator('#category-facets').count(), 1);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no sideways scrolling');
  assert.deepEqual(errors, []);
  console.log('PASS: website Menu pages: products in the page without JavaScript, heading pages and links, filters, photos, no idle reset, old links redirect, phone layout, no errors.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
