import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out);
// Explicit public-file allowlist: no backend, documentation, tests, or secrets.
for (const name of await readdir(root)) {
  if (name.endsWith('.html') || ['images', 'blog', 'assets', 'app', '_headers'].includes(name)) {
    await cp(path.join(root, name), path.join(out, name), { recursive: true });
  }
}
await writeFile(path.join(out, '_routes.json'), JSON.stringify({
  version: 1, include: ['/api/rewards/*', '/api/app/*'], exclude: []
}, null, 2));
// Same UI in a separately labelled, static demo. It never calls live APIs.
await mkdir(path.join(out, 'app', 'demo'), { recursive: true });
await cp(path.join(out, 'app', 'index.html'), path.join(out, 'app', 'demo', 'index.html'));
console.log('Static website built in dist/. Pages bundles functions/ separately.');
