import { AppError, fetchSafe } from '../customer-app/http.mjs';
import { limitGroup } from '../customer-app/growflow.mjs';

// Keeps the CRM database in step with GrowFlow: completed orders, purchase lines and customer
// basics, read incrementally by updatedAt with a read-only CRM token. Only lean facts are kept
// (see crm-migrations/0001_crm.sql); personal details are never requested here.
const DAY = 86400000;
export const RETENTION = { lineDays: 730, customerDays: 1095 };
const PAGE = 100, SMALL_PAGE = 25;
const FIELDS = {
  orders: 'objectId updatedAt CompletedAt VoidedAt Status Total IsPreOrder Customer { objectId }',
  lines: `objectId updatedAt SoldAt ReturnedAt Status NetPrice Customer { objectId }
        Brand { objectId Name } ProductCategory { objectId Name Type }`,
  customers: 'objectId updatedAt createdAt Birthday CustomerType CurrentPoints IsDeleted IsAnon'
};
const TYPES = { orders: 'OrdersWhereInput', lines: 'OrderItemsWhereInput', customers: 'CustomersWhereInput' };
const ORDERS = { orders: 'OrdersOrder', lines: 'OrderItemsOrder', customers: 'CustomersOrder' };
const query = source => `query TreehouseCrm_${source}($where: ${TYPES[source]}!, $order: [${ORDERS[source]}!], $first: Int!) {
  ${ROOT_FIELD[source]}(where: $where, order: $order, first: $first) {
    pageInfo { hasNextPage } edges { node { ${FIELDS[source]} } }
  }
}`;
const ROOT_FIELD = { orders: 'findOrders', lines: 'findOrderItems', customers: 'findCustomers' };
// Orders and lines are only requested within the retention window; older history is never kept.
function recency(source, now) {
  const cutoff = new Date(now - RETENTION.lineDays * DAY).toISOString();
  return source === 'orders' ? [{ CompletedAt: { greaterThanOrEqualTo: cutoff } }]
    : source === 'lines' ? [{ SoldAt: { greaterThanOrEqualTo: cutoff } }] : [];
}

const iso = value => typeof value === 'string' ? value : typeof value?.iso === 'string' ? value.iso : null;
const time = value => { const t = Date.parse(iso(value) || ''); return Number.isFinite(t) ? t : null; };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) : '';
// GrowFlow stores money as whole cents (menu prices, discounts, preorder totals). Set
// CRM_MONEY_UNIT=dollars only if order totals turn out to be dollar amounts.
export const cents = (env, value) => Number.isFinite(value)
  ? Math.round(env.CRM_MONEY_UNIT === 'dollars' ? value * 100 : value) : 0;

export function crmReady(env) {
  return Boolean(env.CRM_DB) && /^[a-z0-9-]+$/.test(env.GROWFLOW_ORG || '') && /^gfr_\S+$/.test(env.CRM_GROWFLOW_TOKEN || '');
}

// The CRM's own GrowFlow budget, separate from the app's. GrowFlow allows 120 requests a
// minute per token; the sync stays well under that and stops early when GrowFlow says so.
async function growflow(env, deps, query, variables) {
  const res = await fetchSafe(deps, `https://retail.growflow.com/c/${env.GROWFLOW_ORG}/graphql`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.CRM_GROWFLOW_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  }, 25000);
  if (res.status === 429) throw new AppError('CRM_RATE_LIMITED');
  if (!res.ok) throw new AppError(`CRM_HTTP_${res.status}`);
  const payload = await res.json();
  if (payload.errors?.length || !payload.data) throw new AppError('CRM_QUERY');
  const header = res.headers.get('ratelimit-remaining'), remaining = header === null ? Infinity : Number(header);
  return { data: payload.data, slowDown: Number.isFinite(remaining) && remaining <= 20 };
}

function orderRow(env, node, now) {
  const orderId = id(node?.objectId), customerId = id(node?.Customer?.objectId);
  const completed = time(node?.CompletedAt);
  if (!orderId) return null;
  const status = node.VoidedAt ? 'Voided' : text(node.Status) || 'Unknown';
  return { id: orderId, customerId, completed, status, totalCents: cents(env, node.Total), preorder: node.IsPreOrder ? 1 : 0, now };
}
function lineRow(env, node, now) {
  const lineId = id(node?.objectId), customerId = id(node?.Customer?.objectId), sold = time(node?.SoldAt);
  if (!lineId) return null;
  const category = node.ProductCategory || {};
  return { id: lineId, customerId, sold, now,
    group: limitGroup(category.Type, category.Name) || 'other', categoryId: id(category.objectId), categoryName: text(category.Name),
    brandId: id(node.Brand?.objectId), brandName: text(node.Brand?.Name),
    netCents: cents(env, node.NetPrice), returned: node.ReturnedAt || /return/i.test(node.Status || '') ? 1 : 0 };
}

async function apply(env, source, nodes, now) {
  const db = env.CRM_DB, statements = [];
  for (const node of nodes) {
    if (source === 'orders') {
      const row = orderRow(env, node, now);
      if (!row) continue;
      // Only completed orders tied to a customer are kept; anything else removes a stale copy.
      if (!row.customerId || !row.completed || row.status !== 'Completed') {
        statements.push(db.prepare('DELETE FROM crm_orders WHERE id = ?').bind(row.id));
        continue;
      }
      statements.push(db.prepare(`INSERT INTO crm_customers(id, first_seen, last_visit, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen),
        last_visit = MAX(COALESCE(last_visit, 0), excluded.last_visit), updated_at = excluded.updated_at
        WHERE crm_customers.first_seen > excluded.first_seen OR COALESCE(crm_customers.last_visit, 0) < excluded.last_visit`)
        .bind(row.customerId, row.completed, row.completed, now));
      statements.push(db.prepare(`INSERT INTO crm_orders(id, customer_id, completed_at, total_cents, is_preorder, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET customer_id = excluded.customer_id,
        completed_at = excluded.completed_at, total_cents = excluded.total_cents, is_preorder = excluded.is_preorder,
        status = excluded.status, updated_at = excluded.updated_at
        WHERE (crm_orders.customer_id, crm_orders.completed_at, crm_orders.total_cents, crm_orders.is_preorder, crm_orders.status)
          IS NOT (excluded.customer_id, excluded.completed_at, excluded.total_cents, excluded.is_preorder, excluded.status)`)
        .bind(row.id, row.customerId, row.completed, row.totalCents, row.preorder, row.status, now));
    } else if (source === 'lines') {
      const row = lineRow(env, node, now);
      if (!row) continue;
      if (!row.customerId || !row.sold) { statements.push(db.prepare('DELETE FROM crm_lines WHERE id = ?').bind(row.id)); continue; }
      if (row.brandId && row.brandName) statements.push(db.prepare(`INSERT INTO crm_brands(id, name) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name WHERE crm_brands.name IS NOT excluded.name`).bind(row.brandId, row.brandName));
      if (row.categoryId && row.categoryName) statements.push(db.prepare(`INSERT INTO crm_categories(id, name, category_group)
        VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, category_group = excluded.category_group
        WHERE (crm_categories.name, crm_categories.category_group) IS NOT (excluded.name, excluded.category_group)`)
        .bind(row.categoryId, row.categoryName, row.group));
      statements.push(db.prepare(`INSERT INTO crm_lines(id, customer_id, sold_at, category_group, category_id, brand_id, net_cents, returned, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET customer_id = excluded.customer_id, sold_at = excluded.sold_at,
        category_group = excluded.category_group, category_id = excluded.category_id, brand_id = excluded.brand_id,
        net_cents = excluded.net_cents, returned = excluded.returned, updated_at = excluded.updated_at
        WHERE (crm_lines.customer_id, crm_lines.sold_at, crm_lines.category_group, crm_lines.category_id, crm_lines.brand_id,
          crm_lines.net_cents, crm_lines.returned) IS NOT (excluded.customer_id, excluded.sold_at, excluded.category_group,
          excluded.category_id, excluded.brand_id, excluded.net_cents, excluded.returned)`)
        .bind(row.id, row.customerId, row.sold, row.group, row.categoryId, row.brandId, row.netCents, row.returned, now));
    } else {
      const customerId = id(node?.objectId);
      if (!customerId) continue;
      if (node.IsDeleted === true || node.IsAnon === true) { statements.push(...forgetStatements(db, customerId)); continue; }
      const born = time(node.Birthday), created = time(node.createdAt) ?? now;
      const type = ['medical', 'recreational'].includes(String(node.CustomerType || '').toLowerCase())
        ? String(node.CustomerType)[0].toUpperCase() + String(node.CustomerType).slice(1).toLowerCase() : null;
      statements.push(db.prepare(`INSERT INTO crm_customers(id, first_seen, birth_month, customer_type, points, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen),
        birth_month = excluded.birth_month, customer_type = excluded.customer_type, points = excluded.points,
        updated_at = excluded.updated_at
        WHERE crm_customers.first_seen > excluded.first_seen OR (crm_customers.birth_month, crm_customers.customer_type, crm_customers.points)
          IS NOT (excluded.birth_month, excluded.customer_type, excluded.points)`)
        .bind(customerId, created, born ? new Date(born).getUTCMonth() + 1 : null, type,
          Number.isFinite(node.CurrentPoints) ? node.CurrentPoints : null, now));
    }
  }
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
}

export function forgetStatements(db, customerId) {
  return ['crm_lines', 'crm_orders', 'crm_campaign_recipients'].map(table => db.prepare(`DELETE FROM ${table} WHERE customer_id = ?`).bind(customerId))
    .concat(db.prepare('DELETE FROM crm_customers WHERE id = ?').bind(customerId),
      db.prepare('UPDATE crm_settings SET test_customer_id = NULL WHERE test_customer_id = ?').bind(customerId));
}

// Position: `since` (an updatedAt) and `last_id`. DONE_AT_SINCE means every record at exactly
// `since` has been handled, so the next step moves strictly past it.
const DONE_AT_SINCE = '~';
async function state(env, source, now) {
  const row = await env.CRM_DB.prepare('SELECT since, last_id, caught_up_at FROM crm_sync_state WHERE source = ?').bind(source).first();
  if (row) return row;
  // Orders and lines start 24 months back (the retention window); customers from the beginning.
  const since = source === 'customers' ? '2000-01-01T00:00:00.000Z' : new Date(now - RETENTION.lineDays * DAY).toISOString();
  return { since, last_id: DONE_AT_SINCE, caught_up_at: null };
}
const retryable = error => error instanceof AppError && /^CRM_HTTP_(5\d\d)$|^CRM_QUERY$/.test(error.code)
  || !(error instanceof AppError);

// One page per call, in two simple steps instead of one heavy either/or query: first finish the
// records at exactly `since` (by objectId), then continue strictly after `since` (by updatedAt).
// A record that changes again later simply reappears with its new updatedAt.
async function syncPage(env, deps, source) {
  const now = deps.now(), current = await state(env, source, now);
  const atSince = current.last_id !== DONE_AT_SINCE;
  const where = { AND: [...(atSince
    ? [{ updatedAt: { equalTo: current.since } }, { objectId: { greaterThan: current.last_id } }]
    : [{ updatedAt: { greaterThan: current.since } }]), ...recency(source, now)] };
  const order = atSince ? ['objectId_ASC'] : ['updatedAt_ASC', 'objectId_ASC'];
  let result;
  try { result = await growflow(env, deps, query(source), { where, order, first: PAGE }); }
  catch (error) {
    // GrowFlow sometimes struggles with large pages; one retry with a smaller one.
    if (!retryable(error)) throw error;
    result = await growflow(env, deps, query(source), { where, order, first: SMALL_PAGE });
  }
  const connection = result.data[ROOT_FIELD[source]];
  const nodes = (connection?.edges || []).map(e => e?.node).filter(Boolean);
  await apply(env, source, nodes, now);
  const more = Boolean(connection?.pageInfo?.hasNextPage), last = nodes.at(-1);
  let since = current.since, lastId = current.last_id, done = false;
  if (atSince) lastId = more ? id(last?.objectId) || DONE_AT_SINCE : DONE_AT_SINCE;
  else if (last) { since = iso(last.updatedAt) || since; lastId = more ? id(last.objectId) || DONE_AT_SINCE : DONE_AT_SINCE; done = !more; }
  else done = true;
  await env.CRM_DB.prepare(`INSERT INTO crm_sync_state(source, since, last_id, caught_up_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET since = excluded.since, last_id = excluded.last_id,
    caught_up_at = COALESCE(excluded.caught_up_at, crm_sync_state.caught_up_at), updated_at = excluded.updated_at`)
    .bind(source, since, lastId, done ? now : null, now).run();
  return { done, slowDown: result.slowDown, count: nodes.length };
}

// App adoption flags, read from the app's database (linked accounts, notification devices).
async function syncAppFlags(env) {
  if (!env.APP_DB) return;
  const linked = (await env.APP_DB.prepare('SELECT customer_id FROM app_users WHERE customer_id IS NOT NULL').bind().run()).results || [];
  const push = (await env.APP_DB.prepare(`SELECT DISTINCT u.customer_id FROM app_push_subscriptions s
    JOIN app_users u ON u.id = s.user_id WHERE u.customer_id IS NOT NULL`).bind().run()).results || [];
  // Opted in to Deals & news with at least one device. Skipped (left as is) until the app migration exists.
  const marketing = (await env.APP_DB.prepare(`SELECT DISTINCT u.customer_id FROM app_marketing_prefs m
    JOIN app_users u ON u.id = m.user_id JOIN app_push_subscriptions s ON s.user_id = u.id
    WHERE u.customer_id IS NOT NULL AND m.topics <> '[]'`).bind().run().catch(() => null))?.results;
  // Only rows whose flag actually changes are written (every write counts against D1 usage).
  const statements = [];
  for (const [column, rows] of [['app_linked', linked], ['app_push', push], ...(marketing ? [['app_marketing', marketing]] : [])]) {
    const ids = JSON.stringify([...new Set(rows.map(r => r.customer_id).filter(id))]);
    statements.push(env.CRM_DB.prepare(`UPDATE crm_customers SET ${column} = 0 WHERE ${column} = 1 AND id NOT IN (SELECT value FROM json_each(?))`).bind(ids),
      env.CRM_DB.prepare(`UPDATE crm_customers SET ${column} = 1 WHERE ${column} = 0 AND id IN (SELECT value FROM json_each(?))`).bind(ids));
  }
  await env.CRM_DB.batch(statements);
}

export async function purge(env, now) {
  const lineCutoff = now - RETENTION.lineDays * DAY, customerCutoff = now - RETENTION.customerDays * DAY;
  await env.CRM_DB.batch([
    env.CRM_DB.prepare('DELETE FROM crm_lines WHERE sold_at < ?').bind(lineCutoff),
    env.CRM_DB.prepare('DELETE FROM crm_orders WHERE completed_at < ?').bind(lineCutoff),
    // Only once order history has fully loaded: before that, a regular's recent visits may not be in yet.
    env.CRM_DB.prepare(`DELETE FROM crm_customers WHERE COALESCE(last_visit, first_seen) < ?
      AND id NOT IN (SELECT customer_id FROM crm_orders)
      AND (SELECT caught_up_at FROM crm_sync_state WHERE source = 'orders') IS NOT NULL`).bind(customerCutoff),
    env.CRM_DB.prepare('DELETE FROM crm_audit WHERE at < ?').bind(customerCutoff),
    env.CRM_DB.prepare('DELETE FROM crm_campaign_recipients WHERE campaign_id IN (SELECT id FROM crm_campaigns WHERE created_at < ?)').bind(lineCutoff),
    env.CRM_DB.prepare('DELETE FROM crm_campaigns WHERE created_at < ?').bind(lineCutoff),
    env.CRM_DB.prepare('DELETE FROM crm_limits WHERE expires_at < ?').bind(now)
  ]);
}

// Scheduled run: a bounded number of GrowFlow pages across sources, then flags and retention.
export async function runSync(env, deps, maxPages = 40, budgetMs = 45000) {
  if (!crmReady(env)) return { pages: 0 };
  let pages = 0;
  const started = deps.now();
  const pending = ['orders', 'lines', 'customers'];
  // Round-robin across sources until caught up. A source that errors is set aside for this run
  // so the others keep moving; it is retried on the next run. No new page starts after the time
  // budget, so a run ends before the next minute's run begins and the two never redo each other's pages.
  while (pending.length && pages < maxPages && deps.now() - started < budgetMs) {
    const source = pending.shift();
    pages++;
    try {
      const result = await syncPage(env, deps, source);
      if (!result.done) pending.push(source);
      if (result.slowDown) break;
    } catch (error) {
      deps.report(`${error instanceof AppError ? error.code : 'CRM_SYNC'}_${source.toUpperCase()}`);
    }
  }
  await syncAppFlags(env).catch(() => deps.report('CRM_APP_FLAGS'));
  await purge(env, deps.now()).catch(() => deps.report('CRM_PURGE'));
  return { pages };
}
