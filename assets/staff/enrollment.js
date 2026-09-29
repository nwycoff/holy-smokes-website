const $ = id => document.getElementById(id);
let csrf = '', ticket = '', expiresAt = 0, timer, busy = false, generation = 0;
const buttons = () => [...document.querySelectorAll('button')];
function message(text) { $('message').textContent = text; }
function panels(current) {
  for (const id of ['lookup-panel', 'confirm-panel', 'result-panel']) $(id).hidden = id !== current;
}
function clearPrivate() {
  generation++;
  clearTimeout(timer); ticket = ''; expiresAt = 0;
  $('lookup-form').reset(); $('issue-form').reset();
  for (const id of ['matched-name', 'connection-code', 'expiry', 'app-url']) $(id).textContent = '';
}
function reset(text = '') {
  clearPrivate(); panels(csrf ? 'lookup-panel' : ''); message(text);
  if (csrf) $('customer-name').focus();
}
function expireAt(time, text) {
  clearTimeout(timer); expiresAt = time;
  timer = setTimeout(() => reset(text), Math.max(0, time - Date.now()));
}
async function api(route, body) {
  const response = await fetch(`/api/staff/${route}`, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: body ? { 'Content-Type': 'application/json', 'X-Treehouse-CSRF': csrf } : {},
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Reopen the staff page to sign in again.');
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) { csrf = ''; reset(); }
    throw new Error(result.error || 'Unable to complete this request.');
  }
  return result;
}
async function action(fn) {
  if (busy) return;
  busy = true; buttons().forEach(b => b.disabled = true); message('');
  try { await fn(); } catch (error) { message(error instanceof TypeError ? 'Connection interrupted. Reopen the staff page and try again.' : error.message); }
  finally { busy = false; buttons().forEach(b => b.disabled = false); }
}
$('lookup-form').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    const current = generation;
    const result = await api('match', { name: $('customer-name').value, lastFive: $('patient-ending').value });
    if (current !== generation) return;
    ticket = result.ticket; $('matched-name').textContent = result.name;
    $('lookup-form').reset(); $('identity-checked').checked = false; panels('confirm-panel');
    expireAt(result.expiresAt, 'That match expired. Find the customer again.'); $('identity-checked').focus();
  });
});
$('issue-form').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    if (!ticket || expiresAt <= Date.now()) { reset('That match expired. Find the customer again.'); return; }
    const current = generation;
    const result = await api('issue', { ticket, identityChecked: $('identity-checked').checked });
    if (current !== generation) return;
    clearPrivate(); panels('result-panel');
    $('connection-code').textContent = result.code;
    $('app-url').textContent = result.appUrl;
    $('expiry').textContent = `Expires at ${new Date(result.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} today.`;
    expireAt(result.expiresAt, 'The connection code expired. Generate a new one if needed.'); $('print-code').focus();
  });
});
$('change-customer').addEventListener('click', () => reset());
$('next-customer').addEventListener('click', () => reset());
$('print-code').addEventListener('click', () => {
  if (expiresAt <= Date.now()) reset('The connection code expired.'); else window.print();
});
$('sign-out').addEventListener('click', () => { csrf = ''; reset(); });
// Do not retain patient inputs or codes in back/forward cache or browser storage.
window.addEventListener('pagehide', () => { csrf = ''; clearPrivate(); panels(''); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && expiresAt && expiresAt <= Date.now()) reset('That customer session expired. Start again.');
});
void action(async () => {
  const info = await api('session'); csrf = info.csrf;
  $('staff-name').textContent = `Signed in as ${info.email}`; panels('lookup-panel');
});
