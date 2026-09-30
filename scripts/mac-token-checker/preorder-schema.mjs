import { pathToFileURL } from 'node:url';
import { readHidden, transport } from './check.mjs';
import { runPreorderSchemaCheck } from './preorder-schema-core.mjs';

export async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('Open this checker in Terminal. Piped input is disabled to keep entries hidden.');
    process.exitCode = 1; return;
  }
  console.log('Treehouse GrowFlow PREORDER SCHEMA CHECK - Mac v1');
  console.log('Read-only. Two API requests: the schema (type definitions only) and one status');
  console.log('lookup for a made-up order ID. No orders are created and no customer data is read.');
  console.log('Your entry stays hidden, including while pasting. Press Enter after pasting.\n');
  let token = '';
  try {
    token = await readHidden('PREORDER GrowFlow token from Bitwarden (starts with gfr_)');
    console.log('');
    process.exitCode = await runPreorderSchemaCheck(token, { transport, log: line => console.log(line) });
  } catch {
    console.log('Stopped or cancelled. No raw errors or private entries displayed. No automatic retry.');
    process.exitCode = 1;
  } finally { token = null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
