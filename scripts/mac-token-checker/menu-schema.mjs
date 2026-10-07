import { pathToFileURL } from 'node:url';
import { readHidden, transport } from './check.mjs';
import { runMenuSchemaCheck } from './menu-schema-core.mjs';

export async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('Open this checker in Terminal. Piped input is disabled to keep entries hidden.');
    process.exitCode = 1; return;
  }
  console.log('Treehouse GrowFlow MENU LAB-RESULTS CHECK - Mac v1');
  console.log('Read-only. Up to three API requests: the schema (type definitions only), 8 inventory rows');
  console.log('(quantity and room only) and, if you enter the menu key, lab results for menu products.');
  console.log('No customer data is requested. Entries stay hidden, including while pasting. Press Enter after each.\n');
  const input = {};
  try {
    input.token = await readHidden('App GrowFlow token from Bitwarden (APP_GROWFLOW_TOKEN, starts with gfr_)');
    input.menuKey = await readHidden('Menu key (APP_MENU_KEY; press Enter to skip the menu sample)');
    console.log('');
    process.exitCode = await runMenuSchemaCheck(input, { transport, log: line => console.log(line) });
  } catch {
    console.log('Stopped or cancelled. No raw errors or private entries displayed. No automatic retry.');
    process.exitCode = 1;
  } finally { for (const key of Object.keys(input)) input[key] = null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
