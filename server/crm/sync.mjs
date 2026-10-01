import { AppError, fetchSafe } from '../customer-app/http.mjs';
import { limitGroup } from '../customer-app/growflow.mjs';

// Keeps the CRM database in step with GrowFlow: completed orders, purchase lines and customer
// basics, read incrementally by updatedAt with a read-only CRM token. Only lean facts are kept
// (see crm-migrations/0001_crm.sql); personal details are never requested here.
const DAY = 86400000;
export const RETENTION = { lineDays: 730, customerDays: 1095 };
const PAGE = 100;
// Keyset paging: strictly after the last record seen, ordered by (updatedAt, objectId). A record
// that changes again later simply reappears with its new updatedAt, so nothing is skipped.
const AFTER = `{ OR: [{ updatedAt: { greaterThan: $since } },
  { AND: [{ updatedAt: { equalTo: $since } }, { objectId: { greaterThan: $lastId } }] }] }`;

const SOURCES = {
  orders: `query TreehouseCrmOrders($since: Date!, $lastId: ID!) {
    findOrders(where: ${AFTER}, order: [updatedAt_ASC, objectId_ASC], first: ${PAGE}) {
      pageInfo { hasNextPage }
      edges { node { objectId updatedAt CompletedAt VoidedAt Status Total IsPreOrder Customer { objectId } } }
    }
  }`,
  lines: `query TreehouseCrmLines($since: Date!, $lastId: ID!) {
    findOrderItems(where: ${AFTER}, order: [updatedAt_ASC, objectId_ASC], first: ${PAGE}) {
      pageInfo { hasNextPage }
      edges { node { objectId updatedAt SoldAt ReturnedAt Status NetPrice Customer { objectId }
        Brand { objectId Name } ProductCategory { objectId Name Type } } }
    }
  }`,
  customers: `query TreehouseCrmCustomers($since: Date!, $lastId: ID!) {
    findCustomers(where: ${AFTER}, order: [updatedAt_ASC, objectId_ASC], first: ${PAGE}) {
      pageInfo { hasNextPage }
      edges { node { objectId updatedAt createdAt Birthday CustomerType CurrentPoints IsDeleted IsAnon } }
    }
  }`
};
const ROOT = { orders: 'findOrders', lines: 'findOrderItems', customers: 'findCustomers' };

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
        last_visit = MAX(COALESCE(last_visit, 0), excluded.last_visit), updated_at = excluded.updated_at`)
        .bind(row.customerId, row.completed, row.completed, now));
      statements.push(db.prepare(`INSERT INTO crm_orders(id, customer_id, completed_at, total_cents, is_preorder, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET customer_id = excluded.customer_id,
        completed_at = excluded.completed_at, total_cents = excluded.total_cents, is_preorder = excluded.is_preorder,
        status = excluded.status, updated_at = excluded.updated_at`)
        .bind(row.id, row.customerId, row.completed, row.totalCents, row.preorder, row.status, now));
    } else if (source === 'lines') {
      const row = lineRow(env, node, now);
      if (!row) continue;
      if (!row.customerId || !row.sold) { statements.push(db.prepare('DELETE FROM crm_lines WHERE id = ?').bind(row.id)); continue; }
      if (row.brandId && row.brandName) statements.push(db.prepare(`INSERT INTO crm_brands(id, name) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name`).bind(row.brandId, row.brandName));
      if (row.categoryId && row.categoryName) statements.push(db.prepare(`INSERT INTO crm_categories(id, name, category_group)
        VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, category_group = excluded.category_group`)
        .bind(row.categoryId, row.categoryName, row.group));
      statements.push(db.prepare(`INSERT INTO crm_lines(id, customer_id, sold_at, category_group, category_id, brand_id, net_cents, returned, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET customer_id = excluded.customer_id, sold_at = excluded.sold_at,
        category_group = excluded.category_group, category_id = excluded.category_id, brand_id = excluded.brand_id,
        net_cents = excluded.net_cents, returned = excluded.returned, updated_at = excluded.updated_at`)
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
        updated_at = excluded.updated_at`)
        .bind(customerId, created, born ? new Date(born).getUTCMonth() + 1 : null, type,
          Number.isFinite(node.CurrentPoints) ? node.CurrentPoints : null, now));
    }
  }
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
}

export function forgetStatements(db, customerId) {
  return ['crm_lines', 'crm_orders'].map(table => db.prepare(`DELETE FROM ${table} WHERE customer_id = ?`).bind(customerId))
    .concat(db.prepare('DELETE FROM crm_customers WHERE id = ?').bind(customerId));
}

async function state(env, source, now) {
  const row = await env.CRM_DB.prepare('SELECT since, last_id, caught_up_at FROM crm_sync_state WHERE source = ?').bind(source).first();
  if (row) return row;
  // Orders and lines start 24 months back (the retention window); customers from the beginning.
  const since = source === 'customers' ? '2000-01-01T00:00:00.000Z' : new Date(now - RETENTION.lineDays * DAY).toISOString();
  return { since, last_id: '', caught_up_at: null };
}

// One page per call, resuming strictly after the last record handled.
async function syncPage(env, deps, source) {
  const now = deps.now(), current = await state(env, source, now);
  const { data, slowDown } = await growflow(env, deps, SOURCES[source], { since: current.since, lastId: current.last_id });
  const connection = data[ROOT[source]];
  const nodes = (connection?.edges || []).map(e => e?.node).filter(Boolean);
  await apply(env, source, nodes, now);
  const last = nodes.at(-1), since = iso(last?.updatedAt) || current.since, lastId = id(last?.objectId) || current.last_id;
  const done = !connection?.pageInfo?.hasNextPage;
  await env.CRM_DB.prepare(`INSERT INTO crm_sync_state(source, since, last_id, caught_up_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET since = excluded.since, last_id = excluded.last_id,
    caught_up_at = COALESCE(excluded.caught_up_at, crm_sync_state.caught_up_at), updated_at = excluded.updated_at`)
    .bind(source, since, lastId, done ? now : null, now).run();
  return { done, slowDown, count: nodes.length };
}

// App adoption flags, read from the app's database (linked accounts, notification devices).
async function syncAppFlags(env) {
  if (!env.APP_DB) return;
  const linked = (await env.APP_DB.prepare('SELECT customer_id FROM app_users WHERE customer_id IS NOT NULL').bind().run()).results || [];
  const push = (await env.APP_DB.prepare(`SELECT DISTINCT u.customer_id FROM app_push_subscriptions s
    JOIN app_users u ON u.id = s.user_id WHERE u.customer_id IS NOT NULL`).bind().run()).results || [];
  const statements = [env.CRM_DB.prepare('UPDATE crm_customers SET app_linked = 0, app_push = 0').bind()];
  for (const [column, rows] of [['app_linked', linked], ['app_push', push]])
    for (let i = 0; i < rows.length; i += 50) {
      const ids = rows.slice(i, i + 50).map(r => r.customer_id).filter(id);
      if (ids.length) statements.push(env.CRM_DB.prepare(`UPDATE crm_customers SET ${column} = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids));
    }
  await env.CRM_DB.batch(statements);
}

export async function purge(env, now) {
  const lineCutoff = now - RETENTION.lineDays * DAY, customerCutoff = now - RETENTION.customerDays * DAY;
  await env.CRM_DB.batch([
    env.CRM_DB.prepare('DELETE FROM crm_lines WHERE sold_at < ?').bind(lineCutoff),
    env.CRM_DB.prepare('DELETE FROM crm_orders WHERE completed_at < ?').bind(lineCutoff),
    env.CRM_DB.prepare(`DELETE FROM crm_customers WHERE COALESCE(last_visit, first_seen) < ?
      AND id NOT IN (SELECT customer_id FROM crm_orders)`).bind(customerCutoff),
    env.CRM_DB.prepare('DELETE FROM crm_audit WHERE at < ?').bind(customerCutoff),
    env.CRM_DB.prepare('DELETE FROM crm_limits WHERE expires_at < ?').bind(now)
  ]);
}

// Scheduled run: a bounded number of GrowFlow pages across sources, then flags and retention.
export async function runSync(env, deps, maxPages = 20) {
  if (!crmReady(env)) return { pages: 0 };
  let pages = 0;
  const pending = ['orders', 'lines', 'customers'];
  try {
    while (pending.length && pages < maxPages) {
      const source = pending[0], result = await syncPage(env, deps, source);
      pages++;
      if (result.done) pending.shift(); else pending.push(pending.shift()); // round-robin until caught up
      if (result.slowDown) break;
    }
  } catch (error) {
    deps.report(error instanceof AppError ? error.code : 'CRM_SYNC');
  }
  await syncAppFlags(env).catch(() => deps.report('CRM_APP_FLAGS'));
  await purge(env, deps.now()).catch(() => deps.report('CRM_PURGE'));
  return { pages };
}
