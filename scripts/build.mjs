import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ORIGIN, SITEMAP_PATHS } from '../server/site/menu-page.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out);
// Explicit public-file allowlist: no backend, documentation, tests, or secrets.
for (const name of await readdir(root)) {
  if (name.endsWith('.html') || ['images', 'blog', 'assets', 'app', 'tablet', 'staff', 'crm', '_headers', 'robots.txt'].includes(name)) {
    await cp(path.join(root, name), path.join(out, name), { recursive: true });
  }
}
await writeFile(path.join(out, '_routes.json'), JSON.stringify({
  version: 1, include: ['/api/rewards/*', '/api/app/*', '/api/staff/*', '/api/crm/*', '/go/*', '/menu', '/menu/*'], exclude: []
}, null, 2));
// Give each page's own script and stylesheet a content version (?v=hash), so a release reaches
// phones at once instead of after the custom domain's browser cache expires.
for (const page of ['app/index.html', 'tablet/index.html', 'staff/index.html', 'crm/index.html', 'menu.html', 'rewards.html']) {
  const file = path.join(out, page);
  let html = await readFile(file, 'utf8');
  for (const [ref] of html.matchAll(/\/assets\/(?:customer|tablet|staff|crm|menu)\/[a-z-]+\.(?:js|css)(?=")/g)) {
    const version = createHash('sha256').update(await readFile(path.join(out, ref))).digest('hex').slice(0, 12);
    html = html.replace(`${ref}"`, `${ref}?v=${version}"`);
  }
  await writeFile(file, html);
}
// Precache the exact content-versioned assets referenced by this release's app.
// A new shell cache per release keeps its HTML and assets together offline.
const appHtml = await readFile(path.join(out, 'app/index.html'), 'utf8');
const shellAssets = [...appHtml.matchAll(/(?:href|src)="(\/assets\/customer\/[^" ]+)"/g)].map(match => match[1]);
const shellVersion = createHash('sha256').update(appHtml).digest('hex').slice(0, 12);
const swFile = path.join(out, 'app/sw.js');
let sw = await readFile(swFile, 'utf8');
sw = sw.replace("const CACHE = 'treehouse-shell-v4';", `const CACHE = 'treehouse-shell-v4-${shellVersion}';`)
  .replace(/^const SHELL = .*;$/m, `const SHELL = ${JSON.stringify(['/app/', ...shellAssets, '/app/icon.svg', '/images/img6.png'])};`);
await writeFile(swFile, sw);
// sitemap.xml: home, every Menu page and the blog (published posts only, at their final addresses).
const posts = (await readdir(path.join(root, 'blog'))).filter(f => f.endsWith('.html') && !f.startsWith('_')).map(f => `/blog/${f.replace(/\.html$/, '')}`);
const today = new Date().toISOString().slice(0, 10);
const urls = [['/', 'weekly'], ...SITEMAP_PATHS.map(p => [p, 'daily']), ['/blog', 'weekly'], ...posts.map(p => [p, 'monthly']), ['/privacy', 'yearly']];
await writeFile(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([p, freq]) => `  <url><loc>${ORIGIN}${p}</loc><lastmod>${today}</lastmod><changefreq>${freq}</changefreq></url>`).join('\n')}
</urlset>
`);
// Same UI in a separately labelled, static demo. It never calls live APIs.
await mkdir(path.join(out, 'app', 'demo'), { recursive: true });
await cp(path.join(out, 'app', 'index.html'), path.join(out, 'app', 'demo', 'index.html'));
console.log('Static website built in dist/. Pages bundles functions/ separately.');
