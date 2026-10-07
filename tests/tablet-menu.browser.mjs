// Synthetic data only; no live customer or inventory requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { demoMenu } from '../assets/customer/demo-data.js';
import { classifyProduct, DEPARTMENTS, HOUSE } from '../server/customer-app/taxonomy.mjs';
const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const server = createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost');
  const name = path.resolve(root, '.'+url.pathname+(url.pathname.endsWith('/') ? 'index.html' : ''));
  if (!name.startsWith(root+path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(name);
    res.writeHead(200, {'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[path.extname(name)] || 'text/plain',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"});
    res.end(body);
  } catch { res.writeHead(404);res.end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage','--single-process','--no-zygote','--use-gl=angle','--use-angle=swiftshader','--in-process-gpu']} : {})});
try {
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[],calls=[];let fail=false;
  page.on('pageerror', error=>errors.push(error.message));
  await page.clock.install();
  await page.route('**/api/**',async route=>{
    calls.push(new URL(route.request().url()).pathname);
    await route.fulfill({status:fail?503:200,contentType:'application/json',body:JSON.stringify(fail ? {error:'Temporary failure'} : {...demoMenu,updatedAt:Date.now()})});
  });
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/tablet/`);
  await page.locator('.product').first().waitFor({timeout:10000}).catch(async error => { console.log({errors,calls,body:await page.locator('body').innerText()}); throw error; });
  assert.equal(await page.locator('.product').count(),7);
  assert.equal(await page.locator('a').count(),0, 'No links out to account or ordering');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'/tmp/treehouse-tablet-landscape.png',fullPage:true});
  await page.locator('#search').fill('sample');
  await page.locator('#type').selectOption('sativa');
  assert.equal(await page.locator('.product').count(),1);
  await page.setViewportSize({width:800,height:1280});
  assert.equal(await page.locator('#search').inputValue(),'sample');
  assert.equal(await page.locator('#type').inputValue(),'sativa');
  assert.equal(await page.locator('.product').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#reset').click();
  await page.locator('#size').selectOption('14 g');
  await page.locator('#budget').selectOption('under20');
  assert.equal(await page.locator('.product').count(),0, 'Size and budget must match the same variant');
  await page.locator('#clear').click();
  await page.screenshot({path:'/tmp/treehouse-tablet-portrait.png',fullPage:true});
  await page.locator('#search').fill('golden');
  await page.clock.fastForward(121000);
  assert.equal(await page.locator('#search').inputValue(),'');
  assert.equal(await page.locator('.product').count(),7);
  fail=true;
  await page.evaluate(()=>dispatchEvent(new Event('online')));
  await page.clock.runFor(1500);
  await page.getByText('Showing the last available menu while we reconnect.',{exact:false}).waitFor();
  assert.equal(await page.locator('.product').count(),7);
  fail=false;
  await page.evaluate(()=>dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.getElementById('notice').hidden);
  // Realistic scroll preservation across a portrait/landscape rotation.
  await page.route('**/api/app/menu',async route=>route.fulfill({contentType:'application/json',body:JSON.stringify({...demoMenu,updatedAt:Date.now(),products:Array.from({length:10},(_,i)=>demoMenu.products.map(p=>({...p,id:`${p.id}-${i}`}))).flat()})}));
  await page.evaluate(()=>dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.querySelectorAll('.product').length===70);
  await page.evaluate(()=>scrollTo(0,1800)); await page.clock.runFor(200);
  const before=await page.evaluate(()=>[...document.querySelectorAll('.product')].find(p=>p.getBoundingClientRect().bottom>0)?.dataset.productId);
  await page.setViewportSize({width:1280,height:800}); await page.clock.runFor(500);
  const after=await page.evaluate(()=>[...document.querySelectorAll('.product')].find(p=>p.getBoundingClientRect().bottom>0)?.dataset.productId);
  // Different column counts can expose an adjacent card in the same row, so verify the
  // previously visible card is still within the viewport rather than requiring first position.
  assert.ok(await page.locator(`[data-product-id="${before}"]`).evaluate(p=>p.getBoundingClientRect().bottom>0 && p.getBoundingClientRect().top<innerHeight), `${before} should stay visible after rotation (first now ${after})`);
  await page.setViewportSize({width:600,height:960});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  // Server-side departments and sub-filters (taxonomy.mjs) with synthetic products.
  const entries=[['Tree House Top Shelf Flower'],['Tree House Small Bud'],['Pre-Roll'],['Pre-Roll Multipack'],['Infused Pre-Roll'],['Infused Pre-Roll Multi pk'],
    ['Infused Shake'],['Pre-Pack Shake'],['New unmapped category'],['Infused Blunt','MoonRock Blunt - 2pk - Sample'],['Infused Blunt','Sample Blunt | 2.5g'],['Waste']];
  const placedProducts=entries.map(([sourceCategory,name=demoMenu.products[0].name],i)=>{const placed=classifyProduct(sourceCategory,name);
    return placed && {...demoMenu.products[0],id:`facet-${i}`,name,sourceCategory,category:placed.department,facets:placed.facets,also:placed.house?[HOUSE]:[],...(placed.house?{house:true}:{})};}).filter(Boolean);
  const placedCategories=[HOUSE,...DEPARTMENTS.filter(d=>placedProducts.some(p=>p.category===d))];
  await page.route('**/api/app/menu',async route=>route.fulfill({contentType:'application/json',body:JSON.stringify({...demoMenu,updatedAt:Date.now(),categories:placedCategories,products:placedProducts})}));
  await page.evaluate(()=>dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.querySelectorAll('.product').length===11);
  await page.locator('#categories>button').filter({hasText:'Treehouse'}).click();
  assert.equal(await page.locator('.product').count(),2);
  await page.getByRole('checkbox',{name:'Whole flower',exact:false}).check();
  assert.equal(await page.locator('.product').count(),1);
  assert.match(await page.locator('.product-category').textContent(),/Whole flower/);
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:'/tmp/treehouse-tablet-treehouse-filters.png',fullPage:true});
  await page.locator('#categories>button').filter({hasText:'Pre-Rolls'}).click();
  assert.equal(await page.locator('.product').count(),6);
  const packAll=page.locator('#category-facets fieldset',{hasText:'Pack'}).getByRole('checkbox',{name:/^All/});
  assert.equal(await packAll.isChecked(),true,'All is checked while nothing in the group is picked');
  await page.getByRole('checkbox',{name:'Multipacks',exact:false}).check();
  assert.equal(await page.locator('.product').count(),3,'Multipacks alone: regular, infused and 2-pack blunts');
  assert.equal(await packAll.isChecked(),false);
  await packAll.check();
  assert.equal(await page.locator('.product').count(),6,'All clears the group');
  await page.getByRole('checkbox',{name:'Multipacks',exact:false}).check();
  await page.getByRole('checkbox',{name:'Infused',exact:false}).check();
  assert.equal(await page.locator('.product').count(),2);
  await page.getByRole('checkbox',{name:'Blunts',exact:false}).check();
  assert.equal(await page.locator('.product').count(),1);
  assert.match(await page.locator('.product-category').textContent(),/Infused.*Blunts.*Multipacks/);
  await page.getByRole('checkbox',{name:'Joints',exact:false}).check();
  assert.equal(await page.locator('.product').count(),2,'Both formats checked shows both');
  await page.getByRole('checkbox',{name:'Infused',exact:false}).uncheck();
  await page.getByRole('checkbox',{name:'Multipacks',exact:false}).uncheck();
  await page.getByRole('checkbox',{name:'Singles',exact:false}).check();
  await page.getByRole('checkbox',{name:'Joints',exact:false}).uncheck();
  assert.equal(await page.locator('.product').count(),1,'Single blunt');
  assert.equal(await page.getByRole('checkbox',{name:'Regular',exact:false}).isDisabled(),true,'No regular single blunts: box disabled');
  await page.setViewportSize({width:800,height:1280});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'/tmp/treehouse-tablet-preroll-filters.png',fullPage:true});
  await page.locator('#categories>button').filter({hasText:'Shake'}).click();
  assert.equal(await page.locator('.product').count(),2,'Shake heading: regular and infused shake');
  await page.getByRole('checkbox',{name:'Infused shake',exact:false}).check();
  assert.equal(await page.locator('.product').count(),1);
  await page.locator('#reset').click();
  assert.equal(await page.locator('.product').count(),11,'Unknown category remains visible (More); waste is never shown; reset clears subfilters');
  assert.deepEqual(errors,[]);
  assert.deepEqual([...new Set(calls)],['/api/app/menu']);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  console.log('PASS: landscape/portrait layout, search, filters, same-variant budget matching, idle reset, retry/retention/recovery, rotation position, menu-only requests and no browser storage.');
} finally {await browser.close(); await new Promise(resolve=>server.close(resolve));}

