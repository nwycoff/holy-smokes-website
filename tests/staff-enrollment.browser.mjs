// Synthetic staff-page browser checks; never accesses Cloudflare, GrowFlow, or a real printer.
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
  if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'text/plain',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'",
      'Cache-Control': 'no-store' }).end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
try {
  await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
  for (const width of [390, 1365]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [], writes = []; let unauthorized = false;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/staff/**', async route => {
      const request = route.request(), action = new URL(request.url()).pathname.split('/').at(-1);
      if (request.method() === 'POST') writes.push({ action, headers: request.headers(), body: request.postDataJSON() });
      const responses = { session: { email: 'staff@example.test', csrf: 'synthetic-csrf' },
        match: { name: 'Sample Customer', ticket: 'a'.repeat(64), expiresAt: Date.now() + 120000 },
        issue: { code: '0123 4567', expiresAt: Date.now() + 600000, appUrl: 'https://example.test/app/' } };
      await route.fulfill({ status: unauthorized ? 403 : 200, contentType: 'application/json',
        body: JSON.stringify(unauthorized ? { error: 'Your staff session changed. Reload this page and try again.' } : responses[action]) });
    });
    await page.goto(`${origin}/staff/`); await page.locator('#lookup-panel').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: fileURLToPath(new URL(`../docs/staff-enrollment-${width === 390 ? 'mobile' : 'desktop'}.png`, import.meta.url)), fullPage: true });
    await page.locator('#customer-name').fill('Sample Customer'); await page.locator('#patient-ending').fill('ABC-12');
    await page.getByRole('button', { name: 'Find customer' }).click(); await page.locator('#confirm-panel').waitFor();
    assert.equal(await page.locator('#customer-name').inputValue(), '');
    await page.getByRole('button', { name: 'Generate connection code' }).click();
    assert.equal(writes.length, 1); // Native required checkbox blocks issuance.
    await page.locator('#identity-checked').check(); await page.getByRole('button', { name: 'Generate connection code' }).click();
    await page.locator('#result-panel').waitFor(); assert.equal(writes.length, 2);
    assert.equal(await page.locator('#connection-code').textContent(), '0123 4567');
    assert.equal(writes[0].headers['x-treehouse-csrf'], 'synthetic-csrf');
    assert.deepEqual(writes[1].body, { ticket: 'a'.repeat(64), identityChecked: true });
    assert.equal(await page.locator('#matched-name').textContent(), '');
    await page.evaluate(() => { window.print = () => { window.printCalled = true; }; });
    await page.getByRole('button', { name: 'Print customer slip' }).click(); assert.equal(await page.evaluate(() => window.printCalled), true);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.session').isVisible(), false); assert.equal(await page.locator('#print-slip').isVisible(), true);
    assert.ok(!(await page.locator('#print-slip').innerText()).includes('Sample Customer'));
    if (width === 1365) await page.screenshot({ path: fileURLToPath(new URL('../docs/staff-enrollment-slip.png', import.meta.url)), fullPage: true });
    await page.emulateMedia({ media: 'screen' });
    await page.getByRole('button', { name: 'Clear & next customer' }).click();
    assert.equal(await page.locator('#connection-code').textContent(), ''); assert.equal(await page.locator('#lookup-panel').isVisible(), true);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    unauthorized = true;
    await page.locator('#customer-name').fill('Sample Customer'); await page.locator('#patient-ending').fill('ABC-12');
    await page.getByRole('button', { name: 'Find customer' }).click(); await page.getByText('Your staff session changed.', { exact: false }).waitFor();
    assert.equal(await page.locator('#lookup-panel').isVisible(), false);
    assert.equal(await page.locator('#customer-name').inputValue(), ''); assert.deepEqual(errors, []);
    await page.close();
  }
  // Customer connection input offers a numeric keyboard and preserves leading zeroes.
  const customer = await browser.newPage({ viewport: { width: 390, height: 850 } });
  const claims = [], customerErrors = []; customer.on('pageerror', e => customerErrors.push(e.message));
  await customer.route('**/api/app/**', async route => {
    const req = route.request(), action = new URL(req.url()).pathname.split('/').at(-1);
    if (action === 'enroll') claims.push(req.postDataJSON());
    const responses = { config: { enabled: true, loginEnabled: true, menuEnabled: false },
      session: { signedIn: true, linked: false, csrf: 'synthetic-csrf' }, enroll: { linked: true }, points: { points: 123 } };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(responses[action] || {}) });
  });
  await customer.goto(`${origin}/app/#rewards`);
  const input = customer.locator('#connection-code'); await input.waitFor();
  assert.equal(await input.getAttribute('inputmode'), 'numeric');
  assert.equal(await input.getAttribute('placeholder'), '1234 5678');
  await input.fill('0123 4567'); await customer.getByRole('button', { name: 'Connect my points →' }).click();
  await customer.getByText('Your rewards are connected.', { exact: false }).waitFor();
  assert.deepEqual(claims, [{ code: '0123 4567' }]); assert.deepEqual(customerErrors, []);
  assert.equal(await customer.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await customer.close();
  console.log('PASS: desktop/mobile staff flow, identity confirmation, CSRF, printable slip, clearing, denied access and eight-digit customer entry.');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
