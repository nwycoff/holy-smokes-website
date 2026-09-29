const $ = id => document.getElementById(id);
const demo = location.pathname === '/app/demo/' || location.pathname === '/app/demo/index.html';
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
let config = {}, user = { signedIn: false, linked: false }, points = null, menu = null;
let category = 'All', menuError = '', generation = 0, pendingInstall = null, menuLoading = false, pointsLoading = false;
function el(tag, text = '', className = '') {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
}
function link(text, href, className = 'secondary-button') { const node = el('a', text, className); node.href = href; return node; }
function button(text, action, className = 'primary-button') {
  const b = el('button', text, className); b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await action(); } catch (error) { message(error.message); } finally { b.disabled = false; }
  }); return b;
}
function message(text = '') { $('app-message').textContent = text; $('app-message').hidden = !text; }
async function api(path, body) {
  const response = await fetch(`/api/app/${path}`, { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'strict-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Treehouse-CSRF': user.csrf || '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Please reopen the app and try again.');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'This is temporarily unavailable. Please try again.');
  return result;
}
function signInPanel() {
  const panel = el('section', '', 'account-panel');
  panel.append(el('h2', 'Welcome to your Treehouse.'), el('p', 'Sign in or create an account to keep your points close. Your budtender can give you a one-time code to connect your store record.'));
  if (demo) panel.append(button('Try a sample account →', async () => {
    user = { signedIn: true, linked: true }; points = { points: 750, checkedAt: Date.now() }; renderAccount(); renderHomePoints(); route();
  }));
  else if (config.loginEnabled) {
    const form = el('form'); form.method = 'post'; form.action = '/api/app/login';
    const submit = el('button', 'Sign in or create account →', 'primary-button'); submit.type = 'submit';
    form.append(submit); panel.append(form);
  } else panel.append(el('p', 'Account sign-in is being prepared. You can use the existing points checker in the meantime.', 'notice'));
  panel.append(link('Use the quick points checker ↗', '/rewards', 'text-button'), el('p', 'Signing up does not subscribe you to marketing.', 'fine-print'));
  return panel;
}
function linkPanel() {
  const panel = el('section', '', 'account-panel');
  panel.append(el('h2', 'One quick introduction.'), el('p', 'Ask your budtender for a connection code after they check your customer record. Enter it here within 10 minutes.'));
  const form = el('form'), label = el('label', 'Connection code'), input = el('input');
  label.htmlFor = 'connection-code'; input.id = 'connection-code'; input.autocomplete = 'off'; input.spellcheck = false;
  input.autocapitalize = 'characters'; input.required = true; input.maxLength = 24; input.placeholder = 'XXXX-XXXX-XXXX-XXXX-XXXX';
  const submit = el('button', 'Connect my points →', 'primary-button'); submit.type = 'submit';
  form.append(label, input, el('p', 'A code works once. You won’t need your patient ID to sign in again.'), submit);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; const current = generation;
    try {
      await api('enroll', { code: input.value.trim() }); input.value = '';
      if (current !== generation) return;
      user.linked = true; message('Your rewards are connected. Welcome to My Treehouse.'); renderAccount(); await refreshPoints(); route();
    } catch (error) { message(error.message); } finally { submit.disabled = false; }
  }); panel.append(form); return panel;
}
function renderHomePoints() {
  const balance = $('home-balance'); balance.classList.toggle('balance-number', user.linked && points !== null);
  if (user.linked && points !== null) {
    balance.replaceChildren(el('span', new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(points.points)), el('small', 'POINTS'));
    $('home-points-copy').textContent = demo ? 'A sample balance for this preview.' : 'A little thank-you for choosing Treehouse.';
  } else {
    balance.textContent = 'A little more to look forward to.';
    $('home-points-copy').textContent = user.linked ? 'Open My points to check your balance.' : user.signedIn ? 'Connect your store record to see your points.' : 'Sign in to keep your points close.';
  }
  $('header-account').textContent = user.signedIn ? 'My account' : 'Sign in';
}
function renderRewards() {
  const target = $('rewards-content'); target.replaceChildren();
  if (!user.signedIn) { target.append(signInPanel()); return; }
  if (!user.linked) { target.append(linkPanel()); return; }
  const panel = el('section', '', 'points-card account-panel');
  panel.append(el('p', demo ? 'SAMPLE BALANCE' : 'YOUR CURRENT BALANCE', 'eyebrow'));
  if (points !== null) {
    const heading = el('h2', '', 'balance-number');
    heading.append(el('span', new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(points.points)), el('small', 'POINTS'));
    panel.append(heading, el('p', demo ? 'For demonstration only.' : `Checked ${new Date(points.checkedAt).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}.`));
  } else panel.append(el('h2', pointsLoading ? 'Checking your points…' : 'Your balance is unavailable.'), el('p', 'Your budtender can also check your balance.'));
  panel.append(button('Refresh balance ↻', refreshPoints, 'light-button')); target.append(panel);
}
async function refreshPoints() {
  if (!user.linked || pointsLoading) return;
  const current = generation; pointsLoading = true;
  try {
    const result = demo ? { points: 750, checkedAt: Date.now() } : await api('points');
    if (current !== generation) return;
    points = result;
  } catch (error) { if (current === generation) { points = null; message(error.message); } }
  finally { pointsLoading = false; if (current === generation) { renderHomePoints(); renderRewards(); } }
}
function clearPrivate() {
  generation++; points = null; user = { signedIn: false, linked: false };
  const input = $('connection-code'); if (input) input.value = '';
  renderHomePoints(); renderAccount(); renderRewards();
}
async function signOut(all = false) {
  if (!demo) await api(all ? 'logout-all' : 'logout', {});
  clearPrivate(); message('You’re signed out.'); location.hash = 'account';
}
function renderAccount() {
  const target = $('account-content'); target.replaceChildren();
  if (!user.signedIn) { target.append(signInPanel()); return; }
  const panel = el('section', '', 'account-panel');
  panel.append(el('h2', 'You’re right at home.'), el('p', user.linked ? 'Your rewards connection is active. You can check your balance from My points.' : 'Your account is ready. Connect your rewards with a code from your budtender.'));
  panel.append(link(user.linked ? 'View my points →' : 'Connect my rewards →', '#rewards', 'primary-button'));
  const actions = el('div', '', 'action-row');
  actions.append(button('Sign out', () => signOut(), 'text-button'), button('Sign out on all devices', () => signOut(true), 'text-button'));
  panel.append(actions, el('p', 'Sign-in is remembered on this device for up to seven days. Only stay signed in on a device you trust.', 'fine-print'));
  const details = el('details'), summary = el('summary', 'Remove my rewards connection');
  details.append(summary, el('p', 'This removes your app connection and signs you out everywhere. Your in-store customer record and points remain. You’ll need a new code to reconnect.'));
  const confirm = el('label', '', 'remove-confirmation'), check = el('input'); check.type = 'checkbox';
  confirm.append(check, document.createTextNode(' I want to remove my app connection.'));
  details.append(confirm, button('Remove connection', async () => {
    if (!check.checked) { message('Check the confirmation box first.'); return; }
    if (!demo) await api('remove-link', {});
    clearPrivate(); message('Your app connection has been removed.');
  }, 'secondary-button'));
  panel.append(details); target.append(panel);
}
function productCard(product) {
  const card = $('product-template').content.firstElementChild.cloneNode(true);
  card.querySelector('.product-category').textContent = product.category;
  card.querySelector('.product-type').textContent = product.type;
  card.querySelector('.product-brand').textContent = product.brand;
  card.querySelector('.product-name').textContent = product.name;
  card.querySelector('.product-thc').textContent = product.thc ? `Total THC ${product.thc[0].toFixed(1)}${product.thc[0] !== product.thc[1] ? '–' + product.thc[1].toFixed(1) : ''}%` : 'Ask your budtender for testing details';
  for (const variant of product.variants) {
    const row = el('div', '', 'variant'); row.append(el('span', variant.size), el('strong', money.format(variant.priceCents / 100)));
    card.querySelector('.product-variants').append(row);
  } return card;
}
function empty(text) { const box = el('div', '', 'empty-state'); box.append(el('p', text)); return box; }
function renderMenu() {
  const products = menu?.products || [], filter = $('menu-search').value.toLocaleLowerCase().trim();
  const visible = products.filter(p => (category === 'All' || p.category === category)
    && `${p.name} ${p.brand} ${p.category} ${p.type}`.toLocaleLowerCase().includes(filter)
    && (!$('budget-filter').checked || p.variants.some(v => v.priceCents <= 2000)));
  const min = p => Math.min(...p.variants.map(v => v.priceCents));
  visible.sort($('menu-sort').value === 'name' ? (a, b) => a.name.localeCompare(b.name)
    : (a, b) => ($('menu-sort').value === 'price-desc' ? -1 : 1) * (min(a) - min(b)) || a.name.localeCompare(b.name));
  $('menu-products').replaceChildren(...visible.map(productCard));
  if (!visible.length) $('menu-products').append(empty(menu ? 'No products match those filters. Try another category or search.' : 'The menu is not available right now. Please call the shop for today’s selection.'));
  $('home-products').replaceChildren(...products.slice(0, 3).map(productCard));
  if (!products.length) $('home-products').append(empty(menu ? 'There are no products available in this menu right now.' : 'We’re getting the menu ready. Your budtender can help with today’s selection.'));
  $('menu-count').textContent = `${visible.length} ${visible.length === 1 ? 'product' : 'products'}`;
  $('menu-error').textContent = menuError; $('menu-error').hidden = !menuError;
  $('menu-tax').textContent = menu ? `${menu.pricesIncludeTax ? 'Prices include tax.' : 'Prices do not include tax.'} Availability and final pricing are confirmed in store. No orders are placed from this page.` : '';
  $('menu-freshness').textContent = demo ? 'Sample menu' : menu?.stale ? 'Update delayed' : menu ? `Updated ${new Date(menu.updatedAt).toLocaleTimeString([], { hour:'numeric',minute:'2-digit' })}` : 'Menu unavailable';
  const filters = $('category-filters'); filters.replaceChildren();
  for (const name of ['All', ...(menu?.categories || [])]) {
    const b = button(name, () => { category = name; renderMenu(); }, ''); b.setAttribute('aria-pressed', String(category === name)); filters.append(b);
  }
}
async function refreshMenu() {
  if (demo || !config.menuEnabled || menuLoading) return;
  menuLoading = true;
  try { menu = await api('menu'); menuError = menu.stale ? 'The last menu update was delayed. Please confirm availability with the shop.' : ''; }
  catch { menu = null; menuError = 'We can’t refresh the menu right now. Please call the shop for availability.'; }
  finally { menuLoading = false; renderMenu(); }
}
function route() {
  let view = location.hash.slice(1) || 'home';
  if (view === 'verify-email') { view = 'account'; message('Please verify your email using the message from our sign-in service, then sign in again.'); }
  if (view === 'login-error') { view = 'account'; message('Sign-in could not finish. Please try again.'); }
  if (!['home', 'menu', 'rewards', 'account'].includes(view)) view = 'home';
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  for (const a of document.querySelectorAll('nav a')) {
    if (a.getAttribute('href') === `#${view}`) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (view === 'rewards') { renderRewards(); if (user.linked && (!points || Date.now() - points.checkedAt > 30000)) void refreshPoints(); }
  if (view === 'menu') void refreshMenu();
  document.title = `${({ home:'My Treehouse',menu:'Menu',rewards:'My Points',account:'My Account' })[view]} | Treehouse Pharmacy`;
}
async function initialize() {
  const current = generation;
  if (demo) {
    const fixture = await import('./demo-data.js'); menu = fixture.demoMenu;
    user = { signedIn:true, linked:true }; points = { points:750, checkedAt:Date.now() };
    $('demo-banner').hidden = false;
  } else {
    try {
      const loaded = await api('config'); if (current !== generation) return; config = loaded;
      if (config.enabled) { const loadedUser = await api('session'); if (current !== generation) return; user = loadedUser; }
      else message('My Treehouse is being prepared. The quick points checker is still available on our website.');
    } catch { message('You’re offline or the app is temporarily unavailable. Reconnect to check your menu and points.'); }
  }
  if (current !== generation) return;
  renderHomePoints(); renderAccount(); renderMenu(); route();
  if (!demo) { void refreshMenu(); if (user.linked) void refreshPoints(); }
}
$('menu-search').addEventListener('input', renderMenu); $('menu-sort').addEventListener('change', renderMenu);
$('budget-filter').addEventListener('change', renderMenu);
addEventListener('hashchange', () => { route(); window.scrollTo({ top:0,behavior:'instant' }); });
addEventListener('pagehide', clearPrivate);
addEventListener('pageshow', event => { if (event.persisted) void initialize(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearPrivate(); else void initialize();
});
addEventListener('beforeinstallprompt', event => { if (demo) return; event.preventDefault(); pendingInstall = event; $('install-button').hidden = false; });
$('install-button').addEventListener('click', async () => {
  if (!pendingInstall) return; await pendingInstall.prompt(); pendingInstall = null; $('install-button').hidden = true;
});
if (!demo && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/app/sw.js', { scope:'/app/' }).catch(() => {});
setInterval(() => { if (!document.hidden && ['#home','#menu',''].includes(location.hash)) void refreshMenu(); }, 60000);
void initialize();
