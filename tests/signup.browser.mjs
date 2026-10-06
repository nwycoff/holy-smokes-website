// Local synthetic QA: no Auth0, GrowFlow, Cloudflare or customer records are contacted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.' + url.pathname + (url.pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'text/plain',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; object-src 'none'", 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] } : {}) });
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
try {
  for (const width of [360, 390, 1365]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block', permissions: ['notifications'],
      ...(width === 390 ? { userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36' } : {}),
      ...(width === 360 ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } : {}) });
    if (width === 360) await page.addInitScript(() => { delete window.PushManager; });
    const errors = [], requests = []; let linked = false, sessions = 0;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/app/**', async route => {
      const req = route.request(), key = new URL(req.url()).pathname.slice('/api/app/'.length);
      requests.push({ key, body: req.postData(), csrf: req.headers()['x-treehouse-csrf'] });
      if (key === 'enroll') { assert.equal(JSON.parse(req.postData()).code, '1234 5678'); linked = true; }
      if (key === 'session') sessions++;
      const data = { config: { enabled: true, loginEnabled: true, signupTrackingEnabled: true, marketingEnabled: true, pushKey: 'synthetic-public-key' },
        session: { signedIn: true, linked, csrf: 'synthetic-csrf', ...(linked ? { marketing: { topics: [], ask: false } } : {}) },
        'signup/visit': { recorded: true }, enroll: { linked: true }, points: { points: 321, checkedAt: Date.now() } };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data[key] || {}) });
    });
    await page.goto(`${origin}/app/?from=bag-card-v1#setup`);
    const setup = page.locator('#setup-content');
    await setup.getByLabel('Connection code').waitFor({ timeout: 10000 }).catch(async error => {
      console.error({ errors, requests, page: await page.locator('body').innerText() }); throw error;
    });
    assert.equal(new URL(page.url()).search, '');
    assert.equal(requests.filter(r => r.key === 'signup/visit').length, 1);
    assert.deepEqual(JSON.parse(requests.find(r => r.key === 'signup/visit').body), { source: 'bag-card-v1' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width === 390) await page.screenshot({ path: fileURLToPath(new URL('../docs/signup-connect-mobile.png', import.meta.url)), fullPage: true });
    await setup.getByLabel('Connection code').fill('1234 5678');
    await setup.getByRole('button', { name: 'Connect my points →', exact: true }).click();
    await setup.getByText('Your balance is 321 points.', { exact: true }).waitFor();
    const homeScreenStep = setup.locator('.setup-progress li').nth(2);
    assert.equal(await setup.locator('.setup-progress li').count(), 4);
    assert.equal(await homeScreenStep.innerText(), 'Add to Home Screen');
    assert.equal(await homeScreenStep.getAttribute('class'), null);
    await setup.getByRole('heading', { name: '4. Choose notifications (optional)', exact: true }).waitFor();
    if (width === 360) {
      assert.equal(await setup.getByRole('button', { name: 'Install Treehouse', exact: true }).count(), 0);
      assert.equal(await setup.getByRole('button', { name: 'Turn on Deals & news', exact: true }).count(), 0);
      await setup.locator('.install-guide summary').click();
      await setup.getByRole('heading', { name: 'Open Share in Safari', exact: true }).waitFor();
      assert.match(await setup.locator('.install-guide').innerText(), /Open as Web App/);
      assert.equal(await homeScreenStep.getAttribute('class'), null, 'opening instructions is not an installation');
      await page.screenshot({ path: fileURLToPath(new URL('../docs/signup-install-iphone.png', import.meta.url)), fullPage: true });
    } else await setup.getByRole('heading', { name: 'Deals & news', exact: true }).waitFor();
    assert.ok(sessions >= 2, 'fresh session supplies marketing state immediately after enrollment');
    assert.equal(requests.find(r => r.key === 'enroll').csrf, 'synthetic-csrf');
    assert.equal(requests.some(r => /marketing|push\/subscribe/.test(r.key)), false, 'no automatic consent or push subscription');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width !== 360) await page.screenshot({ path: fileURLToPath(new URL(`../docs/signup-connected-${width === 390 ? 'mobile' : 'desktop'}.png`, import.meta.url)), fullPage: true });
    if (width === 390) {
      // A real prompt requires a browser-provided event and a user click. Synthetic events
      // exercise accepted/dismissed/error handling; they do not prove phone installation.
      for (const outcome of ['dismissed', 'error', 'accepted']) {
        await page.evaluate(outcome => {
          const event = new Event('beforeinstallprompt', { cancelable: true });
          window.installCalls = 0;
          event.prompt = async () => {
            window.installCalls++;
            window.installHadUserGesture = navigator.userActivation.isActive;
            if (outcome === 'error') throw new Error('Synthetic prompt failure');
            return { outcome };
          };
          dispatchEvent(event); window.installDefaultPrevented = event.defaultPrevented;
        }, outcome);
        assert.equal(await page.evaluate(() => window.installCalls), 0, 'never open the prompt automatically');
        if (outcome === 'dismissed') await page.screenshot({ path: fileURLToPath(new URL('../docs/signup-install-android.png', import.meta.url)), fullPage: true });
        await setup.getByRole('button', { name: 'Install Treehouse', exact: true }).click();
        await setup.locator('.setup-install [role="status"]').waitFor();
        assert.equal(await page.evaluate(() => window.installCalls), 1);
        assert.equal(await page.evaluate(() => window.installHadUserGesture), true);
        assert.equal(await page.evaluate(() => window.installDefaultPrevented), true);
        assert.equal(await setup.getByRole('button', { name: 'Install Treehouse', exact: true }).count(), 0, 'used events cannot be reused');
        assert.equal(await homeScreenStep.getAttribute('class'), null, 'acceptance alone does not mean the app has been opened');
        if (outcome === 'error') {
          assert.match(await setup.locator('[role="status"]').innerText(), /couldn’t open/);
          assert.equal(await setup.locator('.install-guide').getAttribute('open'), '');
        }
      }
      await page.evaluate(() => dispatchEvent(new Event('appinstalled')));
      assert.equal(await homeScreenStep.getAttribute('class'), null, 'appinstalled in a browser tab does not complete the open-app step');
      // Exercise an installed iPhone/iPad-style launch: instructions and install buttons go
      // away, and the step is complete without granting notification/marketing consent.
      await page.evaluate(() => { Object.defineProperty(navigator, 'standalone', { value: true }); dispatchEvent(new Event('appinstalled')); });
      assert.equal(await homeScreenStep.getAttribute('class'), 'complete');
      await setup.getByText('✓ You’re using the installed app.', { exact: true }).waitFor();
      assert.equal(await setup.locator('.install-guide').count(), 0);
      assert.equal(await setup.locator('.setup-progress li').nth(3).getAttribute('class'), null);
      assert.equal(requests.some(r => /marketing|push\/subscribe/.test(r.key)), false);
      // Installing is optional: the customer's normal menu remains available throughout.
      await setup.getByRole('link', { name: 'Finish setup and browse the menu →', exact: true }).click();
      assert.equal(new URL(page.url()).hash, '#menu');
    }
    assert.deepEqual(errors, []); await page.close();
  }
  // A tracking outage cannot block sign-in. Signup and returning-account actions are separate.
  const page = await browser.newPage({ viewport: { width: 390, height: 850 }, serviceWorkers: 'block' });
  let canResend = false, requested = false;
  await page.route('**/api/app/**', async route => {
    const req = route.request(), key = new URL(req.url()).pathname.slice('/api/app/'.length);
    if (key === 'signup/visit') { await route.abort(); return; }
    if (key === 'verification/resend') { assert.equal(req.headers()['x-treehouse-csrf'], 'verification-csrf'); assert.deepEqual(JSON.parse(req.postData()), {}); requested = true; }
    const data = { config: { enabled: true, loginEnabled: true, signupTrackingEnabled: true }, session: { signedIn: false },
      'verification/status': { canResend, csrf: 'verification-csrf' }, 'verification/resend': { requested: true } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data[key] || {}) });
  });
  await page.goto(`${origin}/app/?from=register-1#setup`);
  const setup = page.locator('#setup-content');
  await setup.getByRole('button', { name: 'Create account →', exact: true }).waitFor();
  assert.equal(await setup.locator('form').nth(0).getAttribute('action'), '/api/app/signup');
  assert.equal(await setup.locator('form').nth(1).getAttribute('action'), '/api/app/login');
  canResend = true; await page.goto(`${origin}/app/#verify-email`);
  await setup.getByRole('button', { name: 'Resend verification email', exact: true }).click();
  assert.equal(requested, true);
  await page.getByText('Another verification email was requested.', { exact: false }).waitFor();
  assert.equal(await setup.locator('form').getAttribute('action'), '/api/app/login');
  await page.screenshot({ path: fileURLToPath(new URL('../docs/signup-verify-mobile.png', import.meta.url)), fullPage: true });
  await page.close();

  const crm = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const errors = []; crm.on('pageerror', e => errors.push(e.message));
  let spend = [];
  const row = { source: 'bag-card-v1', label: 'Bag inserts · version 1', visitors: 40, started: 22, verified: 17, linked: 14,
    reachable: 10, reachable_now: 9, preorder_customers: 3, visit_customers: 5, revenue_cents: 22000, spend_cents: 0 };
  await crm.route('**/api/crm/**', async route => {
    const req = route.request(), key = new URL(req.url()).pathname.slice('/api/crm/'.length);
    if (key === 'signups/spend') {
      assert.equal(req.headers()['x-crm-csrf'], 'crm-csrf');
      const input = JSON.parse(req.postData()); assert.equal(input.cents, 1500);
      assert.match(input.id, /^[a-f0-9]{32}$/); spend = [{ ...input, spent_at: Date.now() }];
    }
    const data = { session: { email: 'owner@example.test', groups: [], csrf: 'crm-csrf' }, overview: {}, segments: { segments: [] }, audit: { audit: [] }, brands: { brands: [] },
      signups: { available: true, trackingEnabled: true, rows: [{ ...row, spend_cents: spend.length ? 1500 : 0 }], spend, salesComplete: true }, 'signups/spend': { saved: true } };
    await route.fulfill({ status: ['campaigns', 'assistant', 'alerts'].includes(key) ? 400 : 200, contentType: 'application/json', body: JSON.stringify(data[key] || { error: 'Not switched on' }) });
  });
  await crm.goto(`${origin}/crm/`);
  await crm.locator('#signup-results').getByRole('heading', { name: row.label, exact: true }).waitFor();
  assert.equal(await crm.locator('#signup-links a').first().getAttribute('href'), 'https://www.treehousepharmacy.com/go/bag-card-v1');
  assert.equal(await crm.locator('#signup-links a').nth(1).getAttribute('href'), '/assets/signup-qr/bag-card-v1.svg');
  await crm.getByText('Record printing or placement costs', { exact: true }).click();
  await crm.locator('#signup-spend-amount').fill('15');
  await crm.locator('#signup-spend-form button').click();
  await crm.getByText('$1.07 per connected account', { exact: true }).waitFor();
  await crm.locator('#signups-section').screenshot({ path: fileURLToPath(new URL('../docs/signup-crm.png', import.meta.url)) });
  assert.deepEqual(errors, []); await crm.close();
  console.log('PASS: four-step setup at 360/390/1365px, iPhone installation guide, install prompt acceptance/dismissal/failure with a user gesture, standalone completion, no automatic consent, source tracking, enrollment, email verification, and CRM source/cost report.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
