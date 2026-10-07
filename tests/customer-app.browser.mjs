// Synthetic browser QA only. Starts a loopback static server and intercepts API requests.
// Requires npm run build, playwright, and a local Chromium installation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const server = createServer(async (req, res) => {
  const url = new URL(req.url,'http://localhost');
  const name = path.resolve(root, '.' + url.pathname + (url.pathname.endsWith('/') ? 'index.html' : ''));
  if (!name.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    const body=await readFile(name);
    res.writeHead(200, {'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[path.extname(name)] || 'text/plain',
      'Content-Security-Policy':csp,'Referrer-Policy':'strict-origin','Cache-Control':'no-store'});res.end(body);
  } catch { res.writeHead(404);res.end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']} : {})});
await mkdir(new URL('../docs/',import.meta.url),{recursive:true});
try {
  for (const width of [390,360,1365]) {
    const page=await browser.newPage({viewport:{width,height:850},deviceScaleFactor:1});
    await page.emulateMedia({reducedMotion:'reduce'});
    const errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('request',r=>{if(r.url().includes('/api/'))calls.push(r.url());});
    await page.goto(`${origin}/app/demo/`);await page.locator('#home-products .product-card').first().waitFor();
    assert.ok(await page.locator('#demo-banner').isVisible());
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(width!==360) await page.screenshot({path:fileURLToPath(new URL(`../docs/customer-app-${width===390?'mobile':'desktop'}.png`,import.meta.url)),fullPage:width!==390});
    await page.evaluate(()=>{location.hash='menu';});
    await page.locator('#menu-products .product-card').first().waitFor();
    if(width===390) await page.screenshot({path:fileURLToPath(new URL('../docs/customer-app-menu.png',import.meta.url))});
    await page.getByRole('button',{name:'Flower',exact:true}).click();
    assert.equal(await page.locator('#menu-products .product-card').count(),3); // Smalls has its own heading now
    // Sub-filter rows: "All" is lit by default; picking a value narrows; "All" resets the row.
    // (Every demo flower is whole flower, so a one-value Style row is not shown.)
    assert.equal(await page.locator('.facet-row[aria-label="Style"]').count(),0);
    const packRow=page.locator('.facet-row[aria-label="Packaging"]');
    assert.equal(await packRow.getByRole('button',{name:/^All \(3\)/}).getAttribute('aria-pressed'),'true');
    await packRow.getByRole('button',{name:/^Bulk/}).click();
    assert.equal(await packRow.getByRole('button',{name:/^All/}).getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('#menu-products .product-card').count(),1);
    await packRow.getByRole('button',{name:/^All/}).click();
    assert.equal(await page.locator('#menu-products .product-card').count(),3);
    assert.equal(await packRow.getByRole('button',{name:/^All/}).getAttribute('aria-pressed'),'true');
    await page.locator('#filter-button').click();await page.getByRole('button',{name:/^Under \$20/}).click();
    assert.equal(await page.locator('#menu-products .product-card').count(),1);
    await page.getByRole('button',{name:/^Show 1 product/}).click();
    assert.equal(await page.locator('#active-filters .chip').count(),1);
    await page.locator('#menu-search').fill('no-matching-product');await page.getByText('No products match those filters.',{exact:false}).waitFor();
    await page.locator('#menu-search').fill('golden');assert.equal(await page.locator('#menu-products .product-card').count(),1);
    await page.evaluate(()=>{location.hash='rewards';});await page.locator('#rewards-content .balance-number').waitFor();
    assert.ok((await page.locator('#rewards-content').innerText()).includes('750'));
    const contrast=await page.locator('#rewards-content .points-card').evaluate(n=>({background:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color}));
    assert.equal(contrast.background,'rgb(33, 59, 44)');
    await page.evaluate(()=>{location.hash='account';});await page.getByRole('button',{name:'Sign out',exact:true}).click();
    assert.ok(!(await page.locator('#home-balance').innerText()).includes('750'));
    await page.getByRole('button',{name:'Try a sample account →'}).click();
    assert.equal(calls.length,0);assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
    await page.close();
  }
  // Transient public menu errors retry, preserve loaded products, and recover.
  const { demoMenu } = await import('../assets/customer/demo-data.js');
  const menuContext = await browser.newContext({ viewport: { width: 390, height: 850 }, serviceWorkers: 'block' });
  const menuPage = await menuContext.newPage();
  let menuCalls = 0, failMenu = false;
  await menuContext.route('**/api/app/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    const failed = name === 'menu' && (++menuCalls === 1 || failMenu);
    const values = { config: { enabled: true, menuEnabled: true }, session: { signedIn: false }, menu: demoMenu };
    await route.fulfill({ status: failed ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(failed ? { error: 'Temporary failure' } : values[name] || {}) });
  });
  await menuPage.goto(`${origin}/app/#menu`);
  await menuPage.locator('#menu-products .product-card').first().waitFor();
  assert.equal(menuCalls, 2, 'first failed request retries automatically');
  const productCount = await menuPage.locator('#menu-products .product-card').count();
  failMenu = true;
  await menuPage.evaluate(() => { location.hash = 'home'; });
  await menuPage.locator('#view-home').waitFor();
  await menuPage.evaluate(() => { location.hash = 'menu'; });
  await menuPage.getByText('Showing the last available menu.', { exact: false }).waitFor();
  assert.equal(await menuPage.locator('#menu-products .product-card').count(), productCount);
  assert.equal(await menuPage.locator('#menu-freshness').innerText(), 'Update delayed');
  await menuPage.reload();
  await menuPage.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  failMenu = false;
  await menuPage.getByRole('button', { name: 'Try again', exact: true }).click();
  await menuPage.locator('#menu-products .product-card').first().waitFor();
  assert.equal(await menuPage.locator('#menu-error').isHidden(), true);
  await menuContext.close();
  // Live route uses only server data, handles missing menu, and clears private balance on logout.
  const page=await browser.newPage({viewport:{width:390,height:850}});let loggedIn=true;const writes=[];
  await page.route('**/api/app/**',async route=>{
    const r=route.request(), pathname=new URL(r.url()).pathname.split('/').at(-1);
    if(r.method()==='POST') writes.push({path:pathname,headers:r.headers(),body:r.postData()});
    const values={config:{enabled:true,loginEnabled:true,menuEnabled:false},session:{signedIn:loggedIn,linked:loggedIn,csrf:'synthetic-csrf'},points:{points:321,checkedAt:Date.now()}};
    if(pathname==='logout') loggedIn=false;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(values[pathname]||{signedIn:false})});
  });
  await page.goto(`${origin}/app/`);await page.waitForFunction(()=>document.querySelector('#home-balance').textContent.includes('321'));
  await page.evaluate(()=>navigator.serviceWorker.ready);
  const cachedURLs=await page.evaluate(async()=>{
    const output=[];for(const name of await caches.keys()) for(const req of await (await caches.open(name)).keys()) output.push(req.url);
    return output;
  });
  assert.ok(cachedURLs.length>0);assert.ok(cachedURLs.every(url=>!url.includes('/api/')));
  await page.locator('.account-link').click();await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByText('You’re signed out.',{exact:true}).waitFor();
  assert.ok(!(await page.locator('#home-balance').innerText()).includes('321'));
  assert.equal(writes[0].headers['x-treehouse-csrf'],'synthetic-csrf');assert.equal(writes[0].headers.origin,origin);
  assert.ok(!writes[0].body.includes('customer'));assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await page.unroute('**/api/app/**');
  await page.context().setOffline(true);
  await page.reload();
  await page.getByText('You’re offline or the app is temporarily unavailable.',{exact:false}).waitFor();
  assert.ok(!(await page.locator('#home-balance').innerText()).includes('321'));
  await page.close();
  console.log('PASS: 360/390/1365px layouts, no overflow or browser errors, filters, demo isolation, points, logout, CSRF/Origin, public-only offline shell, and no private browser storage.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
