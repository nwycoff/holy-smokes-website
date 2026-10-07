const $ = id => document.getElementById(id);
const demo = location.pathname === '/app/demo/' || location.pathname === '/app/demo/index.html';
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
let config = {}, user = { signedIn: false, linked: false }, points = null, menu = null;
let needsVerification = location.hash === '#verify-email', verification = null, verificationBusy = false;
let sourceRecorded = false;
const signupSources = ['register-1', 'register-2', 'bag-card-v1', 'menu-tvs', 'website'];
const from = new URL(location.href).searchParams.getAll('from');
const signupSource = from.length === 1 && signupSources.includes(from[0]) ? from[0] : 'direct';
// Keep only a public source label in memory; strip it before sign-in, sharing or installation.
if (from.length) { const clean = new URL(location.href); clean.searchParams.delete('from'); history.replaceState(null, '', clean); }
// A section or brand to show when a notification opens the menu, applied once the menu is loaded.
let menuLink = null;
let category = 'All', menuError = '', generation = 0, pendingInstall = null, menuLoading = false, pointsLoading = false;
let installing = false, installHelpOpen = false, installMessage = '';
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
// Visit ratings: a card on Home after a visit (at most every 60 days, decided by the server), and
// "Rate a recent visit" on My points any time. Everyone is invited to review the shop on Google;
// 1-3 stars also offers a private message to a manager.
let rating = null, forceRate = false;
const visitDay = ms => new Date(ms).toLocaleDateString([], { weekday: 'long' });
function stars(onPick) {
  const row = el('div', '', 'stars');
  for (let n = 1; n <= 5; n++) {
    const b = el('button', '★', 'star'); b.type = 'button'; b.setAttribute('aria-label', `${n} star${n > 1 ? 's' : ''}`);
    b.addEventListener('click', () => onPick(n).catch(error => message(error.message))); row.append(b);
  }
  return row;
}
function googleLink(text, id) {
  const a = link(text, rating?.google || '#', 'secondary-button'); a.target = '_blank'; a.rel = 'noopener';
  a.addEventListener('click', () => { if (!demo) void api('feedback/google', { id }).catch(() => {}); });
  return a;
}
function feedbackCard() {
  const visit = user.linked ? user.feedback?.visit : null;
  if (!visit && !rating) return null;
  const card = el('section', '', 'account-panel feedback-card');
  if (!rating) {
    card.append(el('p', 'HOW DID WE DO?', 'eyebrow'), el('h3', `How was your visit on ${visitDay(visit.at)}?`),
      stars(async n => {
        const result = demo ? { id: 'demo', low: n <= 3, google: 'https://g.page/' } : await api('feedback/rate', { orderId: visit.id, rating: n });
        rating = { ...result, stars: n, sent: false }; user.feedback = { visit: null, ask: false }; renderFeedback();
      }));
    const later = el('div', '', 'action-row');
    later.append(button('Not now', () => postponeRating('later'), 'text-button'), button('Don’t ask me again', () => postponeRating('never'), 'text-button'));
    card.append(later);
  } else if (!rating.low) {
    card.append(el('p', 'THANK YOU', 'eyebrow'), el('h3', 'Thanks! We’re so glad you had a good visit.'));
    if (rating.google) card.append(el('p', 'Would you share it on Google? It really helps a local shop.', 'fine-print'), googleLink('Review us on Google ↗', rating.id));
    card.append(button('Done', () => { rating = null; renderFeedback(); }, 'text-button'));
  } else if (!rating.sent) {
    const text = el('textarea'); text.rows = 4; text.maxLength = 1000; text.placeholder = 'What happened? Add the best way to reach you if you’d like a call.';
    const contact = el('label', '', 'remember-license'), box = el('input'); box.type = 'checkbox';
    contact.append(box, document.createTextNode(' Please have a manager contact me'));
    card.append(el('p', 'WE’RE SORRY', 'eyebrow'), el('h3', 'Tell us what happened, and a manager will make it right.'), text, contact,
      button('Send to the manager', async () => {
        if (!text.value.trim() && !box.checked) { message('Write a few words or tick “Please have a manager contact me”.'); return; }
        if (!demo) await api('feedback/message', { id: rating.id, comment: text.value, contact: box.checked });
        rating.sent = true; renderFeedback();
      }));
    if (rating.google) card.append(el('p', 'You can also leave a review on Google.', 'fine-print'), googleLink('Review us on Google ↗', rating.id));
  } else {
    card.append(el('p', 'THANK YOU', 'eyebrow'), el('h3', 'Thanks for telling us. A manager will look at this soon.'),
      button('Done', () => { rating = null; renderFeedback(); }, 'text-button'));
  }
  return card;
}
async function postponeRating(mode) {
  if (!demo) await api('feedback/later', { mode });
  user.feedback = { ...user.feedback, ask: false }; forceRate = false;
  message(mode === 'never' ? 'We won’t ask about visits again. You can still rate one from My points.' : 'No problem. We’ll ask another time.'); renderFeedback();
}
// Home shows the card when the server says it's time (or after "Rate a recent visit" / a rating
// notification); My points always offers a link while a recent visit is unrated.
function renderFeedback() {
  const card = rating || user.feedback?.ask || forceRate ? feedbackCard() : null;
  $('home-feedback').replaceChildren(...(card ? [card] : []));
  renderRewards();
}

// The customer's welcome-gift code for turning on Deals & news, to show at checkout.
function welcomeGiftPanel() {
  const gift = user.linked ? user.welcomeGift : null;
  if (!gift?.code) return null;
  const panel = el('section', '', 'account-panel welcome-gift'), ends = gift.endsOn
    ? ` Offer ends ${new Date(`${gift.endsOn}T12:00:00`).toLocaleDateString([], { month: 'long', day: 'numeric' })}.` : '';
  panel.append(el('p', 'WELCOME GIFT', 'eyebrow'),
    el('h3', gift.description ? `Thanks for turning on Deals & news: ${gift.description}` : 'Thanks for turning on Deals & news!'),
    el('p', `Show this code at checkout. One per customer.${ends}`, 'fine-print'), el('strong', gift.code, 'gift-code'),
    button('I’ve used it – remove it', async () => {
      if (!confirm('Remove your welcome gift code? Only do this after you’ve received your gift. It can’t be brought back.')) return;
      if (!demo) await api('welcome/dismiss', {});
      user.welcomeGift = null; message('Your welcome gift code has been removed.'); renderRewards();
    }, 'text-button'));
  return panel;
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
const standalone = () => matchMedia('(display-mode: standalone)').matches || Boolean(navigator.standalone);
const appleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const iosBrowserTab = () => appleMobile() && !standalone();
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
  pushSubscribed = true; message(marketingTopics().length ? 'This device will get your Treehouse notifications.' : 'We’ll notify this device when your order is ready.'); renderOrder(); renderAccount();
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
// "Deals & news": marketing notifications the customer opts in to, by topic. Order-ready
// alerts are separate. The choice is per account; devices are the ones set up for notifications.
const TOPIC_LABELS = { new_arrivals: 'New arrivals & restocks', rewards: 'Rewards & points reminders', events: 'Events', specials: 'Specials' };
const marketingOn = () => Boolean((demo || config.marketingEnabled) && user.linked && user.marketing);
const marketingTopics = () => user.marketing?.topics || [];
async function saveMarketing(body) {
  const result = demo ? { marketing: { topics: body.topics || [], ask: false } } : await api('marketing', body);
  user.marketing = result.marketing; renderAccount(); renderOrder(); renderRewards();
}
async function turnOnMarketing(source) {
  if (!demo && !pushSubscribed) await enableNotifications();
  if (!demo && !pushSubscribed) return; // Permission was declined; enableNotifications explained why.
  await saveMarketing({ topics: Object.keys(TOPIC_LABELS), source });
  message('Deals & news is on. You can choose topics or turn it off under Account anytime.');
}
const MARKETING_PROMISE = 'No more than 2 a week, never late at night, and kept discreet on your lock screen.';
// Why this device can't show notifications, or '' when it can (or the demo pretends to).
function deviceBlock() {
  if (demo) return '';
  if (iosBrowserTab() && !canPush()) return 'On iPhone, add My Treehouse to your Home Screen (Share → Add to Home Screen) and open it from there to get notifications.';
  if (!canPush()) return 'This browser can’t show notifications. Open My Treehouse on your phone to turn them on.';
  if (Notification.permission === 'denied') return 'Notifications are blocked for this app. Turn them on in your phone’s settings first.';
  return '';
}
// One place for every notification setting: order updates (per device) and Deals & news (per account).
function notificationsPanel() {
  const orders = user.linked && (demo || Boolean(config.pushKey)), news = marketingOn();
  if (!orders && !news) return null;
  const panel = el('section', '', 'account-panel notifications-panel'), blocked = deviceBlock();
  panel.append(el('h3', 'Notifications'));
  if (orders) {
    const row = el('div', '', 'setting-row');
    row.append(el('h4', 'Order updates on this phone'));
    if (pushSubscribed) row.append(el('p', 'On. We’ll let you know here when your order is ready for pickup.', 'fine-print'),
      button('Turn off on this phone', async () => {
        if (!demo) await disableNotifications(); pushSubscribed = false;
        message(marketingTopics().length ? 'Notifications are off on this phone, including Deals & news.' : 'Order updates are off on this phone.');
        renderAccount(); renderOrder();
      }, 'text-button'));
    else if (blocked) row.append(el('p', blocked, 'fine-print'));
    else row.append(el('p', 'Get a notification when your order is ready for pickup.', 'fine-print'),
      button('Turn on order updates', async () => { if (demo) { pushSubscribed = true; renderAccount(); renderOrder(); } else await enableNotifications(); }, 'secondary-button'));
    panel.append(row);
  }
  if (news) {
    const row = el('div', '', 'setting-row'), topics = marketingTopics();
    row.append(el('h4', 'Deals & news'));
    if (!topics.length) {
      row.append(el('p', `Hear first about new arrivals, rewards you can use, and events. ${MARKETING_PROMISE}`, 'fine-print'));
      if (blocked) row.append(el('p', blocked, 'fine-print'));
      else row.append(button('Turn on Deals & news', () => turnOnMarketing('account'), 'secondary-button'));
    } else {
      row.append(el('p', `On. ${MARKETING_PROMISE} Choose what you’d like to hear about:`, 'fine-print'));
      for (const [topic, text] of Object.entries(TOPIC_LABELS)) {
        const label = el('label', '', 'topic-choice'), box = el('input'); box.type = 'checkbox'; box.checked = topics.includes(topic);
        box.addEventListener('change', async () => {
          const next = Object.keys(TOPIC_LABELS).filter(t => t === topic ? box.checked : topics.includes(t));
          box.disabled = true;
          try { await saveMarketing({ topics: next, source: 'account' }); if (!next.length) message('Deals & news is off.'); }
          catch (error) { box.checked = !box.checked; box.disabled = false; message(error.message); }
        });
        label.append(box, document.createTextNode(` ${text}`)); row.append(label);
      }
      if (!pushSubscribed) row.append(el('p', blocked || 'Turn on order updates above to get Deals & news on this phone too.', 'fine-print'));
      row.append(button('Turn off Deals & news', async () => {
        await saveMarketing({ topics: [], source: 'account' }); message('Deals & news is off. Order updates aren’t affected.');
      }, 'text-button'));
    }
    panel.append(row);
  }
  // Both kinds arrive through this phone's notification setting, so say so once.
  if (orders && news) panel.append(el('p', 'Order updates are set for each phone. Deals & news follows your account to every phone with order updates on.', 'fine-print'));
  return panel;
}
// Asked at a good moment (an order is ready or picked up, or on My points), once per 90 days at most.
function marketingPrompt(dark = false) {
  if (!marketingOn() || marketingTopics().length || !user.marketing.ask || !(demo || canPush()) || (!demo && globalThis.Notification?.permission === 'denied')) return null;
  const card = el('div', '', `marketing-prompt${dark ? ' on-dark' : ''}`), row = el('div', '', 'action-row');
  card.append(el('strong', 'Want first word on new arrivals?'),
    el('p', `Turn on Deals & news for new arrivals, rewards you can use, and events. ${MARKETING_PROMISE}`, 'fine-print'));
  row.append(button('Yes, turn it on', () => turnOnMarketing('prompt'), 'secondary-button'),
    button('Not now', () => saveMarketing({ dismissed: true }), 'text-button'));
  card.append(row); return card;
}
const canOrder = () => demo || Boolean(config.preorderEnabled && user.linked);
const orderingOn = () => demo || Boolean(config.preorderEnabled);
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
// Messages show as a banner just above the bottom of the screen, next to where the customer
// is tapping, and fade after a few seconds (longer for longer messages). Tap ✕ to dismiss.
let messageTimer;
function message(text = '') {
  clearTimeout(messageTimer);
  $('app-message-text').textContent = text; $('app-message').hidden = !text;
  if (text) messageTimer = setTimeout(() => { $('app-message').hidden = true; }, Math.max(5000, text.length * 70));
}
async function api(path, body, csrf = user.csrf || '', timeoutMs = 15000) {
  const response = await fetch(`/api/app/${path}`, { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'strict-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Treehouse-CSRF': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
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
    panel.append(loginForm('Create account →', 'signup'), loginForm('Already have an account? Sign in', 'login', 'secondary-button'));
  } else panel.append(el('p', 'Account sign-in is being prepared. You can use the existing points checker in the meantime.', 'notice'));
  panel.append(link('Use the quick points checker ↗', '/rewards', 'text-button'), el('p', 'Signing up does not subscribe you to marketing.', 'fine-print'));
  return panel;
}
function loginForm(text, route = 'login', style = 'primary-button') {
  const form = el('form'); form.method = 'post'; form.action = `/api/app/${route}`;
  const submit = el('button', text, style); submit.type = 'submit';
  form.append(submit); return form;
}
function verificationPanel() {
  const panel = el('section', '', 'account-panel verification-panel');
  panel.append(el('h2', 'Check your email to continue.'),
    el('p', 'Open the verification message from our sign-in service and follow its link. Check Spam or Junk if it hasn’t arrived.'),
    loginForm('I’ve verified my email — continue', 'login'),
    el('p', 'Then sign in with the same account. Your budtender can issue your connection code once you reach the next step.', 'fine-print'));
  if (verification?.canResend) panel.append(button('Resend verification email', async () => {
    await api('verification/resend', {}, verification.csrf);
    message('Another verification email was requested. Please check your inbox and Spam or Junk. Wait before requesting another.');
  }, 'secondary-button'));
  else panel.append(el('p', 'Still missing the email? Sign in again, or ask the shop to resend it. Don’t create a second account.', 'fine-print'));
  panel.append(link('Call the shop for help', 'tel:+15807166720', 'text-button'));
  return panel;
}
async function loadVerification() {
  if (demo || verificationBusy || verification || !config.enabled) return;
  verificationBusy = true; const current = generation;
  try { const result = await api('verification/status'); if (current === generation) verification = result; }
  catch { /* The continue and shop-help actions remain usable. */ }
  finally { verificationBusy = false; if (current === generation) renderAccount(); }
}
// Simple illustrations accompany real browser actions; they never imitate an install dialog.
function installPicture(kind) {
  const frame = el('span', '', 'install-picture'); frame.setAttribute('aria-hidden', 'true');
  if (kind === 'app') {
    const icon = el('img'); icon.src = '/images/img6.png'; icon.alt = ''; icon.width = 48; icon.height = 48; frame.append(icon);
  } else {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 32 32', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', focusable: 'false' })) svg.setAttribute(key, value);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', ({ share: 'M16 20V3m-5 5 5-5 5 5M10 13H6v16h20V13h-4', add: 'M9 3h14v26H9ZM13 16h6m-3-3v6M14 25h4', menu: 'M5 8h22M5 16h22M5 24h22' })[kind]);
    svg.append(path); frame.append(svg);
  }
  return frame;
}
function installGuidance(setup = false) {
  const panel = el('section', '', 'setup-install');
  panel.append(el('h3', `${setup ? '3. ' : ''}Add to Home Screen`));
  if (standalone()) {
    panel.append(el('p', '✓ You’re using the installed app.', 'install-complete'));
    return panel;
  }
  panel.append(el('p', iosBrowserTab()
    ? 'Keep Treehouse one tap away. On iPhone and iPad, open the Home Screen app before turning on notifications.'
    : 'Keep your menu and points one tap away. Adding the app is optional.'));
  if (pendingInstall || installing) {
    const install = button(installing ? 'Opening installation…' : 'Install Treehouse', requestInstall);
    install.disabled = installing; panel.append(install);
  }
  if (installMessage) {
    const status = el('p', installMessage, 'fine-print'); status.setAttribute('role', 'status'); panel.append(status);
  }
  const guide = el('details', '', 'install-guide'); guide.open = installHelpOpen;
  guide.addEventListener('toggle', () => { if (guide.isConnected) installHelpOpen = guide.open; });
  guide.append(el('summary', pendingInstall || installing ? 'See installation steps' : 'Add to Home Screen — show me how'));
  const steps = el('ol', '', 'install-steps');
  const instructions = iosBrowserTab() ? [
    ['share', 'Open Share in Safari', 'Open this page in Safari. Tap the Share icon (a square with an up arrow). It may be inside the page menu.'],
    ['add', 'Add Treehouse', 'Scroll down and tap Add to Home Screen. If you see Open as Web App, turn it on. Then tap Add.'],
    ['app', 'Open your new icon', 'Tap Treehouse on your Home Screen. Use the same account if asked to sign in. Choose your notifications under Account.']
  ] : /Android/i.test(navigator.userAgent) ? [
    ['menu', 'Open your browser menu', 'In Chrome, tap the three dots beside the address bar. If this page opened inside another app, open it in Chrome first.'],
    ['add', 'Install the app', 'Choose Install app or Add to Home screen, then confirm. If you already added Treehouse, look for its icon on your phone.'],
    ['app', 'Open Treehouse', 'Tap the new icon. Use the same account if asked to sign in, then choose your notifications under Account.']
  ] : [
    ['menu', 'Open your browser menu', 'Look for Install app. On a Mac using Safari, choose File → Add to Dock.'],
    ['add', 'Confirm, then open Treehouse', 'Follow your browser’s instructions, then open Treehouse from your apps.'],
    ['app', 'Want it on your phone?', 'Open this app’s address on your phone and use the same account. The installation steps will match your phone.']
  ];
  for (const [picture, title, text] of instructions) {
    const item = el('li'), copy = el('div'); copy.append(el('h4', title), el('p', text));
    item.append(installPicture(picture), copy); steps.append(item);
  }
  guide.append(steps);
  if (iosBrowserTab()) guide.append(el('p', 'Can’t find Add to Home Screen? Scroll to the bottom of Safari’s Share menu, tap Edit Actions, and add it there.', 'fine-print'));
  panel.append(guide, el('p', 'You can keep checking points and ordering in your browser.', 'fine-print'));
  return panel;
}
function renderInstallation() {
  renderSetup();
  $('account-install').replaceChildren(installGuidance());
}
async function requestInstall() {
  if (!pendingInstall || installing || standalone()) return;
  // Consume each browser event once, and invoke prompt within the customer's click.
  const prompt = pendingInstall; pendingInstall = null; installing = true; installMessage = '';
  renderInstallation();
  try {
    const choice = await prompt.prompt() || await prompt.userChoice;
    installMessage = choice?.outcome === 'accepted'
      ? 'When the Treehouse icon appears, open it to finish setting up notifications under Account.'
      : 'You can add Treehouse later. Your points and ordering still work here.';
  } catch {
    installMessage = 'The installation prompt couldn’t open. Follow the steps below instead.'; installHelpOpen = true;
  } finally { installing = false; renderInstallation(); }
}
function renderSetup() {
  const target = $('setup-content'); if (!target) return;
  const progress = el('ol', '', 'setup-progress');
  for (const [label, done] of [['Create account and verify email', user.signedIn], ['Connect your rewards', user.linked],
    ['Add to Home Screen', standalone()], ['Choose notifications (optional)', pushSubscribed]]) {
    const item = el('li', `${done ? '✓ ' : ''}${label}`, done ? 'complete' : ''); progress.append(item);
  }
  target.replaceChildren(progress);
  if (!user.signedIn) { target.append(needsVerification ? verificationPanel() : signInPanel()); return; }
  if (!user.linked) {
    target.append(el('p', 'You’re ready for your budtender to connect your rewards during this visit. The code expires 10 minutes after it is issued.', 'setup-note'), linkPanel('setup-connection-code'));
    target.append(link('Browse the menu while you wait →', '#menu', 'text-button')); return;
  }
  target.append(el('h2', 'Your rewards are connected.'), el('p', points ? `Your balance is ${formatPoints(points.points)} points.` : 'You can now check your points and order ahead.'),
    link('View my points →', '#rewards', 'primary-button'), installGuidance(true));
  if (iosBrowserTab()) {
    const next = el('section', '', 'account-panel setup-notifications');
    next.append(el('h3', '4. Choose notifications (optional)'), el('p', 'Open Treehouse from its Home Screen icon, then go to Account to choose order updates and Deals & news.'));
    target.append(next);
  } else {
    const notifications = notificationsPanel();
    if (notifications) { notifications.querySelector('h3').textContent = '4. Choose notifications (optional)'; target.append(notifications); }
  }
  target.append(el('p', 'Deals & news is your choice. Points and ordering work without it.', 'fine-print'), link('Finish setup and browse the menu →', '#menu', 'text-button'));
}
function linkPanel(inputId = 'connection-code') {
  const panel = el('section', '', 'account-panel');
  panel.append(el('h2', 'One quick introduction.'), el('p', 'Ask your budtender for a connection code after they check your customer record. Enter the 8-digit code here within 10 minutes.'));
  const form = el('form'), label = el('label', 'Connection code'), input = el('input');
  label.htmlFor = inputId; input.id = inputId; input.dataset.connection = 'true'; input.autocomplete = 'off'; input.spellcheck = false;
  input.autocapitalize = 'off'; input.inputMode = 'numeric'; input.required = true;
  input.maxLength = 24; input.placeholder = '1234 5678'; // Allow pasting an unexpired legacy code.
  const submit = el('button', 'Connect my points →', 'primary-button'); submit.type = 'submit';
  form.append(label, input, el('p', 'A code works once. You won’t need your patient ID to sign in again.'), submit);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; const current = generation;
    try {
      await api('enroll', { code: input.value.trim() }); input.value = '';
      if (current !== generation) return;
      user.linked = true;
      // Reload account-dependent settings immediately; an unlinked session has no marketing state.
      try { const fresh = await api('session'); if (current !== generation) return; user = fresh; }
      catch { message('Your rewards connected. Reopen the app to finish notification setup.'); }
      if (current !== generation) return;
      renderAccount(); renderMenu(); renderCartBar(); await refreshPoints();
      location.hash = 'setup'; route();
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
  const gift = welcomeGiftPanel(); if (gift) target.append(gift);
  if (user.feedback?.visit && !rating && !user.feedback.ask && !forceRate) target.append(button('Rate a recent visit', () => {
    forceRate = true; renderFeedback(); location.hash = 'home'; }, 'text-button'));
  const ask = marketingPrompt(); if (ask) target.append(ask);
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
  finally { pointsLoading = false; if (current === generation) { renderHomePoints(); renderRewards(); renderSetup(); } }
}
function clearPrivate() {
  generation++; points = null; order = null; rating = null; forceRate = false; orderLicense = ''; selectedReward = ''; rememberLicense = false; changingLicense = false;
  user = { signedIn: false, linked: false };
  verification = null;
  for (const input of document.querySelectorAll('input[data-connection]')) input.value = '';
  renderHomePoints(); renderAccount(); renderRewards(); renderOrder(); renderCartBar();
}
async function signOut(all = false) {
  if (!demo) { await disableNotifications(); await api(all ? 'logout-all' : 'logout', {}); }
  cart = []; clearPrivate(); message('You’re signed out.'); location.hash = 'account';
}
function renderAccount() {
  renderInstallation();
  const target = $('account-content'); target.replaceChildren();
  if (!user.signedIn) { target.append(needsVerification ? verificationPanel() : signInPanel()); return; }
  const panel = el('section', '', 'account-panel');
  panel.append(el('h2', 'You’re right at home.'), el('p', user.linked ? 'Your rewards connection is active. You can check your balance from My points.' : 'Your account is ready. Connect your rewards with a code from your budtender.'));
  panel.append(link(user.linked ? 'View my points →' : 'Connect my rewards →', '#rewards', 'primary-button'));
  panel.append(link('Open setup guide →', '#setup', 'text-button'));
  const actions = el('div', '', 'action-row');
  actions.append(button('Sign out', () => signOut(), 'text-button'), button('Sign out on all devices', () => signOut(true), 'text-button'));
  if (licenseMemory() && user.licenseHint) actions.append(button(`Forget my saved license number (ending ${user.licenseHint})`, async () => {
    if (!demo) await api('license/forget', {});
    user.licenseHint = undefined; message('Your saved license number has been removed.'); renderAccount(); renderOrder();
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
  const notifications = notificationsPanel(); if (notifications) target.append(notifications);
}
function productCard(product) {
  const card = $('product-template').content.firstElementChild.cloneNode(true);
  card.querySelector('.product-category').textContent = product.category;
  card.querySelector('.product-type').textContent = product.type;
  card.querySelector('.product-brand').textContent = product.brand;
  card.querySelector('.product-name').textContent = product.name;
  const range = (label, r, digits = 1) => r ? `${label} ${r[0].toFixed(digits)}${r[0] !== r[1] ? '–' + r[1].toFixed(digits) : ''}%` : '';
  card.querySelector('.product-thc').textContent = [range('Total THC', product.thc), product.cbd?.[1] >= 1 ? range('CBD', product.cbd) : '',
    range('Terpenes', product.terpenes, 2)]
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
// Store purchase limits (per order), mirrored from the server's config.
const limitTotals = (extra) => {
  const totals = {};
  for (const line of [...cart, ...(extra ? [extra] : [])])
    if (line.limitGroup && Number.isFinite(line.limitUse)) totals[line.limitGroup] = (totals[line.limitGroup] || 0) + line.limitUse * line.qty;
  return totals;
};
const limitText = (group) => { const l = config.purchaseLimits[group]; return `${l.max}${l.unit === 'each' ? '' : ` ${l.unit}`} ${l.label}`; };
function overLimit(line) {
  const limit = config.purchaseLimits?.[line.limitGroup];
  if (!limit || !Number.isFinite(line.limitUse)) return '';
  const total = (limitTotals()[line.limitGroup] || 0) + line.limitUse;
  return total > limit.max + 1e-6 ? `That would put your order over the ${limitText(line.limitGroup)} limit.` : '';
}
function addToCart(product, variant) {
  if (cartCount() >= MAX_ITEMS) { message(`Pickup orders can have up to ${MAX_ITEMS} items.`); return; }
  const line = cart.find(l => l.productId === product.id && l.size === variant.size);
  if ((line?.qty || 0) >= (variant.available ?? Infinity)) { message('That’s all we have of that one right now.'); return; }
  const over = overLimit({ limitGroup: product.limitGroup, limitUse: variant.limitUse });
  if (over) { message(over); return; }
  if (line) { line.qty++; line.available = variant.available; }
  else cart.push({ productId: product.id, size: variant.size, priceCents: variant.priceCents, name: product.name, brand: product.brand, qty: 1,
    available: variant.available, limitGroup: product.limitGroup, limitUse: variant.limitUse });
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
    line.available = variant.available; line.limitUse = variant.limitUse;
    if (variant.available !== undefined && line.qty > variant.available) { line.qty = variant.available; changed = true; }
    return line.qty > 0;
  });
  if (changed) message('Your order was updated to match the latest menu. Please review it.');
}
function renderCartBar() {
  const count = cartCount(), show = canOrder();
  // The Order tab shows whenever ordering is on, so new customers can see how to get started.
  for (const link of document.querySelectorAll('.order-nav')) link.hidden = !(show || orderingOn());
  for (const badge of document.querySelectorAll('.order-count')) { badge.hidden = !count; badge.textContent = String(count); }
  const bar = $('cart-bar'); bar.hidden = !show || !count;
  document.body.classList.toggle('cart-bar-showing', !bar.hidden && location.hash === '#menu');
  bar.replaceChildren(el('span', `${count} ${count === 1 ? 'item' : 'items'} · ${money.format(cartTotal() / 100)}`), el('strong', 'Review order →'));
}
// Store closing times (Central), the same as the website. Orders are held until closing on the
// day they're placed; an order placed after closing is held until closing the next day.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CLOSES = { Sun: 20, Mon: 22, Tue: 22, Wed: 22, Thu: 22, Fri: 22, Sat: 21 };
const centralParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23' }).formatToParts(ms).map(p => [p.type, p.value]));
function holdMessage(placedMs, nowMs = Date.now()) {
  const placed = centralParts(placedMs), late = Number(placed.hour) >= CLOSES[placed.weekday];
  const holdMs = placedMs + (late ? 86400000 : 0), hold = centralParts(holdMs), close = CLOSES[hold.weekday];
  const date = p => `${p.year}-${p.month}-${p.day}`, now = centralParts(nowMs), tomorrow = centralParts(nowMs + 86400000);
  const day = date(hold) === date(now) ? 'today' : date(hold) === date(tomorrow) ? 'tomorrow'
    : new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long' }).format(holdMs);
  return `We’ll hold your order until we close ${day} at ${close > 12 ? close - 12 : close} pm.`;
}
function orderStatusPanel() {
  const panel = el('section', '', 'points-card account-panel order-status');
  panel.append(el('p', demo ? 'SAMPLE ORDER' : order.orderNumber ? `ORDER #${order.orderNumber}` : 'YOUR ORDER', 'eyebrow'),
    el('h2', ORDER_STATUS[order.status] || 'Received. Please call the shop with any questions.'),
    el('p', `${order.itemCount} ${order.itemCount === 1 ? 'item' : 'items'} · ${money.format(order.totalCents / 100)} · placed ${new Date(order.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`));
  if (order.rewardName) panel.append(el('p', `Reward requested: ${order.rewardName}. Your budtender applies it at pickup.`));
  if (order.open) panel.append(el('p', `${holdMessage(order.createdAt)} Pay in store when you pick up. Bring your ID and medical card.`),
    button('Refresh status ↻', () => refreshOrder(true), 'light-button'));
  const notify = order.open && order.status !== 'Fulfilled' ? notifyControl() : null;
  if (notify) { const row = el('div', '', 'notify-row'); row.append(notify); panel.append(row); }
  const ask = ['Fulfilled', 'Completed'].includes(order.status) ? marketingPrompt(true) : null;
  if (ask) { const row = el('div', '', 'notify-row'); row.append(ask); panel.append(row); }
  return panel;
}
// For customers who can't order yet: where they are in the three steps.
function orderSteps() {
  const panel = el('section', '', 'account-panel order-steps'), list = el('ol');
  panel.append(el('h2', 'Order online for in-store pickup.'));
  [['Sign in or create your account', user.signedIn], ['Get an 8-digit code from your budtender to connect your store record', user.linked],
    ['Pick your items here, and pay when you pick up', false]].forEach(([text, done]) => {
    const item = el('li', done ? `${text} ✓` : text); if (done) item.className = 'step-done'; list.append(item);
  });
  panel.append(list); return panel;
}
function renderOrder() {
  const target = $('order-content'); target.replaceChildren();
  if (!canOrder()) {
    if (orderingOn() && !user.linked) target.append(orderSteps());
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
      else if (overLimit(line)) message(overLimit(line));
      else if (cartCount() < MAX_ITEMS) line.qty++; else message(`Pickup orders can have up to ${MAX_ITEMS} items.`);
      renderOrder(); renderCartBar();
    }, 'qty-button');
    less.setAttribute('aria-label', `One fewer ${line.name}`); more.setAttribute('aria-label', `One more ${line.name}`);
    qty.append(less, el('span', String(line.qty)), more);
    item.append(info, qty, el('b', money.format(line.priceCents * line.qty / 100))); list.append(item);
  }
  const total = el('p', '', 'order-total'); total.append(el('span', 'Estimated total'), el('strong', money.format(cartTotal() / 100)));
  const usage = Object.entries(limitTotals()).filter(([group]) => config.purchaseLimits?.[group])
    .map(([group, used]) => `${Math.round(used * 100) / 100} of ${limitText(group)}`);
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
  panel.append(list, total, ...(usage.length ? [el('p', `Purchase limits this order: ${usage.join(' · ')}`, 'fine-print limit-usage')] : []),
    el('p', menu?.pricesIncludeTax === false ? 'Prices do not include tax.' : 'Prices include tax.', 'fine-print'),
    ...rewardRow, ...licenseParts, label, note, submit,
    el('p', 'We hold orders until we close the day you order (until close tomorrow if you order after hours). Pay in store when you pick up. Bring your ID and medical card. Availability and final price are confirmed at the counter.', 'fine-print'));
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
    const box = empty(menu ? 'No products match those filters. Try another category, search or filter.' : menuLoading ? 'Getting the menu ready…' : 'The menu is not available right now. Please call the shop for today’s selection.');
    if (!menu && !menuLoading && config.menuEnabled) box.append(button('Try again', () => void refreshMenu(), 'secondary-button'));
    if (menu && activeFilterCount()) box.append(button('Clear filters', clearFilters, 'secondary-button'));
    $('menu-products').append(box);
  }
  $('home-products').replaceChildren(...products.slice(0, 3).map(productCard));
  if (!products.length) $('home-products').append(empty(menu ? 'There are no products available in this menu right now.' : 'We’re getting the menu ready. Your budtender can help with today’s selection.'));
  $('menu-count').textContent = `${visible.length} ${visible.length === 1 ? 'product' : 'products'}`;
  $('filter-done').textContent = `Show ${visible.length} ${visible.length === 1 ? 'product' : 'products'}`;
  $('menu-error').textContent = menuError; $('menu-error').hidden = !menuError;
  const hint = $('menu-order-hint'), showHint = Boolean(menu && orderingOn() && !canOrder());
  hint.hidden = !showHint;
  if (showHint) hint.replaceChildren(document.createTextNode(user.signedIn
    ? 'Connect your account with a code from your budtender to order online for in-store pickup. '
    : 'Sign in and connect your account to order online for in-store pickup. '), link('How it works →', '#order', 'text-button'));
  $('menu-tax').textContent = menu ? `${menu.pricesIncludeTax ? 'Prices include tax.' : 'Prices do not include tax.'} Availability and final pricing are confirmed in store.${canOrder() ? ' Add items to order ahead for pickup.' : ''}` : '';
  $('menu-freshness').textContent = demo ? 'Sample menu' : menu?.stale ? 'Update delayed' : menu ? `Updated ${new Date(menu.updatedAt).toLocaleTimeString([], { hour:'numeric',minute:'2-digit' })}` : menuLoading ? 'Checking the menu…' : 'Menu unavailable';
  const categoryRow = $('category-filters'); categoryRow.replaceChildren();
  for (const name of ['All', ...(menu?.categories || [])]) {
    const b = button(name, () => { category = name; renderMenu(); }, ''); b.setAttribute('aria-pressed', String(category === name)); categoryRow.append(b);
  }
}
function clearFilters() { filters.types.clear(); filters.sizes.clear(); filters.brands.clear(); filters.price = ''; renderMenu(); }
function applyMenuLink() {
  if (!menuLink || !menu) return;
  const wanted = menuLink; menuLink = null;
  filters.types.clear(); filters.sizes.clear(); filters.brands.clear(); filters.price = ''; category = 'All';
  if (wanted.category && (menu.categories || []).includes(wanted.category)) category = wanted.category;
  else if (wanted.brand && menu.products.some(p => p.brand === wanted.brand)) filters.brands.add(wanted.brand);
  else message(wanted.brand ? 'That brand isn’t on the menu right now, so here’s the full menu.' : 'That section isn’t on the menu right now, so here’s the full menu.');
  history.replaceState(null, '', '#menu');
  renderMenu();
}
function setFilterPanel(open) {
  $('filter-panel').hidden = !open; $('filter-button').setAttribute('aria-expanded', String(open));
  if (!open) $('menu-count').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
async function refreshMenu() {
  if (demo || !config.menuEnabled || menuLoading) return;
  menuLoading = true;
  renderMenu();
  try {
    let updated;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { updated = await api('menu'); break; }
      catch (error) {
        if (attempt || (error.status && error.status < 500 && error.status !== 429)) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    menu = updated; menuError = menu.stale ? 'The last menu update was delayed. Please confirm availability with the shop.' : '';
    reconcileCart();
  }
  catch {
    if (menu) menu = { ...menu, stale: true };
    menuError = menu ? 'Showing the last available menu. Please confirm availability with the shop.'
      : 'We can’t refresh the menu right now. Please try again or call the shop for availability.';
  }
  finally { menuLoading = false; renderMenu(); renderCartBar(); applyMenuLink(); }
}
function route() {
  let [view, query = ''] = (location.hash.slice(1) || 'home').split('?');
  if (view === 'menu' && query) {
    const wanted = new URLSearchParams(query);
    menuLink = wanted.get('category') ? { category: wanted.get('category') } : wanted.get('brand') ? { brand: wanted.get('brand') } : null;
  }
  if (view === 'verify-email') { needsVerification = true; view = 'setup'; void loadVerification(); }
  if (view === 'rate') { view = 'home'; forceRate = true; renderFeedback(); history.replaceState(null, '', '#home'); }
  if (view === 'login-error') { view = 'account'; message('Sign-in could not finish. Please try again.'); }
  if (!['home', 'menu', 'rewards', 'account', 'order', 'setup'].includes(view)) view = 'home';
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  for (const a of document.querySelectorAll('nav a')) {
    if (a.getAttribute('href') === `#${view}`) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (view === 'rewards') { renderRewards(); if (user.linked && (!points || Date.now() - points.checkedAt > 30000)) void refreshPoints(); }
  if (view === 'menu') { applyMenuLink(); void refreshMenu(); }
  if (view === 'order') { rewardPointsTried = false; renderOrder(); void refreshOrder(); }
  if (view === 'setup') renderSetup();
  renderCartBar();
  document.title = `${({ home:'My Treehouse',menu:'Menu',rewards:'My Points',account:'My Account',order:'Order online',setup:'Set up My Treehouse' })[view]} | Treehouse Pharmacy`;
}
async function initialize() {
  const current = generation;
  if (demo) {
    const fixture = await import('./demo-data.js'); menu = fixture.demoMenu; config = { purchaseLimits: fixture.demoPurchaseLimits };
    user = { signedIn:true, linked:true, marketing:{ topics:[], ask:true }, welcomeGift:{ code:'TH-DEMO', description:'a sample gift', endsOn:null },
      feedback:{ visit:{ id:'demo', at:Date.now() - 86400000 }, ask:true } }; points = { points:750, checkedAt:Date.now() };
    $('demo-banner').hidden = false;
  } else {
    try {
      const loaded = await api('config'); if (current !== generation) return; config = loaded;
      if (config.enabled) {
        if (config.signupTrackingEnabled && !sourceRecorded) {
          sourceRecorded = true;
          // Await this bounded request so the first-party cookie survives the Auth0 redirect.
          await api('signup/visit', { source: signupSource }, '', 2000).catch(() => {});
          if (current !== generation) return;
        }
        const loadedUser = await api('session'); if (current !== generation) return; user = loadedUser;
        if (user.signedIn) needsVerification = false;
        pushSubscribed = Boolean(user.signedIn && canPush() && await currentPushSubscription().catch(() => null));
      } else message('My Treehouse is being prepared. The quick points checker is still available on our website.');
    } catch { message('You’re offline or the app is temporarily unavailable. Reconnect to check your menu and points.'); }
  }
  if (current !== generation) return;
  renderHomePoints(); renderAccount(); renderMenu(); renderCartBar(); renderFeedback(); route(); void loadRewards();
  if (!demo) { void refreshMenu(); if (user.linked) void refreshPoints(); }
}
$('menu-search').addEventListener('input', renderMenu); $('menu-sort').addEventListener('change', renderMenu);
$('app-message-close').addEventListener('click', () => message(''));
$('filter-button').addEventListener('click', () => setFilterPanel($('filter-panel').hidden));
$('filter-done').addEventListener('click', () => setFilterPanel(false));
$('filter-clear').addEventListener('click', clearFilters);
addEventListener('hashchange', () => { route(); window.scrollTo({ top:0,behavior:'instant' }); });
addEventListener('pagehide', clearPrivate);
addEventListener('pageshow', event => { if (event.persisted) void initialize(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearPrivate(); else void initialize();
});
addEventListener('beforeinstallprompt', event => {
  if (demo || standalone()) return;
  event.preventDefault(); pendingInstall = event; installMessage = ''; renderInstallation();
});
addEventListener('appinstalled', () => {
  pendingInstall = null; installMessage = 'Treehouse has been installed. Open its icon to finish setup under Account.'; renderInstallation();
});
matchMedia('(display-mode: standalone)').addEventListener('change', () => { renderAccount(); renderOrder(); });
if (!demo && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/app/sw.js', { scope:'/app/' }).catch(() => {});
setInterval(() => {
  if (document.hidden) return;
  if (['#home','#menu','#order',''].includes(location.hash)) void refreshMenu();
  if (location.hash === '#order' && order?.open) void refreshOrder();
}, 60000);
void initialize();
