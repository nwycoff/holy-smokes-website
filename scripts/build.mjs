import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out);
// Explicit public-file allowlist: no backend, documentation, tests, or secrets.
for (const name of await readdir(root)) {
  if (name.endsWith('.html') || ['images', 'blog', 'assets', '_headers'].includes(name)) {
    await cp(path.join(root, name), path.join(out, name), { recursive: true });
  }
}
await writeFile(path.join(out, '_routes.json'), JSON.stringify({
  version: 1, include: ['/api/rewards/*'], exclude: []
}, null, 2));
console.log('Static website built in dist/. Pages bundles functions/ separately.');
