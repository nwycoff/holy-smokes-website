import { pathToFileURL } from 'node:url';
import { readHidden, transport } from './check.mjs';
import { runServingsCheck } from './servings-core.mjs';

export async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('Open this checker in Terminal. Piped input is disabled to keep entries hidden.');
    process.exitCode = 1; return;
  }
  console.log('Treehouse GrowFlow EDIBLE SERVINGS CHECK - Mac v2');
  console.log('Read-only. Three API requests: the schema (type definitions only), menu product names,');
  console.log('and servings per container for up to 10 edibles. No customer data is requested.');
  console.log('Entries stay hidden, including while pasting. Press Enter after each.\n');
  const input = {};
  try {
    input.token = await readHidden('App GrowFlow token from Bitwarden (APP_GROWFLOW_TOKEN, starts with gfr_)');
    input.menuKey = await readHidden('Menu key the website uses (APP_MENU_KEY)');
    console.log('');
    process.exitCode = await runServingsCheck(input, { transport, log: line => console.log(line) });
  } catch {
    console.log('Stopped or cancelled. No raw errors or private entries displayed. No automatic retry.');
    process.exitCode = 1;
  } finally { for (const key of Object.keys(input)) input[key] = null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
