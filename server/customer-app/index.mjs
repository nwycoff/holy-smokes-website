import { consumeLimits, lookupVariables, normalizeInput } from '../rewards.mjs';
import { AppError, bodyJSON, enabled, authReady, growflowReady, menuReady, preorderReady, rewardTiersReady, hash, json,
  sameOrigin, cookie, LOGIN_COOKIE, redirect, readCookie, randomToken } from './http.mjs';
import { startLogin, finishLogin, session, renewSession, logout, emailVerificationRequired } from './auth.mjs';
import { CUSTOMER_QUERY, singleCustomer, eligibleCustomer, queryGrowflow, getMenu, getRewards, publicMenu, purchaseLimits } from './growflow.mjs';
import { currentPreorder, placePreorder } from './preorders.mjs';
import { pushReady, subscribe, unsubscribe } from './push.mjs';
import { normalizeEnrollmentCode, withEnrollmentCode } from './enrollment.mjs';
import { licenseMemoryReady, forgetLicense } from './license.mjs';
import { marketingReady, marketingState, setMarketing } from './marketing.mjs';
import { recordTap } from '../crm/campaigns.mjs';
import { dismissWelcome, welcomeForCustomer } from '../crm/welcome.mjs';
import { addFeedbackMessage, feedbackReady, feedbackState, noteGoogle, postponeFeedback, rateVisit } from '../crm/feedback.mjs';
import { acquisitionReady, linkedAcquisition, reachableAcquisition, trackSafely, visit } from './acquisition.mjs';
import { resendVerification, verificationStatus } from './verification.mjs';

async function limit(env, deps, subject, max, window = 900000) {
  if (!await consumeLimits(env.APP_DB, env.APP_LIMIT_SECRET, [{ subject, max, window }], deps.now()))
    throw new AppError('LIMIT', 429);
}
async function cleanup(env, now) {
  const specs = [['app_logins', 'expires_at'], ['app_enrollments', 'expires_at'],
    ['app_sessions', 'expires_at'], ['rewards_limits', 'expires_at'], ['rewards_backoff', 'until_at']];
  await env.APP_DB.batch(specs.map(([table, column]) => env.APP_DB.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).bind(now)));
  // Optional new tables may not exist before their staged migration. Never break login cleanup.
  await env.APP_DB.prepare('DELETE FROM app_signup_visits WHERE created_at < ?').bind(now - 180 * 86400000).run().catch(() => {});
  await env.APP_DB.prepare('DELETE FROM app_email_verifications WHERE expires_at < ?').bind(now).run().catch(() => {});
}
export async function handleApp(context, overrides = {}) {
  const { request, env } = context;
  const deps = { fetch: (url, options) => globalThis.fetch(url, options), now: Date.now,
    report: code => console.warn(`TREEHOUSE_APP_FAILURE ${code}`),
    // Lets slow work (a menu refresh) finish after the response is sent.
    ...(typeof context.waitUntil === 'function' ? { waitUntil: promise => context.waitUntil(promise) } : {}), ...overrides };
  const report = deps.report;
  deps.trackingDenied = request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1';
  deps.report = code => { try { report(code); } catch { /* Logging cannot expose or break a response. */ } };
  const url = new URL(request.url), route = url.pathname.replace(/^\/api\/app\//, '').replace(/\/$/, '');
  const allowed = { config: 'GET', menu: 'GET', rewards: 'GET', session: 'GET', points: 'GET', login: 'POST',
    signup: 'POST', 'signup/visit': 'POST', 'verification/status': 'GET', 'verification/resend': 'POST',
    callback: 'GET', enroll: 'POST', logout: 'POST', 'logout-all': 'POST', 'remove-link': 'POST', 'staff/enroll': 'POST',
    preorder: 'GET', 'preorder/place': 'POST', 'push/subscribe': 'POST', 'push/unsubscribe': 'POST', 'license/forget': 'POST',
    marketing: 'POST', tap: 'POST', 'welcome/dismiss': 'POST',
    'feedback/rate': 'POST', 'feedback/message': 'POST', 'feedback/google': 'POST', 'feedback/later': 'POST' };
  if (!allowed[route]) return json(404, { error: 'Not found.' });
  if (allowed[route] !== request.method) return json(405, { error: 'Method not allowed.' }, { Allow: allowed[route] });
  if (route !== 'callback' && url.search) return json(400, { error: 'Invalid request.' });
  const active = enabled(env, url);
  if (route === 'config') return json(200, { enabled: Boolean(active),
    loginEnabled: Boolean(active && authReady(env)), menuEnabled: Boolean(active && menuReady(env)),
    signupTrackingEnabled: Boolean(active && acquisitionReady(env)),
    preorderEnabled: Boolean(active && preorderReady(env)), rewardTiersEnabled: Boolean(active && rewardTiersReady(env)),
    licenseMemoryEnabled: Boolean(active && preorderReady(env) && licenseMemoryReady(env)),
    marketingEnabled: Boolean(active && marketingReady(env)), emailVerification: emailVerificationRequired(env),
    ...(active && preorderReady(env) && purchaseLimits(env) ? { purchaseLimits: purchaseLimits(env) } : {}),
    ...(active && preorderReady(env) && pushReady(env) ? { pushKey: env.APP_VAPID_PUBLIC_KEY } : {}) });
  if (!active) return json(503, { error: 'The customer app is not available yet. You can still use My Points on our website.' });
  const staff = route === 'staff/enroll';
  if (request.method === 'POST' && !staff && !sameOrigin(request)) return json(403, { error: 'Please reopen the app and try again.' });
  if (!['callback', 'login'].includes(route) && ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site')))
    return json(403, { error: 'Please reopen the app and try again.' });
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return json(503, { error: 'The customer app is temporarily unavailable.' });
  try {
    await limit(env, deps, `requests:${ip}`, 120, 60000);
    if (['login', 'signup', 'callback'].includes(route)) {
      if (!authReady(env)) throw new AppError('AUTH_CONFIG');
      let browserToken;
      if (route !== 'callback') {
        await limit(env, deps, `auth-start-ip:${ip}`, 60);
        await limit(env, deps, 'auth-start-global', 600);
        browserToken = readCookie(request, '__Host-treehouse_auth_browser') || randomToken();
        await limit(env, deps, `auth-browser:${browserToken}`, 8);
      } else await limit(env, deps, `auth-callback-ip:${ip}`, 120);
      const response = route === 'callback' ? await finishLogin(request, env, deps) : await startLogin(request, env, deps, route === 'signup');
      if (browserToken) response.headers.append('Set-Cookie', cookie('__Host-treehouse_auth_browser', browserToken, 86400));
      context.waitUntil?.(cleanup(env, deps.now()).catch(() => deps.report('CLEANUP')));
      return response;
    }
    if (route === 'signup/visit') {
      await limit(env, deps, `signup-visit:${ip}`, 60);
      return visit(request, env, deps, await bodyJSON(request));
    }
    if (route === 'verification/status') return json(200, await verificationStatus(request, env, deps.now()));
    if (route === 'verification/resend') return json(200, await resendVerification(request, env, deps, await bodyJSON(request), ip));
    // A Deals & news notification was tapped. The signed code is all that's needed; no sign-in.
    if (route === 'tap') {
      await limit(env, deps, `tap:${ip}`, 30);
      const input = await bodyJSON(request);
      if (Object.keys(input).some(k => k !== 't')) throw new AppError('INPUT', 400);
      await recordTap(env, input.t, deps.now());
      return json(200, { ok: true });
    }
    if (route === 'rewards') {
      if (!rewardTiersReady(env)) throw new AppError('REWARDS_CONFIG');
      return json(200, await getRewards(env, deps));
    }
    if (route === 'menu') {
      if (!menuReady(env)) throw new AppError('MENU_CONFIG');
      return json(200, publicMenu(await getMenu(env, deps)));
    }
    if (staff) {
      // Owner-only CLI. This credential is never requested or embedded by the customer UI.
      await limit(env, deps, `staff:${ip}`, 10);
      const header = request.headers.get('authorization') || '';
      if (!env.APP_ENROLLMENT_SECRET || env.APP_ENROLLMENT_SECRET.length < 32 || header.length > 512
        || await hash(env.APP_LIMIT_SECRET, header) !== await hash(env.APP_LIMIT_SECRET, `Bearer ${env.APP_ENROLLMENT_SECRET}`))
        throw new AppError('STAFF_AUTH', 401);
      if (!growflowReady(env)) throw new AppError('GROWFLOW_CONFIG');
      const input = await bodyJSON(request);
      if (input.identityChecked !== true || Object.keys(input).some(k => !['name', 'lastFive', 'identityChecked'].includes(k)))
        throw new AppError('INPUT', 400);
      const normalized = normalizeInput({ name: input.name, lastFive: input.lastFive, turnstileToken: 'staff-verified' });
      if (!normalized) throw new AppError('INPUT', 400);
      const data = await queryGrowflow(env, deps, CUSTOMER_QUERY, lookupVariables(normalized, env.GROWFLOW_PATIENT_ID_FIELDS));
      const customer = singleCustomer(data);
      if (!customer) throw new AppError('ENROLLMENT_MATCH', 400);
      const linked = await env.APP_DB.prepare('SELECT id FROM app_users WHERE customer_id = ?').bind(customer.objectId).first();
      if (linked) throw new AppError('ALREADY_LINKED', 409);
      const expiresAt = deps.now() + 600000;
      const { code } = await withEnrollmentCode(env, codeHash => env.APP_DB.prepare(`INSERT INTO app_enrollments(code_hash, customer_id, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(customer_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`)
        .bind(codeHash, customer.objectId, expiresAt).run());
      return json(200, { code, expiresAt });
    }
    const s = await session(request, env, deps);
    // Only the last four characters of a saved license ever leave the server.
    const renewed = route === 'session' && s ? await renewSession(env, s, deps) : null;
    if (route === 'session') return json(200, s ? { signedIn: true, linked: Boolean(s.customer_id), csrf: s.csrf,
      ...(s.license_hint && licenseMemoryReady(env) ? { licenseHint: s.license_hint } : {}),
      ...(s.customer_id && marketingReady(env) ? { marketing: await marketingState(env, deps, s.id) } : {}),
      ...(s.customer_id && marketingReady(env) ? { welcomeGift: await welcomeForCustomer(env, s.customer_id, deps.now()) } : {}),
      ...(s.customer_id && feedbackReady(env) ? { feedback: await feedbackState(env, s.customer_id, deps.now()).catch(() => null) } : {}) }
      : { signedIn: false, linked: false }, renewed ? { 'Set-Cookie': renewed } : {});
    if (!s) throw new AppError('SIGN_IN', 401);
    if (request.method === 'POST' && request.headers.get('x-treehouse-csrf') !== s.csrf) throw new AppError('CSRF', 403);
    if (route === 'logout-all') await env.APP_DB.prepare('DELETE FROM app_push_subscriptions WHERE user_id = ?').bind(s.id).run();
    if (route === 'logout' || route === 'logout-all') return json(200, { signedIn: false },
      { 'Set-Cookie': await logout(env, s, route === 'logout-all') });
    if (route === 'remove-link') {
      if (deps.now() - s.created_at > 900000) throw new AppError('FRESH_LOGIN', 403);
      await env.APP_DB.prepare('DELETE FROM app_users WHERE id = ?').bind(s.id).run();
      return json(200, { signedIn: false }, { 'Set-Cookie': await logout(env, s) });
    }
    if (route === 'enroll') {
      await limit(env, deps, `enroll-ip:${ip}`, 50);
      await limit(env, deps, `enroll-user:${s.id}`, 5);
      await limit(env, deps, `enroll-user-day:${s.id}`, 20, 86400000);
      // Bound distributed guessing across accounts and IPs as well as individual attempts.
      await limit(env, deps, 'enroll-global', 100);
      const input = await bodyJSON(request), code = normalizeEnrollmentCode(input.code);
      if (Object.keys(input).some(k => k !== 'code') || !code) throw new AppError('ENROLLMENT_CODE', 400);
      const key = await hash(env.APP_LIMIT_SECRET, `enroll:${code}`);
      // Claim and consume atomically. A unique customer_id enforces one account per record.
      const results = await env.APP_DB.batch([
        env.APP_DB.prepare(`UPDATE app_users SET customer_id = (SELECT customer_id FROM app_enrollments WHERE code_hash = ? AND expires_at > ?)
          WHERE id = ? AND customer_id IS NULL
          AND EXISTS (SELECT 1 FROM app_enrollments WHERE code_hash = ? AND expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM app_users WHERE customer_id = (SELECT customer_id FROM app_enrollments WHERE code_hash = ?))
          RETURNING id`).bind(key, deps.now(), s.id, key, deps.now(), key),
        env.APP_DB.prepare(`DELETE FROM app_enrollments WHERE code_hash = ?
          AND EXISTS (SELECT 1 FROM app_users WHERE id = ? AND customer_id = app_enrollments.customer_id)`).bind(key, s.id)
      ]);
      if (results[0]?.results?.length !== 1) throw new AppError('ENROLLMENT_CODE', 400);
      await trackSafely(env, deps, () => linkedAcquisition(env, s.id, deps.now()));
      return json(200, { linked: true });
    }
    if (route === 'points') {
      if (!s.customer_id) throw new AppError('LINK_REQUIRED', 403);
      if (!growflowReady(env)) throw new AppError('GROWFLOW_CONFIG');
      await limit(env, deps, `points:${s.id}`, 10, 60000);
      const data = await queryGrowflow(env, deps, CUSTOMER_QUERY,
        { where: eligibleCustomer({ objectId: { equalTo: s.customer_id } }) });
      const customer = singleCustomer(data);
      if (!customer || customer.objectId !== s.customer_id || !Number.isFinite(customer.CurrentPoints)) throw new AppError('POINTS_UNAVAILABLE');
      return json(200, { points: customer.CurrentPoints, checkedAt: deps.now() });
    }
    if (route === 'license/forget') { await forgetLicense(env, s.id); return json(200, { licenseHint: null }); }
    if (route.startsWith('feedback/')) {
      if (!s.customer_id) throw new AppError('LINK_REQUIRED', 403);
      if (!feedbackReady(env)) throw new AppError('FEEDBACK_CONFIG');
      await limit(env, deps, `feedback:${s.id}`, 20);
      const input = await bodyJSON(request), now = deps.now();
      if (route === 'feedback/rate') return json(200, await rateVisit(env, s.customer_id, input, now));
      if (route === 'feedback/message') { await addFeedbackMessage(env, s.customer_id, input, now); return json(200, { saved: true }); }
      if (route === 'feedback/google') return json(200, await noteGoogle(env, s.customer_id, input, now));
      await postponeFeedback(env, s.customer_id, input, now); return json(200, { saved: true });
    }
    if (route === 'welcome/dismiss') {
      if (!s.customer_id) throw new AppError('LINK_REQUIRED', 403);
      await limit(env, deps, `welcome:${s.id}`, 10);
      await dismissWelcome(env, s.customer_id, deps.now());
      return json(200, { welcomeGift: null });
    }
    if (route === 'marketing') {
      if (!s.customer_id) throw new AppError('LINK_REQUIRED', 403);
      if (!marketingReady(env)) throw new AppError('MARKETING_CONFIG');
      await limit(env, deps, `marketing:${s.id}`, 30);
      const marketing = await setMarketing(env, deps, s, await bodyJSON(request));
      await trackSafely(env, deps, () => reachableAcquisition(env, s.id, deps.now()));
      return json(200, { marketing });
    }
    if (route === 'push/subscribe' || route === 'push/unsubscribe') {
      if (route === 'push/unsubscribe') { await unsubscribe(env, s, await bodyJSON(request)); return json(200, { subscribed: false }); }
      if (!s.customer_id) throw new AppError('LINK_REQUIRED', 403);
      if (!preorderReady(env) || !pushReady(env)) throw new AppError('PUSH_CONFIG');
      await limit(env, deps, `push:${s.id}`, 10);
      await subscribe(env, deps, s, await bodyJSON(request));
      await trackSafely(env, deps, () => reachableAcquisition(env, s.id, deps.now()));
      return json(200, { subscribed: true });
    }
    if (route === 'preorder' || route === 'preorder/place') {
      if (!s.customer_id) throw new AppError('LINK_REQUIRED', 403);
      if (!preorderReady(env)) throw new AppError('PREORDER_CONFIG');
      if (route === 'preorder') {
        await limit(env, deps, `preorder-status:${s.id}`, 10, 60000);
        return json(200, { order: await currentPreorder(env, deps, s) });
      }
      // Only attempts that pass validation and would reach GrowFlow count toward these limits.
      return json(200, { order: await placePreorder(env, deps, s, await bodyJSON(request), async () => {
        await limit(env, deps, `preorder-ip:${ip}`, 10, 3600000);
        await limit(env, deps, `preorder-user:${s.id}`, 5, 3600000);
      }) });
    }
  } catch (error) {
    // Never log provider error strings, request bodies, auth codes, IDs or balances.
    const known = error instanceof AppError, code = known ? error.code : 'INTERNAL';
    deps.report(code);
    if (route === 'callback') return redirect(code === 'VERIFY_EMAIL' ? '/app/#verify-email' : '/app/#login-error', [cookie(LOGIN_COOKIE, '', 0)]);
    const messages = { SIGN_IN: 'Please sign in to continue.', LIMIT: 'Please wait a few minutes before trying again.',
      VERIFY_AGAIN: 'Sign in again to request another verification email.',
      VERIFY_LIMIT: 'Please wait before asking again. You can request up to three verification emails a day.',
      VERIFY_PROVIDER: 'We couldn’t request the email. Please try later or ask the shop for help.',
      GROWFLOW_LIMIT: 'Please wait a minute before refreshing.', LINK_REQUIRED: 'Link your customer record with a code from your budtender.',
      ENROLLMENT_CODE: 'That code could not be used. Check it or ask your budtender for a new one.',
      ENROLLMENT_MATCH: 'No unique eligible customer matched. Check the record in GrowFlow.',
      ALREADY_LINKED: 'That customer is already linked. Use account recovery instead of issuing another code.',
      FRESH_LOGIN: 'Please sign out and sign in again before removing your connection.', INPUT: 'Please check the information and try again.',
      TOO_MANY_ITEMS: 'Pickup orders can have up to 10 items.',
      OPEN_ORDER: 'You already have an order in progress. You can place another once it’s picked up or canceled.',
      MENU_STALE: 'The menu is updating. Please try again in a minute.',
      ITEM_UNAVAILABLE: 'Something in your order is no longer available. Please review your order.',
      PRICE_CHANGED: 'A price in your order has changed. Please review your order.',
      PREORDER_PROFILE: 'We can’t place app orders for your record yet. Please call the shop or ask your budtender.',
      PREORDER_REJECTED: 'The shop couldn’t accept this order. Please call the shop.',
      PREORDERS_OFF: 'Ordering ahead isn’t available right now. Please try again later or call the shop.',
      REWARD_UNAVAILABLE: 'That reward isn’t available right now. Please choose another or order without it.',
      REWARD_POINTS: 'You don’t have enough points for that reward right now. Please choose another.',
      REWARD_TOO_LARGE: 'That reward is bigger than your order. Please choose a smaller one or add more items.',
      LICENSE_SAVED_MISSING: 'Please enter your medical license number.',
      LICENSE_SAVED_MISMATCH: 'Your saved license number no longer matches your store record. This usually means you have a new or renewed license. We’ve removed the old number; please enter the one on your current card. If it still doesn’t match, ask your budtender to update your store record.',
      FEEDBACK_VISIT: 'That visit can’t be rated anymore. Thanks for checking in!', FEEDBACK_DONE: 'Thanks, we already have your rating for that visit.',
      PUSH_DEVICE_IN_USE: 'This device is set up for notifications on another account. Please try again.',
      OUT_OF_STOCK: 'Some items in your order have fewer in stock than you asked for. We’ve updated your order; please review it.',
      LICENSE_REQUIRED: 'Please enter your medical license number to order ahead.',
      LICENSE_FORMAT: 'Please check your medical license number. Use letters, numbers and dashes only.',
      LICENSE_EXPIRY_MISSING: 'Your store record is missing your license expiration date. Please ask your budtender to update it.',
      LICENSE_EXPIRED: 'The medical license on your store record has expired. Please ask your budtender to update it.',
      LICENSE_MISMATCH: 'That license number doesn’t match your store record. Check it against your current card. If you’ve recently gotten a new or renewed license, your budtender needs to update your store record before you can order ahead.',
      PREORDER_UNCONFIRMED: 'We couldn’t confirm your order. Please call the shop before ordering again.' };
    const limit = code.startsWith('PURCHASE_LIMIT_') && purchaseLimits(env)?.[code.slice(15).toLowerCase()];
    if (limit) messages[code] = `Your order is over the store’s ${limit.max} ${limit.unit === 'each' ? '' : `${limit.unit} `}${limit.label} limit per order. Please remove some ${limit.label} items.`.replace('  ', ' ');
    return json(known ? error.status : 503, { error: messages[code] || 'This is temporarily unavailable. Please try again later or ask your budtender.' },
      known && error.status === 429 ? { 'Retry-After': '900' } : {});
  }
}
