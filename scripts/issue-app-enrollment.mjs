// Owner-operated tool. Keep the enrollment secret in your password manager.
// No files, contacts, GrowFlow records or points are written by this tool.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

async function hidden(prompt) {
  if (!stdin.isTTY) throw new Error('Run this in an interactive terminal.');
  stdout.write(prompt); stdin.setRawMode(true); stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (error) => {
      stdin.off('data', read); stdin.setRawMode(false); stdin.pause(); stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const read = bytes => {
      for (const char of bytes.toString('utf8')) {
        if (char === '\u0003') return done(new Error('Canceled.'));
        if (char === '\r' || char === '\n') return done();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && value.length < 4096) value += char;
      }
    };
    stdin.on('data', read);
  });
}

try {
  console.log('Treehouse customer connection code\nUse only after checking this customer’s identity in person.\nEntries are hidden and are not saved. Give the returned code only to that customer.');
  const terminal = createInterface({ input: stdin, output: stdout });
  const rawURL = await terminal.question('Test app origin, e.g. https://treehouse-points-test.pages.dev: ');
  const confirmed = await terminal.question('Have you checked the customer’s identity in person? Type YES: ');
  terminal.close();
  const base = new URL(rawURL.trim());
  if (confirmed !== 'YES') throw new Error('Check the customer’s identity first.');
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password || base.port
    || !(/^[a-z0-9-]+\.pages\.dev$/.test(base.hostname) || ['treehousepharmacy.com', 'www.treehousepharmacy.com'].includes(base.hostname)))
    throw new Error('Enter the approved HTTPS app origin, with no path.');
  const secret = await hidden('Enrollment secret (hidden): ');
  const accessID = await hidden('Cloudflare Access service client ID (hidden; Enter if not required): ');
  const accessSecret = accessID ? await hidden('Cloudflare Access service client secret (hidden): ') : '';
  const name = await hidden('Full name as shown in GrowFlow (hidden): ');
  const lastFive = await hidden('Last five patient-ID letters/numbers (hidden): ');
  const response = await fetch(new URL('/api/app/staff/enroll', base), { method: 'POST', redirect: 'manual',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json',
      ...(accessID ? { 'CF-Access-Client-Id': accessID, 'CF-Access-Client-Secret': accessSecret } : {}) },
    body: JSON.stringify({ name, lastFive, identityChecked: true }), signal: AbortSignal.timeout(15000) });
  if (response.status >= 300 && response.status < 400) throw new Error('Access login is required or the address redirected. No redirect was followed.');
  const data = await response.json();
  if (!response.ok || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/.test(data.code || ''))
    throw new Error(response.status === 409 ? 'That record is already linked. Use sign-in recovery.' : 'Could not issue a code. Check the inputs, access, and private app diagnostics.');
  console.log(`\nOne-time connection code: ${data.code}\nExpires in 10 minutes. Enter it under My points after signing in.\nDo not share this code in chat or save it in a customer list.`);
} catch (error) {
  // Deliberately never print upstream responses, request bodies or secrets.
  const safe = ['Run this in an interactive terminal.', 'Canceled.', 'Check the customer’s identity first.',
    'Enter the approved HTTPS app origin, with no path.',
    'Access login is required or the address redirected. No redirect was followed.',
    'That record is already linked. Use sign-in recovery.',
    'Could not issue a code. Check the inputs, access, and private app diagnostics.'];
  console.error(safe.includes(error?.message) ? error.message : 'Connection failed. Check the app address and network.');
  process.exitCode = 1;
}
