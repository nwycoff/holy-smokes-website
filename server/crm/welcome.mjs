import { AppError } from '../customer-app/http.mjs';
import { sendPush } from '../customer-app/push.mjs';
import { campaignSenderReady, checkWording, localDay, quietAt, secondsUntilQuiet, TITLE } from './campaigns.mjs';

// Welcome gift for new Deals & news subscribers. When a linked customer has Deals & news on and a
// phone set up, they get one code (once per customer record, ever), sent to their phone and shown
// on My points. Staff give the gift at checkout and note it on the GrowFlow profile. The offer is
// set in the CRM: on/off, what the gift is (shown in the app only), the notification wording
// (on the lock screen, so discreet) and an optional last day.
const DAY = 86400000;
const KEY = 'welcome_gift';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const DEFAULT_MESSAGE = 'Thanks for turning on Deals & news! Your welcome gift code is {code}. Show it at checkout.';
const clean = (text, max) => typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

export async function welcomeConfig(env) {
  const row = await env.CRM_DB.prepare('SELECT value FROM crm_assistant_state WHERE key = ?').bind(KEY).first().catch(() => null);
  const saved = row ? JSON.parse(row.value) : {};
  return { on: false, description: '', message: DEFAULT_MESSAGE, endsOn: null, ...saved };
}
const ended = (config, now) => Boolean(config.endsOn && config.endsOn < localDay(now));

export async function saveWelcomeConfig(env, user, input, now) {
  const allowed = ['on', 'description', 'message', 'endsOn'];
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !allowed.includes(k)) || typeof input.on !== 'boolean')
    throw new AppError('INPUT', 400);
  const description = clean(input.description, 100), message = clean(input.message, 160);
  const endsOn = input.endsOn ? String(input.endsOn) : null;
  if (endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) throw new AppError('INPUT', 400);
  if (input.on && description.length < 3) throw new AppError('WELCOME_DESCRIPTION', 400);
  if (!message.includes('{code}')) throw new AppError('WELCOME_CODE', 400);
  const sample = message.replace('{code}', 'TH-XXXX');
  if (sample.length < 10 || sample.length > 140) throw new AppError('CAMPAIGN_LENGTH', 400);
  checkWording(sample);
  checkWording(description, { lockScreen: false }); // shown inside the app, so it may name the product
  const config = { on: input.on, description, message, endsOn, updatedBy: user, updatedAt: now };
  await env.CRM_DB.prepare(`INSERT INTO crm_assistant_state(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(KEY, JSON.stringify(config), now).run();
  return config;
}
export async function welcomeStats(env) {
  const row = await env.CRM_DB.prepare('SELECT COUNT(*) AS issued, COUNT(sent_at) AS sent FROM crm_welcome_gifts').bind().first().catch(() => null);
  return { issued: row?.issued || 0, sent: row?.sent || 0 };
}

// The customer's own code, for the app (null if they have none or the offer has ended).
export async function welcomeForCustomer(env, customerId, now) {
  if (!env.CRM_DB || !customerId) return null;
  try {
    const gift = await env.CRM_DB.prepare('SELECT code FROM crm_welcome_gifts WHERE customer_id = ?').bind(customerId).first();
    if (!gift) return null;
    const config = await welcomeConfig(env);
    return ended(config, now) ? null : { code: gift.code, description: config.description, endsOn: config.endsOn };
  } catch { return null; }
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `TH-${Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('')}`;
}
// Issues a code once per customer record; overlapping runs and repeat opt-ins get the same row.
async function issue(env, customerId, now) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await env.CRM_DB.prepare(`INSERT INTO crm_welcome_gifts(customer_id, code, created_at) VALUES (?, ?, ?)
      ON CONFLICT(customer_id) DO NOTHING RETURNING code`).bind(customerId, newCode(), now).first().catch(error => {
      if (/UNIQUE/i.test(String(error?.message))) return 'retry';
      throw error;
    });
    if (row !== 'retry') return row?.code || null; // null: this customer already has a code
  }
  return null;
}

// Runs every minute in the notifier (which holds the notification key): issues codes to new
// subscribers and sends each one once, between 9 am and 8 pm Central. A send that reaches no
// phone is retried on later runs for 2 days. These don't count toward the weekly limit.
export async function sendWelcomeGifts(env, deps) {
  if (!campaignSenderReady(env)) return { sent: 0 };
  const now = deps.now(), config = await welcomeConfig(env);
  if (!config.on || ended(config, now) || quietAt(now)) return { sent: 0 };
  const { results: subscribers = [] } = await env.APP_DB.prepare(`SELECT DISTINCT u.customer_id FROM app_marketing_prefs m
    JOIN app_users u ON u.id = m.user_id WHERE u.customer_id IS NOT NULL AND m.topics <> '[]'
    AND EXISTS (SELECT 1 FROM app_push_subscriptions s WHERE s.user_id = u.id)`).bind().run();
  if (!subscribers.length) return { sent: 0 };
  const { results: known = [] } = await env.CRM_DB.prepare(`SELECT customer_id, sent_at, created_at FROM crm_welcome_gifts
    WHERE customer_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(subscribers.map(r => r.customer_id))).run();
  const byId = new Map(known.map(k => [k.customer_id, k]));
  for (const { customer_id: id } of subscribers.slice(0, 50)) if (!byId.has(id)) await issue(env, id, now);
  let sent = 0;
  const { results: due = [] } = await env.CRM_DB.prepare(`SELECT customer_id FROM crm_welcome_gifts WHERE sent_at IS NULL AND created_at > ?
    AND customer_id IN (SELECT value FROM json_each(?)) LIMIT 20`).bind(now - 2 * DAY, JSON.stringify(subscribers.map(r => r.customer_id))).run();
  for (const { customer_id: id } of due) {
    // Claim before sending so two runs can't both send it.
    const claim = await env.CRM_DB.prepare('UPDATE crm_welcome_gifts SET sent_at = ? WHERE customer_id = ? AND sent_at IS NULL RETURNING code')
      .bind(now, id).first();
    if (!claim) continue;
    const { results: devices = [] } = await env.APP_DB.prepare(`SELECT s.endpoint, s.p256dh, s.auth FROM app_users u
      JOIN app_push_subscriptions s ON s.user_id = u.id WHERE u.customer_id = ?`).bind(id).run();
    let reached = false;
    for (const device of devices) {
      const outcome = await sendPush(env, deps, device, { title: TITLE, body: config.message.replace('{code}', claim.code),
        url: '/app/#rewards', tag: 'treehouse-news' }, `welcome${claim.code.replace(/\W/g, '')}`, { ttl: secondsUntilQuiet(now), urgency: 'normal' });
      if (outcome === 'sent') reached = true;
      else if (outcome === 'gone') await env.APP_DB.prepare('DELETE FROM app_push_subscriptions WHERE endpoint = ?').bind(device.endpoint).run();
    }
    if (reached) sent++;
    else await env.CRM_DB.prepare('UPDATE crm_welcome_gifts SET sent_at = NULL WHERE customer_id = ?').bind(id).run();
  }
  return { sent };
}
