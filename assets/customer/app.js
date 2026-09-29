const $ = id => document.getElementById(id);
const demo = location.pathname === '/app/demo/' || location.pathname === '/app/demo/index.html';
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
let config = {}, user = { signedIn: false, linked: false }, points = null, menu = null;
let category = 'All', menuError = '', generation = 0, pendingInstall = null, menuLoading = false, pointsLoading = false;
// The cart holds only public menu choices, in memory. Order status is account data.
const MAX_ITEMS = 10;
let cart = [], order = null, orderLoading = false, orderNote = '', orderLicense = '';
const canOrder = () => demo || Boolean(config.preorderEnabled && user.linked);
const cartCount = () => cart.reduce((n, line) => n + line.qty, 0);
const cartTotal = () => cart.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
const ORDER_STATUS = { Submitting: 'Sending your order…', New: 'Received. The shop will start on it shortly.',
  Pending: 'Received. The shop will start on it shortly.', Cart: 'Received. The shop will start on it shortly.',
  Unfulfilled: 'Accepted. We’re getting it ready.', InTransit: 'Almost ready.', Fulfilled: 'Ready for pickup!',
  Held: 'On hold. Please call the shop.',
  Unconfirmed: 'We couldn’t confirm this order. Please call the shop before ordering again.',
  Completed: 'Picked up. Thank you!', Canceled: 'Canceled.' };
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
      user.linked = true; message('Your rewards are connected. Welcome to My Treehouse.'); renderAccount(); renderMenu(); renderCartBar();
      await refreshPoints(); route();
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
  generation++; points = null; order = null; orderLicense = ''; user = { signedIn: false, linked: false };
  const input = $('connection-code'); if (input) input.value = '';
  renderHomePoints(); renderAccount(); renderRewards(); renderOrder(); renderCartBar();
}
async function signOut(all = false) {
  if (!demo) await api(all ? 'logout-all' : 'logout', {});
  cart = []; clearPrivate(); message('You’re signed out.'); location.hash = 'account';
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
    cart = []; clearPrivate(); message('Your app connection has been removed.');
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
    if (canOrder()) {
      const add = button('Add', () => addToCart(product, variant), 'add-button');
      add.setAttribute('aria-label', `Add ${product.name} ${variant.size} to your order`);
      row.append(add);
    }
    card.querySelector('.product-variants').append(row);
  } return card;
}
function addToCart(product, variant) {
  if (cartCount() >= MAX_ITEMS) { message(`Pickup orders can have up to ${MAX_ITEMS} items.`); return; }
  const line = cart.find(l => l.productId === product.id && l.size === variant.size);
  if (line) line.qty++;
  else cart.push({ productId: product.id, size: variant.size, priceCents: variant.priceCents, name: product.name, brand: product.brand, qty: 1 });
  message(''); renderCartBar();
}
// Keep the cart in step with the latest menu so the customer sees changes before ordering.
function reconcileCart() {
  if (!menu || !cart.length) return;
  let changed = false;
  cart = cart.filter(line => {
    const variant = menu.products.find(p => p.id === line.productId)?.variants.find(v => v.size === line.size);
    if (!variant) { changed = true; return false; }
    if (variant.priceCents !== line.priceCents) { line.priceCents = variant.priceCents; changed = true; }
    return true;
  });
  if (changed) message('Your order was updated to match the latest menu. Please review it.');
}
function renderCartBar() {
  const count = cartCount(), show = canOrder();
  for (const link of document.querySelectorAll('.order-nav')) link.hidden = !show;
  for (const badge of document.querySelectorAll('.order-count')) { badge.hidden = !count; badge.textContent = String(count); }
  const bar = $('cart-bar'); bar.hidden = !show || !count;
  bar.replaceChildren(el('span', `${count} ${count === 1 ? 'item' : 'items'} · ${money.format(cartTotal() / 100)}`), el('strong', 'Review order →'));
}
function orderStatusPanel() {
  const panel = el('section', '', 'points-card account-panel order-status');
  panel.append(el('p', demo ? 'SAMPLE ORDER' : order.orderNumber ? `ORDER #${order.orderNumber}` : 'YOUR ORDER', 'eyebrow'),
    el('h2', ORDER_STATUS[order.status] || 'Received. Please call the shop with any questions.'),
    el('p', `${order.itemCount} ${order.itemCount === 1 ? 'item' : 'items'} · ${money.format(order.totalCents / 100)} · placed ${new Date(order.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`));
  if (order.open) panel.append(el('p', 'Pay in store when you pick up. Bring your ID and medical card.'),
    button('Refresh status ↻', () => refreshOrder(true), 'light-button'));
  return panel;
}
function renderOrder() {
  const target = $('order-content'); target.replaceChildren();
  if (!canOrder()) {
    if (!user.signedIn) target.append(signInPanel());
    else if (!user.linked) target.append(linkPanel());
    else target.append(empty('Ordering ahead isn’t available right now. Please call the shop.'));
    return;
  }
  if (order) target.append(orderStatusPanel());
  if (order?.open) {
    if (cart.length) target.append(el('p', 'You can place another order once this one is picked up or canceled. Your selections will wait here.', 'fine-print'));
    return;
  }
  if (!cart.length) {
    const box = empty('Your order is empty.'); box.append(link('Browse the menu →', '#menu', 'primary-button'));
    target.append(box); return;
  }
  // A real form, so the phone's own autofill can offer to remember the license number.
  const panel = el('form', '', 'account-panel order-panel'), list = el('ul', '', 'order-lines');
  panel.method = 'post'; panel.action = '#order'; panel.noValidate = true;
  for (const line of cart) {
    const item = el('li', '', 'order-line'), info = el('div');
    info.append(el('strong', line.name), el('span', [line.brand, line.size].filter(Boolean).join(' · ')));
    const qty = el('div', '', 'qty-stepper');
    const less = button('−', () => { line.qty--; if (!line.qty) cart = cart.filter(l => l !== line); renderOrder(); renderCartBar(); }, 'qty-button');
    const more = button('+', () => { if (cartCount() < MAX_ITEMS) line.qty++; else message(`Pickup orders can have up to ${MAX_ITEMS} items.`); renderOrder(); renderCartBar(); }, 'qty-button');
    less.setAttribute('aria-label', `One fewer ${line.name}`); more.setAttribute('aria-label', `One more ${line.name}`);
    qty.append(less, el('span', String(line.qty)), more);
    item.append(info, qty, el('b', money.format(line.priceCents * line.qty / 100))); list.append(item);
  }
  const total = el('p', '', 'order-total'); total.append(el('span', 'Estimated total'), el('strong', money.format(cartTotal() / 100)));
  const licenseLabel = el('label', 'Medical license number'), license = el('input');
  licenseLabel.htmlFor = 'order-license'; license.id = 'order-license'; license.name = 'medical-license-number';
  license.autocomplete = 'on'; license.autocapitalize = 'characters'; license.spellcheck = false; license.maxLength = 48;
  license.placeholder = 'As shown on your medical card'; license.value = orderLicense;
  license.addEventListener('input', () => { orderLicense = license.value; });
  const label = el('label', 'Note for the shop (optional)'), note = el('textarea');
  label.htmlFor = 'order-note'; note.id = 'order-note'; note.maxLength = 200; note.rows = 2; note.value = orderNote;
  note.addEventListener('input', () => { orderNote = note.value; });
  const submit = el('button', 'Place pickup order →', 'primary-button wide-button'); submit.type = 'submit';
  panel.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try { await placeOrder(orderNote.trim(), orderLicense.trim()); } finally { submit.disabled = false; }
  });
  panel.append(list, total, el('p', menu?.pricesIncludeTax === false ? 'Prices do not include tax.' : 'Prices include tax.', 'fine-print'),
    licenseLabel, license, el('p', 'Checked against your store record and sent with your order. The app doesn’t save it; your phone may offer to.', 'field-help'),
    label, note, submit,
    el('p', 'Pay in store when you pick up. Bring your ID and medical card. Availability and final price are confirmed at the counter.', 'fine-print'));
  target.append(panel);
}
async function placeOrder(note, license) {
  if (!cart.length || orderLoading) return;
  const current = generation; let failed = false; orderLoading = true;
  try {
    const items = cart.map(({ productId, size, priceCents, qty }) => ({ productId, size, priceCents, qty }));
    const result = demo ? { order: { orderNumber: null, status: 'New', open: true, totalCents: cartTotal(), itemCount: cartCount(), createdAt: Date.now() } }
      : await api('preorder/place', { items, ...(note ? { note } : {}), ...(license ? { license } : {}) });
    if (current !== generation) return;
    order = result.order; cart = []; orderNote = ''; orderLicense = ''; message('');
  } catch (error) {
    if (current === generation) { failed = true; message(error.message); }
  } finally { orderLoading = false; if (current === generation) { renderOrder(); renderCartBar(); } }
  // Show why it failed: an open order, or menu changes the customer should review.
  if (failed) { await refreshMenu(); if (current === generation && !order?.open) { order = null; await refreshOrder(); } }
}
async function refreshOrder(force = false) {
  if (demo || !canOrder() || orderLoading || (!force && order && !order.open)) return;
  const current = generation;
  try { const result = await api('preorder'); if (current === generation) order = result.order; }
  catch (error) { if (current === generation && force) message(error.message); }
  finally { if (current === generation) renderOrder(); }
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
  $('menu-tax').textContent = menu ? `${menu.pricesIncludeTax ? 'Prices include tax.' : 'Prices do not include tax.'} Availability and final pricing are confirmed in store.${canOrder() ? ' Add items to order ahead for pickup.' : ''}` : '';
  $('menu-freshness').textContent = demo ? 'Sample menu' : menu?.stale ? 'Update delayed' : menu ? `Updated ${new Date(menu.updatedAt).toLocaleTimeString([], { hour:'numeric',minute:'2-digit' })}` : 'Menu unavailable';
  const filters = $('category-filters'); filters.replaceChildren();
  for (const name of ['All', ...(menu?.categories || [])]) {
    const b = button(name, () => { category = name; renderMenu(); }, ''); b.setAttribute('aria-pressed', String(category === name)); filters.append(b);
  }
}
async function refreshMenu() {
  if (demo || !config.menuEnabled || menuLoading) return;
  menuLoading = true;
  try {
    menu = await api('menu'); menuError = menu.stale ? 'The last menu update was delayed. Please confirm availability with the shop.' : '';
    reconcileCart();
  }
  catch { menu = null; menuError = 'We can’t refresh the menu right now. Please call the shop for availability.'; }
  finally { menuLoading = false; renderMenu(); renderCartBar(); }
}
function route() {
  let view = location.hash.slice(1) || 'home';
  if (view === 'verify-email') { view = 'account'; message('Please verify your email using the message from our sign-in service, then sign in again.'); }
  if (view === 'login-error') { view = 'account'; message('Sign-in could not finish. Please try again.'); }
  if (!['home', 'menu', 'rewards', 'account', 'order'].includes(view)) view = 'home';
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  for (const a of document.querySelectorAll('nav a')) {
    if (a.getAttribute('href') === `#${view}`) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (view === 'rewards') { renderRewards(); if (user.linked && (!points || Date.now() - points.checkedAt > 30000)) void refreshPoints(); }
  if (view === 'menu') void refreshMenu();
  if (view === 'order') { renderOrder(); void refreshOrder(); }
  document.title = `${({ home:'My Treehouse',menu:'Menu',rewards:'My Points',account:'My Account',order:'Order ahead' })[view]} | Treehouse Pharmacy`;
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
  renderHomePoints(); renderAccount(); renderMenu(); renderCartBar(); route();
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
setInterval(() => {
  if (document.hidden) return;
  if (['#home','#menu','#order',''].includes(location.hash)) void refreshMenu();
  if (location.hash === '#order' && order?.open) void refreshOrder();
}, 60000);
void initialize();
