import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { ENDPOINT, runCheck } from './check-core.mjs';

// Input is never echoed, stored in readline history, or passed as a shell argument.
export function readHidden(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) return Promise.reject(new Error('TTY_REQUIRED'));
  return new Promise((resolve, reject) => {
    const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const rl = createInterface({ input, output: silent, terminal: true, historySize: 0 });
    let finished = false;
    output.write(prompt + ': ');
    const cancel = () => {
      if (finished) return;
      finished = true; rl.close(); output.write('\n'); reject(new Error('CANCELLED'));
    };
    rl.once('SIGINT', cancel);
    rl.once('close', cancel);
    rl.once('error', cancel);
    // Cancel instead of suspending with a credential buffered in the terminal.
    rl.once('SIGTSTP', cancel);
    rl.question('', value => {
      finished = true; rl.close(); output.write('\n'); resolve(value.trim());
    });
  });
}

export function transport({ token, query, variables, maxBytes = 524288 }) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ query, variables }), 'utf8');
    // Native https does not follow redirects. Certificate verification is explicit.
    const req = httpsRequest(ENDPOINT, {
      method: 'POST', rejectUnauthorized: true,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length },
    }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new Error('RESPONSE_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      res.on('error', () => reject(new Error('RESPONSE_FAILURE')));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('TIMEOUT')), 20000);
    req.on('error', () => { clearTimeout(timer); reject(new Error('REQUEST_FAILURE')); });
    req.end(body);
  });
}

export async function main() {
  const diagnoseCustomer = process.argv.includes('--diagnose-customer');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('Open this checker in Terminal. Piped input is disabled to keep entries hidden.');
    process.exitCode = 1; return;
  }
  console.log(diagnoseCustomer ? 'Treehouse GrowFlow CUSTOMER MATCH DIAGNOSTIC - Mac v8.1' : 'Treehouse GrowFlow token access check - Mac v8.1');
  console.log('Read-only. At most three API requests; no token exchange, pagination, or automatic retries.');
  console.log('All entries stay hidden, including while pasting. Press Enter after each entry.');
  console.log('The script does not save credentials, patient details, or a report.');
  console.log('Use a known consenting customer. Customer access is organization-wide.');
  console.log(diagnoseCustomer ? 'Required Read scope: Customers. Receipt access is not retested.\n' : 'Required Read scopes: Customers for the customer check; Orders for the receipt check.\n');
  const input = {};
  try {
    input.token = await readHidden('New GrowFlow API token from Bitwarden (starts with gfr_)');
    input.name = await readHidden('Full customer name as stored in GrowFlow (Enter to skip)');
    if (input.name) {
      input.suffix = await readHidden('Final FIVE patient-ID letters/numbers (ABC-12 or ABC12; dash does not count)');
      input.expected = await readHidden('Known CURRENT points balance for comparison (optional; no commas)');
    }
    input.receipt = diagnoseCustomer ? '' : await readHidden('One known receipt/order number exactly as stored (Enter to skip)');
    console.log('');
    await runCheck(input, { transport, log: line => console.log(line), diagnoseCustomer });
  } catch {
    console.log('Stopped or cancelled. No raw errors or private entries displayed. No automatic retry.');
    process.exitCode = 1;
  } finally {
    for (const key of Object.keys(input)) input[key] = null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
