import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../assets/customer/app.js', import.meta.url), 'utf8');
const refresh = app.slice(app.indexOf('async function refreshMenu()'), app.indexOf('\nfunction route()'));
function menuHarness(api, menu = null) {
  const ctx = vm.createContext({ api, menu, demo: false, config: { menuEnabled: true }, menuLoading: false,
    menuError: '', renderMenu() {}, reconcileCart() {}, renderCartBar() {}, applyMenuLink() {},
    setTimeout(fn) { fn(); } });
  vm.runInContext(refresh, ctx);
  return ctx;
}
test('menu retries a temporary failure and clears its loading state', async () => {
  let calls = 0;
  const menu = { products: [{ id: 'one' }], stale: false };
  const ctx = menuHarness(async () => { if (++calls === 1) throw new Error('network'); return menu; });
  await ctx.refreshMenu();
  assert.equal(calls, 2);
  assert.equal(ctx.menu, menu);
  assert.equal(ctx.menuLoading, false);
  assert.equal(ctx.menuError, '');
});
test('failed refresh preserves products, marks them stale, and permits recovery', async () => {
  const products = [{ id: 'one' }];
  const ctx = menuHarness(async () => { throw new Error('network'); }, { products });
  await ctx.refreshMenu();
  assert.equal(ctx.menu.products, products);
  assert.equal(ctx.menu.stale, true);
  assert.match(ctx.menuError, /last available menu/);
  ctx.api = async () => ({ products, stale: false });
  await ctx.refreshMenu();
  assert.equal(ctx.menu.stale, false);
  assert.equal(ctx.menuError, '');
});
test('menu does not retry non-transient client errors', async () => {
  let calls = 0;
  const ctx = menuHarness(async () => { calls++; throw Object.assign(new Error('disabled'), { status: 403 }); });
  await ctx.refreshMenu();
  assert.equal(calls, 1);
  assert.equal(ctx.menu, null);
});
function workerHarness(fetch, entries) {
  const handlers = {};
  const cache = { async match(key) { return entries.get(key); }, async put(key, value) { entries.set(key, value); } };
  vm.runInNewContext(readFileSync(new URL('../app/sw.js', import.meta.url), 'utf8'), {
    URL, fetch, caches: { async open() { return cache; } },
    self: { location: { origin: 'https://example.test' }, addEventListener(name, fn) { handlers[name] = fn; } }
  });
  return (path) => {
    const waits = [];
    const event = { request: new Request(`https://example.test${path}`), waitUntil(p) { waits.push(p); },
      respondWith(p) { this.response = p; } };
    handlers.fetch(event);
    return { event, waits };
  };
}
test('cached app renders without waiting for network; public shell refreshes in background', async () => {
  let finish;
  const entries = new Map([['/app/', new Response('saved shell')]]);
  const dispatch = workerHarness(() => new Promise(resolve => { finish = resolve; }), entries);
  const { event, waits } = dispatch('/app/');
  assert.equal(await (await event.response).text(), 'saved shell');
  finish(new Response('new shell'));
  await Promise.all(waits);
  assert.equal(await entries.get('/app/').text(), 'new shell');
});
test('versioned assets use exact cached version and never intercept private APIs or callback queries', async () => {
  let calls = 0;
  const dispatch = workerHarness(async () => { calls++; return new Response('new version'); },
    new Map([['/assets/customer/app.js?v=111111111111', new Response('cached version')]]));
  const cached = dispatch('/assets/customer/app.js?v=111111111111');
  assert.equal(await (await cached.event.response).text(), 'cached version');
  assert.equal(calls, 0);
  const different = dispatch('/assets/customer/app.js?v=222222222222');
  assert.equal(await (await different.event.response).text(), 'new version');
  assert.equal(calls, 1);
  for (const path of ['/api/app/menu', '/api/app/session', '/api/app/points', '/app/?code=private'])
    assert.equal(dispatch(path).event.response, undefined);
});
