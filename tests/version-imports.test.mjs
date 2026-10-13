import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { versionImports } from '../scripts/version-imports.mjs';

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 12);

test("a script's imports carry their files' content versions, and a changed file changes its importers", async () => {
 const dir = await mkdtemp(path.join(tmpdir(), 'version-imports-'));
 try {
  const files = { 'menu.js': "import { a } from './categories.js';\nconst demo = () => import(\"./demo.js\");\nimport x from 'https://elsewhere.example/x.js';\n",
   'categories.js': "import { b } from './shared.js';\nexport const a = 1;\n", 'shared.js': 'export const b = 2;\n', 'demo.js': 'export default 3;\n' };
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
  const all = Object.keys(files).map(name => path.join(dir, name));
  await versionImports(all);
  const read = name => readFile(path.join(dir, name), 'utf8');
  const categories = await read('categories.js');
  assert.equal(categories, `import { b } from './shared.js?v=${hash(files['shared.js'])}';\nexport const a = 1;\n`);
  const menu = await read('menu.js');
  assert.ok(menu.includes(`from './categories.js?v=${hash(categories)}'`), 'versioned by the rewritten categories.js, so a change two levels down still shows');
  assert.ok(menu.includes(`import("./demo.js?v=${hash(files['demo.js'])}")`));
  assert.ok(menu.includes("from 'https://elsewhere.example/x.js'"), 'other addresses are left alone');
  assert.equal(await versionImports(all), 0, 'nothing more to do on a second run');
  await writeFile(path.join(dir, 'shared.js'), 'export const b = 22;\n');
  await versionImports(all);
  assert.notEqual(await read('menu.js'), menu, 'a change in shared.js reaches menu.js through categories.js');
 } finally { await rm(dir, { recursive: true, force: true }); }
});
