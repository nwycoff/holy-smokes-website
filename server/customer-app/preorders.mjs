import { AppError, randomToken } from './http.mjs';
import { rewardTiersReady } from './http.mjs';
import { licenseMemoryReady, openLicense, saveLicense, forgetLicense } from './license.mjs';
import { CREATE_PREORDER, PREORDER_CUSTOMER_QUERY, PREORDER_STATUS, eligibleCustomer, verifyPreorderInventory, getMenu, getRewards, purchaseLimits,
  queryGrowflow, singleCustomer } from './growflow.mjs';

// Pickup only, paid in store. The server rebuilds every line and the total from the
// shared menu; the browser only chooses products, sizes and quantities.
export const MAX_ITEMS = 10;
// GrowFlow flow: New → Unfulfilled → Fulfilled (packed, awaiting checkout) → Completed.
// Only checkout or cancellation finishes an order.
const CLOSED = ['Completed', 'Canceled'];
const UNCONFIRMED_HOLD = 1800000;
const STATUS_REFRESH = 30000;
const isOpen = status => !CLOSED.includes(status);

function summary(row) {
  return row ? { orderNumber: row.order_number, status: row.status, open: row.open === 1,
    totalCents: row.total_cents, itemCount: row.item_count, createdAt: row.created_at,
    ...(row.reward_name ? { rewardName: row.reward_name } : {}) } : null;
}

export async function currentPreorder(env, deps, s) {
  const row = await env.APP_DB.prepare(`SELECT * FROM app_preorders WHERE user_id = ?
    ORDER BY open DESC, created_at DESC LIMIT 1`).bind(s.id).first();
  if (!row?.open) return summary(row);
  const now = deps.now();
  if (!row.order_id) {
    // A submission that could not be confirmed blocks new orders for a while so a
    // timed-out request cannot quietly become two orders. Staff can check GrowFlow.
    if (now - row.created_at <= UNCONFIRMED_HOLD) return summary(row);
    await env.APP_DB.prepare('UPDATE app_preorders SET open = 0, checked_at = ? WHERE id = ?').bind(now, row.id).run();
    return summary({ ...row, open: 0 });
  }
  return summary(await refreshStatus(env, deps, row));
}

// Shared by the app and the order-ready notifier. Returns the row with its latest known
// status; on any failure the last known status stands and the order is unaffected.
export async function refreshStatus(env, deps, row) {
  const now = deps.now();
  if (now - row.checked_at < STATUS_REFRESH) return row;
  try {
    const data = await queryGrowflow(env, deps, PREORDER_STATUS, { orderId: row.order_id }, env.APP_PREORDER_TOKEN);
    const order = data?.preorderStatus?.order;
    if (order?.id !== row.order_id || typeof order.status !== 'string') throw new AppError('PREORDER_STATUS_SHAPE');
    const status = order.status.slice(0, 40), open = isOpen(status) ? 1 : 0;
    await env.APP_DB.prepare('UPDATE app_preorders SET status = ?, open = ?, checked_at = ? WHERE id = ?')
      .bind(status, open, now, row.id).run();
    return { ...row, status, open, checked_at: now };
  } catch (error) {
    deps.report(error instanceof AppError ? error.code : 'PREORDER_STATUS');
    return row;
  }
}

function readItems(input) {
  if (Object.keys(input).some(k => !['items', 'note', 'license', 'reward', 'rememberLicense', 'useSavedLicense'].includes(k))
    || !Array.isArray(input.items)
    || !input.items.length || input.items.length > MAX_ITEMS) throw new AppError('INPUT', 400);
  const seen = new Set();
  const items = input.items.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(k => !['productId', 'size', 'priceCents', 'qty'].includes(k))
      || typeof item.productId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.productId)
      || typeof item.size !== 'string' || !item.size || item.size.length > 40
      || !Number.isSafeInteger(item.priceCents) || !Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > MAX_ITEMS)
      throw new AppError('INPUT', 400);
    const key = `${item.productId}\u0000${item.size}`;
    if (seen.has(key)) throw new AppError('INPUT', 400);
    seen.add(key);
    return item;
  });
  if (items.reduce((n, item) => n + item.qty, 0) > MAX_ITEMS) throw new AppError('TOO_MANY_ITEMS', 400);
  if (input.note !== undefined && typeof input.note !== 'string') throw new AppError('INPUT', 400);
  const note = (input.note || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (note.length > 200) throw new AppError('INPUT', 400);
  if (input.license !== undefined && typeof input.license !== 'string') throw new AppError('INPUT', 400);
  const license = (input.license || '').replace(/\s+/g, '').toUpperCase();
  if (license && !/^[A-Z0-9](?:-?[A-Z0-9]){4,39}$/.test(license)) throw new AppError('LICENSE_FORMAT', 400);
  if (input.reward !== undefined && (typeof input.reward !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.reward)))
    throw new AppError('INPUT', 400);
  for (const flag of ['rememberLicense', 'useSavedLicense'])
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw new AppError('INPUT', 400);
  if (license && input.useSavedLicense) throw new AppError('INPUT', 400);
  return { items, note, license, reward: input.reward, remember: input.rememberLicense === true, useSaved: input.useSavedLicense === true };
}

// Same field allowlist as the points checker. License numbers can be matched in a
// GrowFlow filter but not read, so the customer supplies theirs and GrowFlow confirms it.
const LICENSE_FIELDS = new Set(['PatientLicenseNumber', 'MedicalLicenseNumber', 'CustomerStateLicense']);
function licenseFilter(env, license) {
  const fields = String(env.GROWFLOW_PATIENT_ID_FIELDS || '').split(',').map(field => field.trim());
  if (!fields[0] || fields.some(field => !LICENSE_FIELDS.has(field)) || new Set(fields).size !== fields.length)
    throw new AppError('PREORDER_CONFIG');
  const pattern = `^${license.replaceAll('-', '').split('').join('-?')}$`;
  return { OR: fields.map(field => ({ [field]: { matchesRegex: pattern, options: 'i' } })) };
}

const dateValue = value => new Date(typeof value === 'string' ? value : typeof value?.iso === 'string' ? value.iso : '');
function birthDate(value, now) {
  const text = typeof value === 'string' ? value : typeof value?.iso === 'string' ? value.iso : '';
  const date = dateValue(value);
  return text && Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1900 && date.getTime() < now
    ? date.toISOString() : null;
}

// GrowFlow requires the customer's name, birth date and type on every preorder. They are
// read from the linked record at order time and never stored by the app.
// GrowFlow requires a medical license number for medical customers; it is sent, never stored.
async function preorderCustomer(env, deps, customerId, license) {
  const data = await queryGrowflow(env, deps, PREORDER_CUSTOMER_QUERY, { where: eligibleCustomer({
    objectId: { equalTo: customerId }, ...(license ? licenseFilter(env, license) : {}) }) });
  const customer = singleCustomer(data);
  if (license && !customer) throw new AppError('LICENSE_MISMATCH', 400);
  const names = typeof customer?.Name === 'string' ? customer.Name.trim().split(/\s+/).filter(Boolean) : [];
  const type = { medical: 'Medical', recreational: 'Recreational' }[String(customer?.CustomerType || '').trim().toLowerCase()];
  const dob = birthDate(customer?.Birthday, deps.now());
  if (!customer || customer.objectId !== customerId || names.length < 2 || !type || !dob)
    throw new AppError('PREORDER_PROFILE', 409);
  if (type === 'Medical' && !license) throw new AppError('LICENSE_REQUIRED', 400);
  // GrowFlow also requires the license expiry with a license number, as a DateTime (midnight UTC
  // of the expiry date; a bare YYYY-MM-DD fails GraphQL validation). A record can hold two dates
  // (state license expiration and license end date), and after a renewal one of them may still
  // carry the old card's date, so the later of the two is used, as GrowFlow does. The POS still
  // checks the card at checkout.
  let medicalLicenseExpires;
  if (license) {
    const expires = [customer.CustomerStateLicenseExpiration, customer.LicenseEffectiveEndDate]
      .map(dateValue).filter(date => Number.isFinite(date.getTime())).sort((a, b) => b - a)[0];
    if (!expires) throw new AppError('LICENSE_EXPIRY_MISSING', 409);
    const day = expires.toISOString().slice(0, 10);
    if (day < new Date(deps.now()).toISOString().slice(0, 10)) throw new AppError('LICENSE_EXPIRED', 409);
    medicalLicenseExpires = `${day}T00:00:00.000Z`;
  }
  return { customer: { id: customer.objectId, type, firstName: names.slice(0, -1).join(' '), lastName: names.at(-1), dob,
    ...(license ? { medicalLicenseNumber: license, medicalLicenseExpires } : {}) },
    points: Number.isFinite(customer.CurrentPoints) ? customer.CurrentPoints : null };
}

export async function placePreorder(env, deps, s, input, limit) {
  const { items, note, license: typed, reward, remember, useSaved } = readItems(input);
  if ((await currentPreorder(env, deps, s))?.open) throw new AppError('OPEN_ORDER', 409);
  const menu = await getMenu(env, deps);
  if (menu.stale) throw new AppError('MENU_STALE');
  // Every size of a product draws on the same sellable stock (e.g. 2 × 3.5 g + 1 × 7 g = 14 g).
  const drawn = new Map();
  const lines = items.map(item => {
    const product = menu.products.find(p => p.id === item.productId);
    const variant = product?.variants.find(v => v.size === item.size);
    if (!variant) throw new AppError('ITEM_UNAVAILABLE', 409);
    if (variant.priceCents !== item.priceCents) throw new AppError('PRICE_CHANGED', 409);
    const units = (drawn.get(product.id) || 0) + item.qty * (variant.unitsEach || 1);
    if (units > product.stockUnits + 1e-9) throw new AppError('OUT_OF_STOCK', 409);
    drawn.set(product.id, units);
    return { productId: item.productId, qty: item.qty, ...(variant.weight ? { weight: variant.weight } : {}),
      cents: variant.priceCents * item.qty };
  });
  // Store purchase limits, per order. Items of unknown weight are left to the POS.
  const limits = purchaseLimits(env);
  if (limits) {
    const used = {};
    for (const item of items) {
      const product = menu.products.find(p => p.id === item.productId);
      const use = product.variants.find(v => v.size === item.size).limitUse;
      if (product.limitGroup && Number.isFinite(use)) used[product.limitGroup] = (used[product.limitGroup] || 0) + use * item.qty;
    }
    for (const [group, total] of Object.entries(used))
      if (total > limits[group].max + 1e-6) throw new AppError(`PURCHASE_LIMIT_${group.toUpperCase()}`, 409);
  }
  const totalCents = lines.reduce((sum, line) => sum + line.cents, 0);
  const itemCount = items.reduce((n, item) => n + item.qty, 0);
  // Everything above is checked locally. Only attempts that go on to GrowFlow count toward
  // the per-account and per-IP limits, so a delayed menu or a full cart costs nothing.
  await limit();
  // A saved license is decrypted only here, and GrowFlow re-checks it on every order.
  let license = typed;
  if (useSaved) {
    license = licenseMemoryReady(env) ? await openLicense(env, s.id, s.license_enc) : null;
    if (!license) { await forgetLicense(env, s.id); throw new AppError('LICENSE_SAVED_MISSING', 400); }
  }
  let verified;
  try { verified = await preorderCustomer(env, deps, s.customer_id, license); }
  catch (error) {
    if (useSaved && error.code === 'LICENSE_MISMATCH') { await forgetLicense(env, s.id); throw new AppError('LICENSE_SAVED_MISMATCH', 400); }
    throw error;
  }
  const { customer, points } = verified;
  // Save only a number GrowFlow just confirmed, and only when the customer asked. Typing one
  // without ticking "remember" replaces any saved copy with nothing.
  let licenseHint = useSaved ? s.license_hint : null;
  if (typed && licenseMemoryReady(env)) {
    if (remember) licenseHint = await saveLicense(env, s.id, typed);
    else if (s.license_enc) await forgetLicense(env, s.id);
  }
  // A chosen loyalty reward is written into the order note for staff to apply at checkout.
  // GrowFlow preorders have no discount field; the total sent stays the full price.
  let rewardLine = '', rewardName = null;
  if (reward) {
    if (!rewardTiersReady(env)) throw new AppError('REWARD_UNAVAILABLE', 409);
    const tier = (await getRewards(env, deps)).tiers.find(t => t.id === reward);
    if (!tier) throw new AppError('REWARD_UNAVAILABLE', 409);
    if (points === null || points < tier.points) throw new AppError('REWARD_POINTS', 409);
    if (tier.amountCents !== null && tier.amountCents > totalCents) throw new AppError('REWARD_TOO_LARGE', 409);
    rewardName = tier.name;
    rewardLine = `REWARD REQUESTED: ${tier.name} (${Math.floor(points)} points at order time). Apply at checkout.`;
  }
  const fullNote = [rewardLine, note].filter(Boolean).join(' | ');

  // Uncached inventory check immediately before claiming/submitting. Never trust menu location flags.
  await verifyPreorderInventory(menu, drawn, env, deps);

  // Claim the account's single open-order slot before sending anything to GrowFlow.
  const id = randomToken(), now = deps.now();
  const claimed = await env.APP_DB.prepare(`INSERT OR IGNORE INTO app_preorders
    (id, user_id, status, open, total_cents, item_count, created_at, checked_at)
    VALUES (?, ?, 'Submitting', 1, ?, ?, ?, ?) RETURNING id`).bind(id, s.id, totalCents, itemCount, now, now).first();
  if (!claimed) throw new AppError('OPEN_ORDER', 409);
  let result;
  try {
    result = await queryGrowflow(env, deps, CREATE_PREORDER, { menuKey: env.APP_MENU_KEY, preorder: {
      preOrderType: 'Pickup', preOrderTotal: totalCents, customer,
      orderItems: lines.map(({ cents, ...line }) => line),
      nameForOrder: `${customer.firstName} ${customer.lastName}`, ...(fullNote ? { preOrderNote: fullNote } : {})
    } }, env.APP_PREORDER_TOKEN);
  } catch (error) {
    deps.report(`PREORDER_SEND_${error.code || 'INTERNAL'}${error.category ? `_${error.category}` : ''}`);
    if (!error.sent) {
      await env.APP_DB.prepare('DELETE FROM app_preorders WHERE id = ?').bind(id).run();
      if (error.category === 'PREORDERS_OFF') throw new AppError('PREORDERS_OFF', 503);
      throw error;
    }
    return unconfirmed(env, id);
  }
  const response = result?.createPreorder, order = response?.order;
  if (response?.success === false) {
    deps.report('PREORDER_SEND_REJECTED');
    await env.APP_DB.prepare('DELETE FROM app_preorders WHERE id = ?').bind(id).run();
    throw new AppError('PREORDER_REJECTED', 409);
  }
  if (response?.success !== true || typeof order?.id !== 'string' || !order.id || typeof order.status !== 'string') {
    deps.report('PREORDER_SEND_SHAPE');
    return unconfirmed(env, id);
  }
  const status = order.status.slice(0, 40), open = isOpen(status) ? 1 : 0;
  const orderNumber = typeof order.orderNumber === 'string' ? order.orderNumber.slice(0, 40) : null;
  await env.APP_DB.prepare(`UPDATE app_preorders SET order_id = ?, order_number = ?, status = ?, open = ?, checked_at = ?,
    reward_name = ? WHERE id = ?`).bind(order.id, orderNumber, status, open, deps.now(), rewardName, id).run();
  const placed = summary({ order_number: orderNumber, status, open, total_cents: totalCents, item_count: itemCount, created_at: now,
    reward_name: rewardName });
  return licenseHint ? { ...placed, licenseHint } : placed;
}

async function unconfirmed(env, id) {
  await env.APP_DB.prepare(`UPDATE app_preorders SET status = 'Unconfirmed' WHERE id = ?`).bind(id).run();
  throw new AppError('PREORDER_UNCONFIRMED');
}

