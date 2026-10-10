import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(root, file), 'utf8');
const pages = async () => ['index.html', 'menu.html', 'blog.html', ...(await readdir(path.join(root, 'blog'))).filter(f => f.endsWith('.html')).map(f => `blog/${f}`)];

test('the committed site stylesheet is current (run npm run css after changing classes)', async () => {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'site-css-')), 'styles.css');
  await promisify(execFile)(path.join(root, 'node_modules/.bin/tailwindcss'),
    ['-c', 'tailwind.config.cjs', '-i', 'scripts/site-css/input.css', '-o', out], { cwd: root });
  assert.equal(await readFile(out, 'utf8'), await read('assets/site/styles.css'));
});

test('website pages load no styles, fonts or scripts from other sites, and use the shared stylesheet last in <head>', async () => {
  for (const page of await pages()) {
    const html = await read(page);
    assert.doesNotMatch(html, /cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|jotform/, page);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/site\/styles\.css" \/>\n<\/head>/, page);
    for (const [img] of html.matchAll(/<img\b[^>]*>/g)) assert.match(img, /\bwidth="\d+" height="\d+"/, `${page}: ${img}`);
    for (const [, src] of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
      const file = src.startsWith('/') ? src.slice(1) : path.join(path.dirname(page), src);
      await stat(path.join(root, file));
    }
  }
  for (const [, font] of (await read('assets/site/styles.css')).matchAll(/url\((\/assets\/fonts\/[^)]+)\)/g)) await stat(path.join(root, font));
});

test('the homepage tells search engines the right place: map pin at the store, old name, Google listing', async () => {
  const html = await read('index.html');
  const data = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(data.name, 'Treehouse Pharmacy'); assert.equal(data.alternateName, 'Holy Smokes Dispensary');
  assert.deepEqual([Number(data.geo.latitude), Number(data.geo.longitude)], [36.7238, -97.0851]); // 1801 N Union St (US Census geocoder)
  assert.match(data.hasMap, /^https:\/\/www\.google\.com\/maps\?cid=\d+$/);
  assert.ok(/<title>([^<]+)<\/title>/.exec(html)[1].length <= 65, 'title fits in search results');
  assert.ok(/<meta name="description" content="([^"]+)"/.exec(html)[1].length <= 160, 'description fits in search results');
});
