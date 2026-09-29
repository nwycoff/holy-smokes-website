import { AppError, randomToken } from './http.mjs';
import { CREATE_PREORDER, PREORDER_CUSTOMER_QUERY, PREORDER_STATUS, eligibleCustomer, getMenu,
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
    totalCents: row.total_cents, itemCount: row.item_count, createdAt: row.created_at } : null;
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
  if (now - row.checked_at < STATUS_REFRESH) return summary(row);
  try {
    const data = await queryGrowflow(env, deps, PREORDER_STATUS, { orderId: row.order_id }, env.APP_PREORDER_TOKEN);
    const order = data?.preorderStatus?.order;
    if (order?.id !== row.order_id || typeof order.status !== 'string') throw new AppError('PREORDER_STATUS_SHAPE');
    const status = order.status.slice(0, 40), open = isOpen(status) ? 1 : 0;
    await env.APP_DB.prepare('UPDATE app_preorders SET status = ?, open = ?, checked_at = ? WHERE id = ?')
      .bind(status, open, now, row.id).run();
    return summary({ ...row, status, open });
  } catch (error) {
    // Show the last known status; the order itself is unaffected.
    deps.report(error instanceof AppError ? error.code : 'PREORDER_STATUS');
    return summary(row);
  }
}

function readItems(input) {
  if (Object.keys(input).some(k => !['items', 'note', 'license'].includes(k)) || !Array.isArray(input.items)
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
  return { items, note, license };
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
  // GrowFlow also requires the license expiry (YYYY-MM-DD) with a license number. Taken from
  // the record's state license expiration, falling back to its license end date.
  let medicalLicenseExpires;
  if (license) {
    const expires = [customer.CustomerStateLicenseExpiration, customer.LicenseEffectiveEndDate]
      .map(dateValue).find(date => Number.isFinite(date.getTime()));
    if (!expires) throw new AppError('LICENSE_EXPIRY_MISSING', 409);
    medicalLicenseExpires = expires.toISOString().slice(0, 10);
    if (medicalLicenseExpires < new Date(deps.now()).toISOString().slice(0, 10)) throw new AppError('LICENSE_EXPIRED', 409);
  }
  return { id: customer.objectId, type, firstName: names.slice(0, -1).join(' '), lastName: names.at(-1), dob,
    ...(license ? { medicalLicenseNumber: license, medicalLicenseExpires } : {}) };
}

export async function placePreorder(env, deps, s, input, limit) {
  const { items, note, license } = readItems(input);
  if ((await currentPreorder(env, deps, s))?.open) throw new AppError('OPEN_ORDER', 409);
  await limit();
  const menu = await getMenu(env, deps);
  if (menu.stale) throw new AppError('MENU_STALE');
  const lines = items.map(item => {
    const variant = menu.products.find(p => p.id === item.productId)?.variants.find(v => v.size === item.size);
    if (!variant) throw new AppError('ITEM_UNAVAILABLE', 409);
    if (variant.priceCents !== item.priceCents) throw new AppError('PRICE_CHANGED', 409);
    return { productId: item.productId, qty: item.qty, ...(variant.weight ? { weight: variant.weight } : {}),
      cents: variant.priceCents * item.qty };
  });
  const totalCents = lines.reduce((sum, line) => sum + line.cents, 0);
  const itemCount = items.reduce((n, item) => n + item.qty, 0);
  const customer = await preorderCustomer(env, deps, s.customer_id, license);

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
      nameForOrder: `${customer.firstName} ${customer.lastName}`, ...(note ? { preOrderNote: note } : {})
    } }, env.APP_PREORDER_TOKEN);
  } catch (error) {
    deps.report(`PREORDER_SEND_${error.code || 'INTERNAL'}${error.category ? `_${error.category}` : ''}`);
    if (!error.sent) {
      await env.APP_DB.prepare('DELETE FROM app_preorders WHERE id = ?').bind(id).run();
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
  await env.APP_DB.prepare(`UPDATE app_preorders SET order_id = ?, order_number = ?, status = ?, open = ?, checked_at = ?
    WHERE id = ?`).bind(order.id, orderNumber, status, open, deps.now(), id).run();
  return summary({ order_number: orderNumber, status, open, total_cents: totalCents, item_count: itemCount, created_at: now });
}

async function unconfirmed(env, id) {
  await env.APP_DB.prepare(`UPDATE app_preorders SET status = 'Unconfirmed' WHERE id = ?`).bind(id).run();
  throw new AppError('PREORDER_UNCONFIRMED');
}
