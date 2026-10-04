import { AppError, randomToken } from '../customer-app/http.mjs';
import { sendPush } from '../customer-app/push.mjs';
import { campaignSenderReady, localDay, localHour, secondsUntilQuiet, TITLE } from './campaigns.mjs';

// Visit ratings. App users are asked sparingly how a visit went: a card in the app at most once
// every 60 days (after any completed GrowFlow order, in store or ahead), and one notification
// ever, the day after their first order-ahead pickup. Everyone who rates is invited to review the
// shop on Google whatever their rating (asking only happy customers is against Google's rules).
// 1-3 stars also offers a message to a manager and alerts the people who turned on low-rating
// alerts. Ratings, messages and follow-ups live in the CRM.
const DAY = 86400000;
export const ASK_EVERY = 60 * DAY, CARD_DAYS = 7, RATE_WINDOW = 30 * DAY, GOOGLE_PAUSE = 180 * DAY, PUSH_HOURS = [11, 17];

export const feedbackReady = env => env.FEEDBACK_ENABLED === 'true' && Boolean(env.CRM_DB);
export function reviewUrl(env) {
  const url = String(env.FEEDBACK_REVIEW_URL || '');
  return /^https:\/\/(g\.page|search\.google\.com|www\.google\.com|maps\.app\.goo\.gl)\/\S{1,200}$/.test(url) ? url : null;
}
const prefsOf = (env, customerId) => env.CRM_DB.prepare('SELECT * FROM crm_feedback_prefs WHERE customer_id = ?').bind(customerId).first();
// The customer's most recent completed visit in the last 30 days, and whether it's been rated.
async function latestVisit(env, customerId, now) {
  return env.CRM_DB.prepare(`SELECT o.id, o.completed_at, EXISTS (SELECT 1 FROM crm_feedback f WHERE f.customer_id = o.customer_id
    AND f.order_id = o.id) AS rated FROM crm_orders o WHERE o.customer_id = ? AND o.completed_at >= ? ORDER BY o.completed_at DESC LIMIT 1`)
    .bind(customerId, now - RATE_WINDOW).first();
}

// What the app shows: `visit` (a recent visit they can rate any time from My points) and `ask`
// (whether to show the card on Home now). Showing the card for a new visit starts its 60 days.
export async function feedbackState(env, customerId, now) {
  const [visit, prefs] = await Promise.all([latestVisit(env, customerId, now), prefsOf(env, customerId)]);
  if (!visit || visit.rated) return { visit: null, ask: false };
  const p = prefs || {};
  const ask = visit.completed_at >= now - CARD_DAYS * DAY && !p.opted_out && !(p.snooze_until > now)
    && (p.asked_order_id === visit.id || !p.asked_at || p.asked_at < now - ASK_EVERY);
  if (ask && p.asked_order_id !== visit.id)
    await env.CRM_DB.prepare(`INSERT INTO crm_feedback_prefs(customer_id, asked_order_id, asked_at) VALUES (?, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET asked_order_id = excluded.asked_order_id, asked_at = excluded.asked_at`)
      .bind(customerId, visit.id, now).run();
  return { visit: { id: visit.id, at: visit.completed_at }, ask };
}

// A rating for the customer's own latest visit. 1-3 stars alerts the people who asked for it.
export async function rateVisit(env, customerId, input, now) {
  const rating = input?.rating;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || typeof input.orderId !== 'string') throw new AppError('INPUT', 400);
  const visit = await latestVisit(env, customerId, now);
  if (!visit || visit.id !== input.orderId) throw new AppError('FEEDBACK_VISIT', 409);
  if (visit.rated) throw new AppError('FEEDBACK_DONE', 409);
  const id = randomToken(), prefs = await prefsOf(env, customerId);
  const statements = [env.CRM_DB.prepare(`INSERT INTO crm_feedback(id, customer_id, order_id, visit_at, rating, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, customerId, visit.id, visit.completed_at, rating, now),
    env.CRM_DB.prepare(`INSERT INTO crm_feedback_prefs(customer_id, asked_order_id, asked_at) VALUES (?, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET asked_order_id = excluded.asked_order_id, asked_at = excluded.asked_at`).bind(customerId, visit.id, now)];
  if (rating <= 3) statements.push(env.CRM_DB.prepare(`INSERT INTO crm_owner_alerts(id, body, created_at, audience) VALUES (?, ?, ?, 'feedback')`)
    .bind(randomToken(), `New ${rating}-star visit rating. Open the CRM to see it and follow up.`, now));
  await env.CRM_DB.batch(statements);
  return { id, low: rating <= 3, google: reviewUrl(env) && !(prefs?.google_until > now) ? reviewUrl(env) : null };
}
// An optional message (and "please contact me") added right after rating.
export async function addFeedbackMessage(env, customerId, input, now) {
  const comment = typeof input?.comment === 'string' ? input.comment.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, 1000) : '';
  if (typeof input?.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id) || typeof input.contact !== 'boolean' || (!comment && !input.contact))
    throw new AppError('INPUT', 400);
  const row = await env.CRM_DB.prepare(`UPDATE crm_feedback SET comment = ?, contact = ? WHERE id = ? AND customer_id = ? AND created_at > ?
    RETURNING id`).bind(comment || null, input.contact ? 1 : 0, input.id, customerId, now - DAY).first();
  if (!row) throw new AppError('FEEDBACK_DONE', 409);
}
// They went on to the Google review link: note it and stop suggesting Google for 6 months.
export async function noteGoogle(env, customerId, input, now) {
  const statements = [env.CRM_DB.prepare(`INSERT INTO crm_feedback_prefs(customer_id, google_until) VALUES (?, ?)
    ON CONFLICT(customer_id) DO UPDATE SET google_until = excluded.google_until`).bind(customerId, now + GOOGLE_PAUSE)];
  if (typeof input?.id === 'string' && /^[a-f0-9]{64}$/.test(input.id))
    statements.push(env.CRM_DB.prepare('UPDATE crm_feedback SET google_at = COALESCE(google_at, ?) WHERE id = ? AND customer_id = ?').bind(now, input.id, customerId));
  await env.CRM_DB.batch(statements);
  return { url: reviewUrl(env) };
}
// "Not now" (60 days) or "Don't ask me again".
export async function postponeFeedback(env, customerId, input, now) {
  if (!['later', 'never'].includes(input?.mode)) throw new AppError('INPUT', 400);
  await env.CRM_DB.prepare(`INSERT INTO crm_feedback_prefs(customer_id, snooze_until, opted_out) VALUES (?, ?, ?)
    ON CONFLICT(customer_id) DO UPDATE SET snooze_until = excluded.snooze_until, opted_out = MAX(crm_feedback_prefs.opted_out, excluded.opted_out)`)
    .bind(customerId, now + ASK_EVERY, input.mode === 'never' ? 1 : 0).run();
}

// --- CRM ---

export async function feedbackSummary(env, now) {
  const row = await env.CRM_DB.prepare(`SELECT
    (SELECT COUNT(*) FROM crm_feedback WHERE created_at >= ?) AS count30, (SELECT AVG(rating) FROM crm_feedback WHERE created_at >= ?) AS avg30,
    (SELECT COUNT(*) FROM crm_feedback WHERE created_at >= ?) AS count90, (SELECT AVG(rating) FROM crm_feedback WHERE created_at >= ?) AS avg90,
    (SELECT COUNT(*) FROM crm_feedback WHERE created_at >= ? AND rating <= 3) AS low90,
    (SELECT COUNT(*) FROM crm_feedback WHERE created_at >= ? AND google_at IS NOT NULL) AS google90,
    (SELECT COUNT(*) FROM crm_feedback WHERE status = 'new' AND (rating <= 3 OR contact = 1)) AS waiting`)
    .bind(now - 30 * DAY, now - 30 * DAY, now - 90 * DAY, now - 90 * DAY, now - 90 * DAY, now - 90 * DAY).first();
  const round = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
  return { ...row, avg30: round(row?.avg30), avg90: round(row?.avg90) };
}
export async function feedbackList(env, limit = 60) {
  const { results = [] } = await env.CRM_DB.prepare(`SELECT id, customer_id, visit_at, rating, comment, contact, google_at, status, handled_by,
    handled_at, handled_note, created_at FROM crm_feedback ORDER BY created_at DESC LIMIT ?`).bind(limit).run();
  return results;
}
export async function handleFeedback(env, user, input, now) {
  const note = typeof input?.note === 'string' ? input.note.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  if (typeof input?.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw new AppError('INPUT', 400);
  const row = await env.CRM_DB.prepare(`UPDATE crm_feedback SET status = 'handled', handled_by = ?, handled_at = ?, handled_note = ? WHERE id = ?
    RETURNING id`).bind(user, now, note || null, input.id).first();
  if (!row) throw new AppError('INPUT', 400);
}

// --- Notifier: one notification, the day after a customer's first order-ahead pickup ---

export async function sendRatingRequests(env, deps) {
  if (!campaignSenderReady(env) || env.FEEDBACK_ENABLED !== 'true') return { sent: 0 };
  const now = deps.now(), hour = localHour(now);
  if (hour < PUSH_HOURS[0] || hour >= PUSH_HOURS[1]) return { sent: 0 };
  const yesterday = localDay(now - DAY);
  const { results: firsts = [] } = await env.CRM_DB.prepare(`SELECT o.customer_id, o.id, o.completed_at FROM crm_orders o
    WHERE o.is_preorder = 1 AND o.completed_at BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM crm_orders e WHERE e.customer_id = o.customer_id AND e.is_preorder = 1 AND e.completed_at < o.completed_at)
    AND NOT EXISTS (SELECT 1 FROM crm_feedback f WHERE f.customer_id = o.customer_id AND f.order_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM crm_feedback_prefs p WHERE p.customer_id = o.customer_id AND (p.first_push_at IS NOT NULL OR p.opted_out = 1))
    LIMIT 20`).bind(now - 2 * DAY, now).run();
  let sent = 0;
  for (const visit of firsts.filter(v => localDay(v.completed_at) === yesterday)) {
    // Claim it so overlapping runs don't both send; this also starts the 60-day pause.
    const claim = await env.CRM_DB.prepare(`INSERT INTO crm_feedback_prefs(customer_id, first_push_at, asked_order_id, asked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET first_push_at = excluded.first_push_at, asked_order_id = excluded.asked_order_id, asked_at = excluded.asked_at
      WHERE crm_feedback_prefs.first_push_at IS NULL AND crm_feedback_prefs.opted_out = 0 RETURNING customer_id`)
      .bind(visit.customer_id, now, visit.id, now).first();
    if (!claim) continue;
    const { results: devices = [] } = await env.APP_DB.prepare(`SELECT s.endpoint, s.p256dh, s.auth FROM app_users u
      JOIN app_push_subscriptions s ON s.user_id = u.id WHERE u.customer_id = ?`).bind(visit.customer_id).run();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`rate:${visit.id}`)));
    const topic = Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
    for (const device of devices) {
      const outcome = await sendPush(env, deps, device, { title: TITLE, body: 'How was your visit yesterday? Tap to rate it.', url: '/app/#rate',
        tag: 'treehouse-order' }, topic, { ttl: secondsUntilQuiet(now), urgency: 'normal' });
      if (outcome === 'sent') sent++;
      else if (outcome === 'gone') await env.APP_DB.prepare('DELETE FROM app_push_subscriptions WHERE endpoint = ?').bind(device.endpoint).run();
    }
  }
  return { sent };
}
