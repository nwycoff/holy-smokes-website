const form = document.querySelector('#points-form');
const fields = document.querySelector('#lookup-fields');
const button = document.querySelector('#lookup-button');
const status = document.querySelector('#service-status');
const result = document.querySelector('#points-result');
const name = document.querySelector('#patient-name');
const suffix = document.querySelector('#patient-suffix');
let challengeToken = '', widget, clearTimer, controller;

function message(text, error = false) {
  status.textContent = text;
  status.hidden = !text;
  status.classList.toggle('error', error);
}
function clearBalance() {
  clearTimeout(clearTimer);
  controller?.abort();
  result.hidden = true;
  document.querySelector('#points-value').textContent = '';
  form.hidden = false;
  form.reset();
  challengeToken = '';
  button.disabled = true;
  if (widget !== undefined) window.turnstile?.reset(widget);
}
function loadChallenge(sitekey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onerror = reject;
    script.onload = () => {
      try {
        widget = window.turnstile.render('#challenge', {
          sitekey, action: 'points-lookup', theme: 'light',
          size: matchMedia('(max-width: 380px)').matches ? 'compact' : 'normal',
          callback(token) { challengeToken = token; button.disabled = false; },
          'expired-callback'() { challengeToken = ''; button.disabled = true; },
          'error-callback'() {
            challengeToken = ''; button.disabled = true;
            message('The security check could not load. Please refresh the page or ask your budtender.', true);
          }
        });
        resolve();
      } catch (error) { reject(error); }
    };
    document.head.append(script);
  });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!challengeToken || !form.reportValidity()) return;
  const body = JSON.stringify({ name: name.value.trim(), lastFive: suffix.value,
    turnstileToken: challengeToken });
  challengeToken = '';
  button.disabled = true;
  fields.disabled = true;
  form.setAttribute('aria-busy', 'true');
  message('Checking your balance…');
  controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch('/api/rewards/points', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body, cache: 'no-store', credentials: 'same-origin', mode: 'same-origin',
      redirect: 'error', signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok || typeof data.points !== 'number' || !Number.isFinite(data.points)) {
      const text = response.status === 429
        ? 'Please wait before trying again, or ask your budtender for your balance.'
        : response.status >= 500 ? 'Points lookup is temporarily unavailable. Please ask your budtender.'
          : 'We could not verify those details. Please check them or ask your budtender.';
      message(text, true);
      suffix.value = '';
      return;
    }
    form.reset();
    document.querySelector('#points-value').textContent = new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 2
    }).format(data.points);
    form.hidden = true;
    result.hidden = false;
    message('');
    document.querySelector('#balance-title').focus();
    clearTimer = setTimeout(clearBalance, 120000);
  } catch {
    message('We could not connect right now. Please try again later or ask your budtender.', true);
    suffix.value = '';
  } finally {
    clearTimeout(timeout);
    fields.disabled = false;
    form.removeAttribute('aria-busy');
    if (widget !== undefined) window.turnstile?.reset(widget);
  }
});

document.querySelector('#clear-result').addEventListener('click', () => {
  clearBalance(); name.focus();
});
document.querySelector('#privacy-toggle').addEventListener('click', event => {
  const detail = document.querySelector('#privacy-detail');
  detail.hidden = !detail.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!detail.hidden));
});
// Do not leave balances or patient inputs in a back/forward-cache snapshot.
addEventListener('pagehide', clearBalance);
addEventListener('pageshow', event => { if (event.persisted) clearBalance(); });

try {
  // Preserve the Access login for this site's API; never follow a login redirect.
  const response = await fetch('/api/rewards/config', {
    cache: 'no-store', credentials: 'same-origin', mode: 'same-origin',
    redirect: 'error', signal: AbortSignal.timeout(10000)
  });
  const config = await response.json();
  if (!response.ok || config.enabled !== true || !config.siteKey) throw new Error('Unavailable');
  await loadChallenge(config.siteKey);
  fields.disabled = false;
  message('');
} catch {
  message('Online points lookup is currently unavailable. Your budtender can check your balance, or call us below.');
}
