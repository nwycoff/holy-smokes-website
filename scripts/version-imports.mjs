// Content versions for the scripts our scripts import (assets/tablet/menu.js imports
// ./categories.js). Pages already link each script with ?v=<hash>, but an import inside a script
// is a separate address: on the custom domain the browser keeps a copy for up to 4 hours (the
// domain's browser cache setting overrides our no-cache), so right after a release a device could
// pair the new menu.js with its saved old categories.js. Then the import fails and the whole menu
// stops before it shows anything (the counter tablet, 2026-10-13). Each relative import gets its
// file's content hash, rewritten until nothing changes, so an imported file that itself imports
// gets the right version too. Run it before the pages are versioned, so a changed import also
// changes the importer's own version.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const IMPORT = /(from\s*|import\(\s*)(['"])\.\/([a-z0-9-]+\.js)(?:\?v=[0-9a-f]+)?\2/g;

export async function versionImports(files) {
  const known = new Set(files.map(file => path.resolve(file)));
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const file of known) {
      const source = await readFile(file, 'utf8');
      const versions = new Map();
      for (const [, , , name] of source.matchAll(IMPORT)) {
        const target = path.join(path.dirname(file), name);
        if (!known.has(target) || versions.has(name)) continue;
        versions.set(name, createHash('sha256').update(await readFile(target)).digest('hex').slice(0, 12));
      }
      const next = source.replace(IMPORT, (match, lead, quote, name) => versions.has(name) ? `${lead}${quote}./${name}?v=${versions.get(name)}${quote}` : match);
      if (next !== source) { await writeFile(file, next); changed = true; }
    }
    if (!changed) return pass;
  }
  throw new Error('versionImports: imports kept changing (an import cycle?)');
}
