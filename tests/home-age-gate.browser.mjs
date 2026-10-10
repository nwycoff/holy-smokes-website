// The homepage's age screen: asked once per browser visit, in every tab (a cookie that ends when the
// browser closes), never on later pages or new tabs, and again in a new browser session. Built site only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.jpeg': 'image/jpeg' };
const server = createServer(async (req, res) => {
  let name = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  if (name.endsWith('/')) name += 'index.html'; else if (!path.extname(name)) name += '.html';
  const file = path.resolve(root, '.' + name);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const showing = page => page.locator('#ageGate').isVisible();
try {
  const visit = await browser.newContext();
  await visit.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  const first = await visit.newPage();
  await first.goto(`${base}/`);
  assert.equal(await showing(first), true, 'a new visitor is asked');
  await first.getByRole('button', { name: /18\+/ }).click();
  await first.waitForFunction(() => getComputedStyle(document.getElementById('ageGate')).visibility === 'hidden');
  const cookie = (await visit.cookies()).find(c => c.name === 'treehouse_age_verified');
  assert.ok(cookie && cookie.expires === -1, 'remembered until the browser closes, not longer');
  // A blog post opened in a new tab, then its Get Directions link to the homepage: not asked again.
  const tab = await visit.newPage();
  await tab.goto(`${base}/blog/edible-dosing-guide`);
  await tab.locator('a', { hasText: /get directions/i }).first().click();
  await tab.waitForURL(/#visit$/);
  assert.equal(await showing(tab), false, 'a new tab after confirming is not asked again');
  await tab.reload();
  assert.equal(await showing(tab), false, 'nor after a reload');
  await visit.close();
  // A later browser session (no cookie): asked again.
  const later = await browser.newContext(); const page = await later.newPage();
  await later.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.goto(`${base}/`);
  assert.equal(await showing(page), true, 'a new browser session is asked again');
  await later.close();
  console.log('PASS: homepage age screen asked once per browser visit across tabs, again in a new session.');
} finally { await browser.close(); server.close(); }
