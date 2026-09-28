import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/rewards.js', import.meta.url), 'utf8');
const origin = 'https://points.example.test';

async function loadPage({ sessionValid = true, expiresBeforeSubmit = false } = {}) {
  const elements = new Map();
  const requests = [];
  let challenge;
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', hidden: selector === '#points-result',
      disabled: ['#lookup-fields', '#lookup-button'].includes(selector),
      handlers: new Map(), classList: { toggle() {} },
      addEventListener(type, callback) { this.handlers.set(type, callback); },
      setAttribute() {}, removeAttribute() {}, focus() {}, reportValidity() { return true; },
      reset() { element('#patient-name').value = ''; element('#patient-suffix').value = ''; }
    });
    return elements.get(selector);
  }
  // Model an Access gate: absent/expired session cookies return a login page.
  // Only synthetic identities and points are used; no network requests are made.
  const fetch = async (input, init) => {
    const request = new Request(new URL(input, origin), init);
    requests.push(request);
    const sendsCookie = request.credentials === 'include'
      || (request.credentials === 'same-origin' && new URL(request.url).origin === origin);
    if (!sessionValid || !sendsCookie
      || (expiresBeforeSubmit && request.method === 'POST')) {
      return new Response('<html>Sign in</html>', { status: 401 });
    }
    if (request.url === `${origin}/api/rewards/config`) {
      return Response.json({ enabled: true, siteKey: 'synthetic-public-sitekey' });
    }
    assert.equal(request.url, `${origin}/api/rewards/points`);
    assert.equal(request.method, 'POST');
    assert.deepEqual(await request.json(), {
      name: 'Synthetic Patient', lastFive: 'ABC-12', turnstileToken: 'synthetic-proof'
    });
    return Response.json({ points: 123 });
  };
  await vm.runInNewContext(`(async () => { ${source}\n })()`, {
    document: {
      querySelector: element,
      createElement: () => ({}),
      head: { append(script) { queueMicrotask(() => script.onload()); } }
    },
    window: { turnstile: {
      render(selector, options) { challenge = options; return 1; }, reset() {}
    } },
    fetch, AbortController, AbortSignal, Intl,
    matchMedia: () => ({ matches: false }),
    setTimeout: () => 1, clearTimeout() {}, addEventListener() {}
  });
  async function submit() {
    element('#patient-name').value = 'Synthetic Patient';
    element('#patient-suffix').value = 'ABC-12';
    challenge.callback('synthetic-proof');
    await element('#points-form').handlers.get('submit')({ preventDefault() {} });
  }
  return { element, requests, submit };
}

test('signed-in Access session reaches config and points; inputs clear after success', async () => {
  const page = await loadPage();
  assert.equal(page.element('#lookup-fields').disabled, false);
  await page.submit();
  assert.equal(page.element('#points-result').hidden, false);
  assert.equal(page.element('#points-value').textContent, '123');
  assert.equal(page.element('#patient-name').value, '');
  assert.equal(page.element('#patient-suffix').value, '');
  assert.equal(page.requests.length, 2);
  for (const request of page.requests) {
    assert.equal(request.credentials, 'same-origin');
    assert.equal(request.mode, 'same-origin');
    assert.equal(request.redirect, 'error');
    assert.equal(request.cache, 'no-store');
  }
});

test('missing or expired Access session never displays a balance or retries', async () => {
  const signedOut = await loadPage({ sessionValid: false });
  assert.equal(signedOut.element('#lookup-fields').disabled, true);
  assert.equal(signedOut.element('#points-result').hidden, true);
  assert.equal(signedOut.requests.length, 1);
  const expired = await loadPage({ expiresBeforeSubmit: true });
  await expired.submit();
  assert.equal(expired.element('#points-result').hidden, true);
  assert.equal(expired.element('#points-value').textContent, '');
  assert.equal(expired.element('#patient-suffix').value, '');
  assert.equal(expired.requests.length, 2);
});
