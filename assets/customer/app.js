const $ = id => document.getElementById(id);
const demo = location.pathname === '/app/demo/' || location.pathname === '/app/demo/index.html';
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
let config = {}, user = { signedIn: false, linked: false }, points = null, menu = null;
let category = 'All', menuError = '', generation = 0, pendingInstall = null, menuLoading = false, pointsLoading = false;
// The cart holds only public menu choices, in memory. Order status is account data.
const MAX_ITEMS = 10;
let cart = [], order = null, orderLoading = false, orderNote = '', orderLicense = '';
// Loyalty reward tiers (public) and the one a customer picks for their order. Staff apply it at pickup.
let rewardTiers = null, selectedReward = '', rewardPointsTried = false;
// Optional saved license: only its last four characters ever reach the browser.
let rememberLicense = false, changingLicense = false;
const licenseMemory = () => demo || Boolean(config.licenseMemoryEnabled);
const usingSavedLicense = () => Boolean(licenseMemory() && user.licenseHint && !changingLicense);
const formatPoints = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
async function loadRewards() {
  if (rewardTiers || !(demo || config.rewardTiersEnabled)) return;
  try { rewardTiers = demo ? (await import('./demo-data.js')).demoRewards.tiers : (await api('rewards')).tiers; }
  catch { rewardTiers = null; }
  renderRewards(); renderOrder();
}
// Why a tier can't be chosen right now, or '' when it can.
function rewardBlock(tier, subtotalCents) {
  if (!points) return 'checking your points';
  if (points.points < tier.points) return `${formatPoints(tier.points - points.points)} more points needed`;
  if (tier.amountCents !== null && tier.amountCents > subtotalCents) return `for orders of ${money.format(tier.amountCents / 100)} or more`;
  return '';
}
function rewardTiersPanel() {
  if (!rewardTiers?.length) return null;
  const panel = el('section', '', 'account-panel reward-tiers'), list = el('ul', '', 'tier-list');
  panel.append(el('h3', 'Rewards you can redeem'));
  for (const tier of rewardTiers) {
    const item = el('li'), ready = user.linked && points && points.points >= tier.points;
    item.append(el('strong', `${formatPoints(tier.points)} pts`), el('span', tier.name),
      el('em', !user.linked || !points ? '' : ready ? '✓ Ready to use' : `${formatPoints(tier.points - points.points)} to go`, ready ? 'tier-ready' : ''));
    list.append(item);
  }
  panel.append(list, el('p', 'Choose a reward when you order ahead, or ask your budtender at checkout.', 'fine-print'));
  return panel;
}
// Order-ready notifications (Web Push). iPhone only allows them once the app is on the Home Screen.
let pushSubscribed = false;
const canPush = () => !demo && Boolean(config.pushKey) && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const iosBrowserTab = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches && !navigator.standalone;
const pushKeyBytes = () => Uint8Array.from(atob(config.pushKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function currentPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const registration = await navigator.serviceWorker.getRegistration('/app/');
  return registration ? registration.pushManager.getSubscription() : null;
}
async function enableNotifications() {
  if (await Notification.requestPermission() !== 'granted') {
    message('Notifications are off for this app. You can turn them on in your phone’s settings.'); return;
  }
  const registration = await navigator.serviceWorker.ready;
  const fresh = () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes() });
  let subscription = await registration.pushManager.getSubscription() || await fresh();
  try { await api('push/subscribe', subscription.toJSON()); }
  catch (error) {
    // Still registered to someone else who shared this phone: replace it with a new subscription.
    if (error.status !== 409) throw error;
    await subscription.unsubscribe(); subscription = await fresh();
    await api('push/subscribe', subscription.toJSON());
  }
  pushSubscribed = true; message('We’ll notify this device when your order is ready.'); renderOrder(); renderAccount();
}
// Removes this device's notifications, locally and on the server. Never blocks sign-out.
async function disableNotifications() {
  try {
    const subscription = await currentPushSubscription();
    if (subscription) {
      if (user.signedIn) await api('push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
      await subscription.unsubscribe();
    }
  } catch { /* The server also drops subscriptions the push service reports as gone. */ }
  pushSubscribed = false;
}
function notifyControl() {
  if (!canPush() && !iosBrowserTab()) return null;
  if (iosBrowserTab() && !canPush()) return el('p', 'Want a notification when it’s ready? Add My Treehouse to your Home Screen (Share → Add to Home Screen) and order from there.', 'fine-print');
  if (pushSubscribed) return el('p', 'We’ll notify this device when your order is ready.', 'fine-print');
  if (Notification.permission === 'denied') return el('p', 'Notifications are blocked for this app. Turn them on in your phone’s settings to hear when your order is ready.', 'fine-print');
  return button('Notify me when it’s ready 🔔', enableNotifications, 'secondary-button');
}
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
  if (!response.ok) throw Object.assign(new Error(result.error || 'This is temporarily unavailable. Please try again.'), { status: response.status });
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
  const tiers = rewardTiersPanel();
  if (!user.signedIn) { target.append(signInPanel()); if (tiers) target.append(tiers); return; }
  if (!user.linked) { target.append(linkPanel()); if (tiers) target.append(tiers); return; }
  const panel = el('section', '', 'points-card account-panel');
  panel.append(el('p', demo ? 'SAMPLE BALANCE' : 'YOUR CURRENT BALANCE', 'eyebrow'));
  if (points !== null) {
    const heading = el('h2', '', 'balance-number');
    heading.append(el('span', new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(points.points)), el('small', 'POINTS'));
    panel.append(heading, el('p', demo ? 'For demonstration only.' : `Checked ${new Date(points.checkedAt).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}.`));
  } else panel.append(el('h2', pointsLoading ? 'Checking your points…' : 'Your balance is unavailable.'), el('p', 'Your budtender can also check your balance.'));
  panel.append(button('Refresh balance ↻', refreshPoints, 'light-button')); target.append(panel);
  if (tiers) target.append(tiers);
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
  generation++; points = null; order = null; orderLicense = ''; selectedReward = ''; rememberLicense = false; changingLicense = false;
  user = { signedIn: false, linked: false };
  const input = $('connection-code'); if (input) input.value = '';
  renderHomePoints(); renderAccount(); renderRewards(); renderOrder(); renderCartBar();
}
async function signOut(all = false) {
  if (!demo) { await disableNotifications(); await api(all ? 'logout-all' : 'logout', {}); }
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
  if (licenseMemory() && user.licenseHint) actions.append(button(`Forget my saved license number (ending ${user.licenseHint})`, async () => {
    if (!demo) await api('license/forget', {});
    user.licenseHint = undefined; message('Your saved license number has been removed.'); renderAccount(); renderOrder();
  }, 'text-button'));
  if (pushSubscribed) actions.append(button('Turn off order notifications on this device', async () => {
    await disableNotifications(); message('Order notifications are off on this device.'); renderAccount(); renderOrder();
  }, 'text-button'));
  panel.append(actions, el('p', 'Sign-in is remembered on this device for up to seven days. Only stay signed in on a device you trust.', 'fine-print'));
  const details = el('details'), summary = el('summary', 'Remove my rewards connection');
  details.append(summary, el('p', 'This removes your app connection and signs you out everywhere. Your in-store customer record and points remain. You’ll need a new code to reconnect.'));
  const confirm = el('label', '', 'remove-confirmation'), check = el('input'); check.type = 'checkbox';
  confirm.append(check, document.createTextNode(' I want to remove my app connection.'));
  details.append(confirm, button('Remove connection', async () => {
    if (!check.checked) { message('Check the confirmation box first.'); return; }
    if (!demo) { await disableNotifications(); await api('remove-link', {}); }
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
  const range = (label, r) => r ? `${label} ${r[0].toFixed(1)}${r[0] !== r[1] ? '–' + r[1].toFixed(1) : ''}%` : '';
  card.querySelector('.product-thc').textContent = [range('Total THC', product.thc), product.cbd?.[1] >= 1 ? range('CBD', product.cbd) : '']
    .filter(Boolean).join(' · ') || 'Ask your budtender for testing details';
  if (product.cbdRich) card.querySelector('.product-type').textContent = product.type ? `${product.type} · CBD-rich` : 'CBD-rich';
  const image = card.querySelector('.product-image');
  if (product.image) { image.src = product.image; image.hidden = false; image.addEventListener('error', () => { image.hidden = true; }); }
  const description = card.querySelector('.product-description');
  if (product.description) { description.textContent = product.description; description.hidden = false; }
  for (const variant of product.variants) {
    const row = el('div', '', 'variant'), price = el('div', '', 'variant-price');
    price.append(el('strong', money.format(variant.priceCents / 100)));
    if (product.flower && variant.pricePerGramCents) price.append(el('small', `${money.format(variant.pricePerGramCents / 100)}/g`));
    const size = el('span', variant.size);
    if (variant.available <= 5) size.append(el('em', `Only ${variant.available} left`, 'low-stock'));
    row.append(size, price);
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
  if ((line?.qty || 0) >= (variant.available ?? Infinity)) { message('That’s all we have of that one right now.'); return; }
  if (line) { line.qty++; line.available = variant.available; }
  else cart.push({ productId: product.id, size: variant.size, priceCents: variant.priceCents, name: product.name, brand: product.brand, qty: 1, available: variant.available });
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
    line.available = variant.available;
    if (variant.available !== undefined && line.qty > variant.available) { line.qty = variant.available; changed = true; }
    return line.qty > 0;
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
  if (order.rewardName) panel.append(el('p', `Reward requested: ${order.rewardName}. Your budtender applies it at pickup.`));
  if (order.open) panel.append(el('p', 'Pay in store when you pick up. Bring your ID and medical card.'),
    button('Refresh status ↻', () => refreshOrder(true), 'light-button'));
  const notify = order.open && order.status !== 'Fulfilled' ? notifyControl() : null;
  if (notify) { const row = el('div', '', 'notify-row'); row.append(notify); panel.append(row); }
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
    const more = button('+', () => {
      if (line.qty >= (line.available ?? Infinity)) message('That’s all we have of that one right now.');
      else if (cartCount() < MAX_ITEMS) line.qty++; else message(`Pickup orders can have up to ${MAX_ITEMS} items.`);
      renderOrder(); renderCartBar();
    }, 'qty-button');
    less.setAttribute('aria-label', `One fewer ${line.name}`); more.setAttribute('aria-label', `One more ${line.name}`);
    qty.append(less, el('span', String(line.qty)), more);
    item.append(info, qty, el('b', money.format(line.priceCents * line.qty / 100))); list.append(item);
  }
  const total = el('p', '', 'order-total'); total.append(el('span', 'Estimated total'), el('strong', money.format(cartTotal() / 100)));
  const licenseParts = licenseFields();
  const label = el('label', 'Note for the shop (optional)'), note = el('textarea');
  label.htmlFor = 'order-note'; note.id = 'order-note'; note.maxLength = 200; note.rows = 2; note.value = orderNote;
  note.addEventListener('input', () => { orderNote = note.value; });
  const submit = el('button', 'Place pickup order →', 'primary-button wide-button'); submit.type = 'submit';
  panel.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try { await placeOrder(orderNote.trim(), usingSavedLicense() ? '' : orderLicense.trim()); } finally { submit.disabled = false; }
  });
  const rewardRow = rewardPicker(total);
  panel.append(list, total, el('p', menu?.pricesIncludeTax === false ? 'Prices do not include tax.' : 'Prices include tax.', 'fine-print'),
    ...rewardRow, ...licenseParts, label, note, submit,
    el('p', 'Pay in store when you pick up. Bring your ID and medical card. Availability and final price are confirmed at the counter.', 'fine-print'));
  target.append(panel);
}
// Saved license ("on file, ending ABCD" + Change), or the field plus an opt-in "remember" box.
function licenseFields() {
  const label = el('label', 'Medical license number');
  if (usingSavedLicense()) {
    const row = el('div', '', 'saved-license');
    row.append(el('span', `On file, ending ${user.licenseHint} ✓`),
      button('Change', () => { changingLicense = true; renderOrder(); }, 'text-button'));
    return [label, row, el('p', 'Checked against your store record on every order.', 'field-help')];
  }
  const license = el('input');
  label.htmlFor = 'order-license'; license.id = 'order-license'; license.name = 'medical-license-number';
  license.autocomplete = 'on'; license.autocapitalize = 'characters'; license.spellcheck = false; license.maxLength = 48;
  license.placeholder = 'As shown on your medical card'; license.value = orderLicense;
  license.addEventListener('input', () => { orderLicense = license.value; });
  const parts = [label, license];
  if (licenseMemory()) {
    const remember = el('label', '', 'remember-license'), box = el('input'); box.type = 'checkbox'; box.checked = rememberLicense;
    box.addEventListener('change', () => { rememberLicense = box.checked; });
    remember.append(box, document.createTextNode(' Remember my license number for next time'));
    parts.push(remember, el('p', 'Saved encrypted only after it matches your store record, and only if you tick the box. You can remove it anytime under Account.', 'field-help'));
  } else parts.push(el('p', 'Checked against your store record and sent with your order. The app doesn’t save it; your phone may offer to.', 'field-help'));
  return parts;
}
// The "Use my points" dropdown, plus the estimated total when a dollar reward is chosen.
function rewardPicker(totalLine) {
  if (!rewardTiers?.length) return [];
  // One balance check per visit to the order screen, so a failure can't loop.
  if (!points && !pointsLoading && !rewardPointsTried && user.linked) { rewardPointsTried = true; void refreshPoints().then(renderOrder); }
  const subtotal = cartTotal(), eligible = t => !rewardBlock(t, subtotal);
  if (selectedReward && !rewardTiers.some(t => t.id === selectedReward && eligible(t))) selectedReward = '';
  const label = el('label', 'Use my points'), select = el('select');
  label.htmlFor = 'order-reward'; select.id = 'order-reward';
  const none = el('option', 'Don’t use points this time'); none.value = ''; select.append(none);
  for (const tier of rewardTiers) {
    const why = rewardBlock(tier, subtotal), option = el('option', why ? `${tier.name} (${why})` : tier.name);
    option.value = tier.id; option.disabled = Boolean(why); select.append(option);
  }
  select.value = selectedReward;
  select.addEventListener('change', () => { selectedReward = select.value; renderOrder(); });
  const chosen = rewardTiers.find(t => t.id === selectedReward), parts = [label, select];
  if (points) parts.push(el('p', `You have ${formatPoints(points.points)} points.`, 'field-help'));
  if (chosen?.amountCents) {
    const estimate = el('p', '', 'order-total reward-total');
    estimate.append(el('span', 'Estimated total with reward'), el('strong', money.format(Math.max(0, subtotal - chosen.amountCents) / 100)));
    parts.push(estimate);
  }
  if (chosen) parts.push(el('p', 'Your budtender applies the reward at pickup. Points aren’t set aside, so if you use them in store first, we’ll adjust at the counter.', 'field-help'));
  return parts;
}
async function placeOrder(note, license) {
  if (!cart.length || orderLoading) return;
  const current = generation, useSaved = usingSavedLicense(), remember = !useSaved && rememberLicense && licenseMemory();
  let failed = false; orderLoading = true;
  try {
    const items = cart.map(({ productId, size, priceCents, qty }) => ({ productId, size, priceCents, qty }));
    const result = demo ? { order: { orderNumber: null, status: 'New', open: true, totalCents: cartTotal(), itemCount: cartCount(), createdAt: Date.now(),
      ...(selectedReward ? { rewardName: rewardTiers.find(t => t.id === selectedReward)?.name } : {}) } }
      : await api('preorder/place', { items, ...(note ? { note } : {}), ...(license ? { license } : {}),
        ...(useSaved ? { useSavedLicense: true } : {}), ...(remember ? { rememberLicense: true } : {}),
        ...(selectedReward ? { reward: selectedReward } : {}) });
    if (current !== generation) return;
    order = result.order; cart = []; orderNote = ''; orderLicense = ''; selectedReward = ''; message('');
    // Mirror the server: a remembered number is kept (hint only), typing without "remember" clears it.
    if (licenseMemory() && !useSaved) user.licenseHint = remember ? (demo ? license.replace(/-/g, '').slice(-4) : result.order.licenseHint) : undefined;
    rememberLicense = false; changingLicense = false; renderAccount();
  } catch (error) {
    if (current === generation) { failed = true; message(error.message); }
    // A saved license the server rejected has been removed there; show the empty field again.
    if (useSaved && !demo && current === generation) { try { user.licenseHint = (await api('session')).licenseHint; } catch { /* Keep the message. */ } }
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
// Menu filters: strain type, flower size, price band and brand, shown in a panel with
// removable chips for whatever is active. Options list only what the current menu has.
const filters = { types: new Set(), sizes: new Set(), brands: new Set(), price: '' };
const TYPES = [['indica', 'Indica'], ['sativa', 'Sativa'], ['hybrid', 'Hybrid'], ['cbd', 'CBD-rich']];
const PRICES = [['under20', 'Under $20', c => c < 2000], ['20to40', '$20–$40', c => c >= 2000 && c <= 4000], ['over40', 'Over $40', c => c > 4000]];
const matches = {
  types: p => !filters.types.size || filters.types.has(p.type) || (filters.types.has('cbd') && p.cbdRich),
  sizes: p => !filters.sizes.size || (p.flower && p.variants.some(v => filters.sizes.has(v.size))),
  brands: p => !filters.brands.size || filters.brands.has(p.brand),
  price: p => !filters.price || p.variants.some(v => PRICES.find(([key]) => key === filters.price)[2](v.priceCents))
};
const activeFilterCount = () => filters.types.size + filters.sizes.size + filters.brands.size + (filters.price ? 1 : 0);
function menuBase() {
  const search = $('menu-search').value.toLocaleLowerCase().trim();
  return (menu?.products || []).filter(p => (category === 'All' || p.category === category)
    && `${p.name} ${p.brand} ${p.category} ${p.type} ${p.cbdRich ? 'cbd' : ''}`.toLocaleLowerCase().includes(search));
}
function chip(label, pressed, onClick, count) {
  const b = button(count === undefined ? label : `${label} (${count})`, onClick, 'chip');
  b.setAttribute('aria-pressed', String(pressed)); return b;
}
function toggle(set, value) { if (set.has(value)) set.delete(value); else set.add(value); renderMenu(); }
function renderFilters(base) {
  const count = test => base.filter(test).length;
  $('filter-types').replaceChildren(...TYPES.map(([key, label]) =>
    chip(label, filters.types.has(key), () => toggle(filters.types, key), count(p => key === 'cbd' ? p.cbdRich : p.type === key))));
  const sizes = [...new Map((menu?.products || []).filter(p => p.flower).flatMap(p => p.variants)
    .filter(v => v.grams).map(v => [v.size, v.grams])).entries()].sort((a, b) => a[1] - b[1]).slice(0, 8);
  $('filter-sizes-group').hidden = !sizes.length;
  $('filter-sizes').replaceChildren(...sizes.map(([size]) =>
    chip(size, filters.sizes.has(size), () => toggle(filters.sizes, size), count(p => p.flower && p.variants.some(v => v.size === size)))));
  $('filter-prices').replaceChildren(...PRICES.map(([key, label, test]) => chip(label, filters.price === key,
    () => { filters.price = filters.price === key ? '' : key; renderMenu(); }, count(p => p.variants.some(v => test(v.priceCents))))));
  const brands = [...new Set((menu?.products || []).map(p => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('filter-brands-group').hidden = brands.length < 2;
  $('filter-brands').replaceChildren(...brands.map(brand =>
    chip(brand, filters.brands.has(brand), () => toggle(filters.brands, brand), count(p => p.brand === brand))));
  const active = [...[...filters.types].map(k => [TYPES.find(t => t[0] === k)[1], () => toggle(filters.types, k)]),
    ...[...filters.sizes].map(k => [k, () => toggle(filters.sizes, k)]),
    ...(filters.price ? [[PRICES.find(p => p[0] === filters.price)[1], () => { filters.price = ''; renderMenu(); }]] : []),
    ...[...filters.brands].map(k => [k, () => toggle(filters.brands, k)])];
  $('active-filters').replaceChildren(...active.map(([label, remove]) => {
    const b = button(`${label} ✕`, remove, 'chip active-chip'); b.setAttribute('aria-label', `Remove filter ${label}`); return b;
  }));
  $('active-filters').hidden = !active.length;
  $('filter-button').textContent = activeFilterCount() ? `Filters (${activeFilterCount()})` : 'Filters';
}
function sortProducts(list) {
  const min = p => Math.min(...p.variants.map(v => v.priceCents));
  const value = p => Math.min(...p.variants.map(v => v.pricePerGramCents ?? Infinity));
  const by = { name: (a, b) => a.name.localeCompare(b.name), 'price-desc': (a, b) => min(b) - min(a),
    thc: (a, b) => (b.thc?.[1] ?? -1) - (a.thc?.[1] ?? -1), value: (a, b) => value(a) - value(b) }[$('menu-sort').value]
    || ((a, b) => min(a) - min(b));
  return list.sort((a, b) => by(a, b) || a.name.localeCompare(b.name));
}
function renderMenu() {
  const products = menu?.products || [], base = menuBase();
  const visible = sortProducts(base.filter(p => matches.types(p) && matches.sizes(p) && matches.brands(p) && matches.price(p)));
  renderFilters(base);
  $('menu-products').replaceChildren(...visible.map(productCard));
  if (!visible.length) {
    const box = empty(menu ? 'No products match those filters. Try another category, search or filter.' : 'The menu is not available right now. Please call the shop for today’s selection.');
    if (menu && activeFilterCount()) box.append(button('Clear filters', clearFilters, 'secondary-button'));
    $('menu-products').append(box);
  }
  $('home-products').replaceChildren(...products.slice(0, 3).map(productCard));
  if (!products.length) $('home-products').append(empty(menu ? 'There are no products available in this menu right now.' : 'We’re getting the menu ready. Your budtender can help with today’s selection.'));
  $('menu-count').textContent = `${visible.length} ${visible.length === 1 ? 'product' : 'products'}`;
  $('filter-done').textContent = `Show ${visible.length} ${visible.length === 1 ? 'product' : 'products'}`;
  $('menu-error').textContent = menuError; $('menu-error').hidden = !menuError;
  $('menu-tax').textContent = menu ? `${menu.pricesIncludeTax ? 'Prices include tax.' : 'Prices do not include tax.'} Availability and final pricing are confirmed in store.${canOrder() ? ' Add items to order ahead for pickup.' : ''}` : '';
  $('menu-freshness').textContent = demo ? 'Sample menu' : menu?.stale ? 'Update delayed' : menu ? `Updated ${new Date(menu.updatedAt).toLocaleTimeString([], { hour:'numeric',minute:'2-digit' })}` : 'Menu unavailable';
  const categoryRow = $('category-filters'); categoryRow.replaceChildren();
  for (const name of ['All', ...(menu?.categories || [])]) {
    const b = button(name, () => { category = name; renderMenu(); }, ''); b.setAttribute('aria-pressed', String(category === name)); categoryRow.append(b);
  }
}
function clearFilters() { filters.types.clear(); filters.sizes.clear(); filters.brands.clear(); filters.price = ''; renderMenu(); }
function setFilterPanel(open) {
  $('filter-panel').hidden = !open; $('filter-button').setAttribute('aria-expanded', String(open));
  if (!open) $('menu-count').scrollIntoView({ block: 'start', behavior: 'smooth' });
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
  if (view === 'order') { rewardPointsTried = false; renderOrder(); void refreshOrder(); }
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
      if (config.enabled) {
        const loadedUser = await api('session'); if (current !== generation) return; user = loadedUser;
        pushSubscribed = Boolean(user.signedIn && canPush() && await currentPushSubscription().catch(() => null));
      } else message('My Treehouse is being prepared. The quick points checker is still available on our website.');
    } catch { message('You’re offline or the app is temporarily unavailable. Reconnect to check your menu and points.'); }
  }
  if (current !== generation) return;
  renderHomePoints(); renderAccount(); renderMenu(); renderCartBar(); route(); void loadRewards();
  if (!demo) { void refreshMenu(); if (user.linked) void refreshPoints(); }
}
$('menu-search').addEventListener('input', renderMenu); $('menu-sort').addEventListener('change', renderMenu);
$('filter-button').addEventListener('click', () => setFilterPanel($('filter-panel').hidden));
$('filter-done').addEventListener('click', () => setFilterPanel(false));
$('filter-clear').addEventListener('click', clearFilters);
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
