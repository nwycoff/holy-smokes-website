import { localDay, localHour } from './campaigns.mjs';
import { FIELDS, growflow, lineRow, orderRow, time } from './sync.mjs';

// A one-time, read-only check of the CRM against GrowFlow, run by the sync Worker when
// CRM_VERIFY_ONCE is set to a new label. It re-reads a random sample of customers, every order
// on three sample days and every item sold on one day, compares them with what the CRM stored,
// and records match counts in Recent activity ("checked the CRM against GrowFlow"). Only IDs of
// a few mismatches are kept, never names.
const DAY = 86400000;
const centralMidnight = ms => {
  const noon = Date.parse(`${localDay(ms)}T12:00:00Z`);
  return noon - localHour(noon) * 3600000;
};
const customerQuery = `query TreehouseCrmVerifyCustomers($where: CustomersWhereInput!, $first: Int!) {
  findCustomers(where: $where, first: $first) { edges { node { ${FIELDS.customers} } } }
}`;
const pagedQuery = (root, type, fields) => `query TreehouseCrmVerify_${root}($where: ${type}!, $first: Int!) {
  ${root}(where: $where, order: [objectId_ASC], first: $first) { pageInfo { hasNextPage } edges { node { ${fields} } } }
}`;
// Every record in [start, end) by a date field, in objectId order.
async function readDay(env, deps, root, type, fields, dateField, start, end) {
  const nodes = [];
  let last = null;
  for (let page = 0; page < 15; page++) {
    const where = { AND: [{ [dateField]: { greaterThanOrEqualTo: new Date(start).toISOString() } },
      { [dateField]: { lessThan: new Date(end).toISOString() } }, ...(last ? [{ objectId: { greaterThan: last } }] : [])] };
    const { data } = await growflow(env, deps, pagedQuery(root, type, fields), { where, first: 100 });
    const edges = data[root]?.edges || [];
    nodes.push(...edges.map(e => e.node));
    if (!data[root]?.pageInfo?.hasNextPage || !edges.length) break;
    last = edges.at(-1).node.objectId;
  }
  return nodes;
}
const tally = () => ({ match: 0, mismatch: 0 });

async function checkCustomers(env, deps, now) {
  const { results: sample = [] } = await env.CRM_DB.prepare(`SELECT id, points, birth_month, customer_type, updated_at FROM crm_customers
    WHERE last_visit >= ? ORDER BY random() LIMIT 150`).bind(now - 90 * DAY).run();
  const found = new Map();
  for (let i = 0; i < sample.length; i += 100) {
    const { data } = await growflow(env, deps, customerQuery, { where: { objectId: { in: sample.slice(i, i + 100).map(c => c.id) } }, first: 100 });
    for (const e of data.findCustomers?.edges || []) found.set(e.node.objectId, e.node);
  }
  const out = { checked: sample.length, found: found.size, points: { ...tally(), changedSinceSync: 0 }, birthMonth: tally(), type: tally(), examples: [] };
  for (const c of sample) {
    const gf = found.get(c.id);
    if (!gf) continue;
    const note = (field, ok) => { out[field][ok ? 'match' : 'mismatch']++; if (!ok && out.examples.length < 8) out.examples.push({ id: c.id, field }); };
    const pointsOk = Number.isFinite(gf.CurrentPoints) ? Math.abs(gf.CurrentPoints - (c.points ?? NaN)) < 0.01 : c.points === null;
    if (!pointsOk && (time(gf.updatedAt) || 0) > c.updated_at - 60000) out.points.changedSinceSync++;
    else note('points', pointsOk);
    const born = time(gf.Birthday);
    note('birthMonth', (born ? new Date(born).getUTCMonth() + 1 : null) === c.birth_month);
    const type = ['medical', 'recreational'].includes(String(gf.CustomerType || '').toLowerCase()) ? String(gf.CustomerType).toLowerCase() : null;
    note('type', type === (c.customer_type ? c.customer_type.toLowerCase() : null));
  }
  return out;
}
async function checkOrders(env, deps, start, end) {
  const nodes = await readDay(env, deps, 'findOrders', 'OrdersWhereInput', FIELDS.orders, 'CompletedAt', start, end);
  const expected = new Map(nodes.map(n => orderRow(env, n, 0)).filter(r => r && r.customerId && r.completed && r.status === 'Completed'
    && r.completed >= start && r.completed < end).map(r => [r.id, r]));
  const { results: stored = [] } = await env.CRM_DB.prepare(`SELECT id, customer_id, total_cents, is_preorder FROM crm_orders
    WHERE completed_at >= ? AND completed_at < ?`).bind(start, end).run();
  const crm = new Map(stored.map(o => [o.id, o]));
  const differs = [...expected.values()].filter(r => crm.has(r.id)).filter(r => {
    const o = crm.get(r.id); return o.total_cents !== r.totalCents || o.customer_id !== r.customerId || o.is_preorder !== r.preorder;
  });
  const sum = list => list.reduce((n, x) => n + (x.totalCents ?? x.total_cents), 0);
  return { day: localDay(start + 12 * 3600000), growflowOrders: nodes.length, expected: expected.size, crm: crm.size,
    expectedCents: sum([...expected.values()]), crmCents: sum(stored),
    missingInCrm: [...expected.keys()].filter(k => !crm.has(k)).slice(0, 8), extraInCrm: [...crm.keys()].filter(k => !expected.has(k)).slice(0, 8),
    differentDetails: differs.length };
}
async function checkLines(env, deps, start, end) {
  const nodes = await readDay(env, deps, 'findOrderItems', 'OrderItemsWhereInput', FIELDS.lines, 'SoldAt', start, end);
  const expected = new Map(nodes.map(n => lineRow(env, n, 0)).filter(r => r && r.customerId && r.sold && r.sold >= start && r.sold < end).map(r => [r.id, r]));
  const { results: stored = [] } = await env.CRM_DB.prepare(`SELECT id, customer_id, net_cents, returned, brand_id, category_id, category_group
    FROM crm_lines WHERE sold_at >= ? AND sold_at < ?`).bind(start, end).run();
  const crm = new Map(stored.map(l => [l.id, l]));
  const out = { day: localDay(start + 12 * 3600000), growflowItems: nodes.length, expected: expected.size, crm: crm.size,
    expectedCents: 0, crmCents: stored.filter(l => !l.returned).reduce((n, l) => n + l.net_cents, 0),
    missingInCrm: [...expected.keys()].filter(k => !crm.has(k)).slice(0, 8), extraInCrm: [...crm.keys()].filter(k => !expected.has(k)).slice(0, 8),
    price: tally(), brand: tally(), category: tally(), returned: tally() };
  for (const r of expected.values()) {
    if (!r.returned) out.expectedCents += r.netCents;
    const l = crm.get(r.id);
    if (!l) continue;
    out.price[l.net_cents === r.netCents ? 'match' : 'mismatch']++;
    out.brand[l.brand_id === r.brandId ? 'match' : 'mismatch']++;
    out.category[l.category_id === r.categoryId && l.category_group === r.group ? 'match' : 'mismatch']++;
    out.returned[l.returned === r.returned ? 'match' : 'mismatch']++;
  }
  return out;
}

// Runs once per CRM_VERIFY_ONCE label; returns true if this tick was used for the check.
export async function maybeVerify(env, deps) {
  const label = String(env.CRM_VERIFY_ONCE || '').slice(0, 40);
  if (!label) return false;
  const now = deps.now(), rowId = `verify:${label}`;
  const claimed = await env.CRM_DB.prepare(`INSERT OR IGNORE INTO crm_audit(id, at, actor, action, detail) VALUES (?, ?, 'system', 'data_check_running', NULL)
    RETURNING id`).bind(rowId, now).first();
  if (!claimed) return false;
  const report = { label };
  const step = async (name, run) => { try { report[name] = await run(); } catch (e) { report[name] = { error: e?.code || 'ERROR' }; } };
  const today = centralMidnight(now);
  await step('customers', () => checkCustomers(env, deps, now));
  report.orderDays = [];
  for (const back of [1, 30, 300]) {
    const start = centralMidnight(today - back * DAY + 12 * 3600000), end = centralMidnight(start + 36 * 3600000);
    await step('day', () => checkOrders(env, deps, start, end)); report.orderDays.push(report.day); delete report.day;
  }
  const yStart = centralMidnight(today - DAY + 12 * 3600000);
  await step('items', () => checkLines(env, deps, yStart, today));
  await env.CRM_DB.prepare(`UPDATE crm_audit SET action = 'data_check', at = ?, detail = ? WHERE id = ?`)
    .bind(deps.now(), JSON.stringify(report), rowId).run();
  return true;
}
