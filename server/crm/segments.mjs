import { AppError } from '../customer-app/http.mjs';

// A segment is a set of rules, all of which must match. Rules are checked against a fixed
// schema and compiled to parameterized SQL; no user text ever becomes part of a query.
const DAY = 86400000;
// A date in the store's time zone (Central), as numbers.
function storeDate(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}
const leapYear = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// "birthday: today" matches a birthday today or in the last 2 days (Central), so a birthday
// message held back by the weekly limit still goes out a day or two later; an automation's
// cooldown keeps it to once. Feb 29 birthdays count on Feb 28 in other years.
export const BIRTHDAY_GRACE_DAYS = 2;
export function birthdayDates(now) {
  const dates = [];
  for (let back = 0; back <= BIRTHDAY_GRACE_DAYS; back++) {
    const { year, month, day } = storeDate(now - back * DAY);
    dates.push([month, day]);
    if (month === 2 && day === 28 && !leapYear(year)) dates.push([2, 29]);
  }
  return dates;
}
export const GROUPS = ['flower', 'concentrate', 'edible', 'topical', 'seed', 'clone', 'other'];
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const only = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));

export function validateDefinition(input) {
  const d = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  const fail = () => { throw new AppError('SEGMENT_RULES', 400); };
  if (!only(d, ['lastVisit', 'visits', 'spend', 'categories', 'brands', 'pointsMin', 'birthday', 'app', 'newWithinDays'])) fail();
  const out = {};
  if (d.lastVisit !== undefined) {
    const r = d.lastVisit;
    if (!only(r, ['minDays', 'maxDays']) || (r.minDays !== undefined && !int(r.minDays, 0, 3650))
      || (r.maxDays !== undefined && !int(r.maxDays, 1, 3650)) || (r.minDays === undefined && r.maxDays === undefined)
      || (r.minDays !== undefined && r.maxDays !== undefined && r.minDays > r.maxDays)) fail();
    out.lastVisit = { ...r };
  }
  for (const key of ['visits', 'spend']) {
    if (d[key] === undefined) continue;
    const r = d[key], check = key === 'visits' ? v => int(v, 0, 10000) : v => num(v, 0, 1000000);
    if (!only(r, ['days', 'min', 'max']) || !int(r.days, 1, 730) || (r.min === undefined && r.max === undefined)
      || (r.min !== undefined && !check(r.min)) || (r.max !== undefined && !check(r.max))
      || (r.min !== undefined && r.max !== undefined && r.min > r.max)) fail();
    out[key] = { ...r };
  }
  if (d.categories !== undefined) {
    const r = d.categories;
    if (!only(r, ['groups', 'days']) || !int(r.days, 1, 730) || !Array.isArray(r.groups) || !r.groups.length
      || r.groups.some(g => !GROUPS.includes(g))) fail();
    out.categories = { groups: [...new Set(r.groups)], days: r.days };
  }
  if (d.brands !== undefined) {
    const r = d.brands;
    if (!only(r, ['ids', 'days']) || !int(r.days, 1, 730) || !Array.isArray(r.ids) || !r.ids.length || r.ids.length > 20
      || r.ids.some(v => typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v))) fail();
    out.brands = { ids: [...new Set(r.ids)], days: r.days };
  }
  if (d.pointsMin !== undefined) { if (!num(d.pointsMin, 0, 1000000)) fail(); out.pointsMin = d.pointsMin; }
  if (d.birthday !== undefined) { if (!['today', 'this_month', 'next_month'].includes(d.birthday)) fail(); out.birthday = d.birthday; }
  if (d.app !== undefined) { if (!['linked', 'not_linked', 'push', 'marketing'].includes(d.app)) fail(); out.app = d.app; }
  if (d.newWithinDays !== undefined) { if (!int(d.newWithinDays, 1, 730)) fail(); out.newWithinDays = d.newWithinDays; }
  if (!Object.keys(out).length) fail();
  return out;
}

// WHERE clause over crm_customers c, with its parameters.
export function compile(def, now) {
  const where = [], params = [];
  const since = days => now - days * DAY;
  if (def.lastVisit) {
    where.push('c.last_visit IS NOT NULL');
    if (def.lastVisit.minDays !== undefined) { where.push('c.last_visit <= ?'); params.push(since(def.lastVisit.minDays)); }
    if (def.lastVisit.maxDays !== undefined) { where.push('c.last_visit >= ?'); params.push(since(def.lastVisit.maxDays)); }
  }
  if (def.visits) {
    const expr = '(SELECT COUNT(*) FROM crm_orders o WHERE o.customer_id = c.id AND o.completed_at >= ?)';
    if (def.visits.min !== undefined) { where.push(`${expr} >= ?`); params.push(since(def.visits.days), def.visits.min); }
    if (def.visits.max !== undefined) { where.push(`${expr} <= ?`); params.push(since(def.visits.days), def.visits.max); }
  }
  if (def.spend) {
    const expr = '(SELECT COALESCE(SUM(o.total_cents), 0) FROM crm_orders o WHERE o.customer_id = c.id AND o.completed_at >= ?)';
    if (def.spend.min !== undefined) { where.push(`${expr} >= ?`); params.push(since(def.spend.days), Math.round(def.spend.min * 100)); }
    if (def.spend.max !== undefined) { where.push(`${expr} <= ?`); params.push(since(def.spend.days), Math.round(def.spend.max * 100)); }
  }
  if (def.categories) {
    where.push(`EXISTS (SELECT 1 FROM crm_lines l WHERE l.customer_id = c.id AND l.returned = 0 AND l.sold_at >= ?
      AND l.category_group IN (${def.categories.groups.map(() => '?').join(',')}))`);
    params.push(since(def.categories.days), ...def.categories.groups);
  }
  if (def.brands) {
    where.push(`EXISTS (SELECT 1 FROM crm_lines l WHERE l.customer_id = c.id AND l.returned = 0 AND l.sold_at >= ?
      AND l.brand_id IN (${def.brands.ids.map(() => '?').join(',')}))`);
    params.push(since(def.brands.days), ...def.brands.ids);
  }
  if (def.pointsMin !== undefined) { where.push('c.points >= ?'); params.push(def.pointsMin); }
  if (def.birthday === 'today') {
    const dates = birthdayDates(now);
    where.push(`(${dates.map(() => '(c.birth_month = ? AND c.birth_day = ?)').join(' OR ')})`); params.push(...dates.flat());
  } else if (def.birthday) {
    const month = storeDate(now).month - 1 + (def.birthday === 'next_month' ? 1 : 0);
    where.push('c.birth_month = ?'); params.push((month % 12) + 1);
  }
  if (def.app === 'linked') where.push('c.app_linked = 1');
  if (def.app === 'not_linked') where.push('c.app_linked = 0');
  if (def.app === 'push') where.push('c.app_push = 1');
  if (def.app === 'marketing') where.push('c.app_marketing = 1');
  if (def.newWithinDays) { where.push('c.first_seen >= ? AND c.last_visit IS NOT NULL'); params.push(since(def.newWithinDays)); }
  return { where: where.join(' AND '), params };
}

// Counts and averages for a segment, without listing anyone.
export async function preview(db, def, now) {
  const { where, params } = compile(def, now);
  const row = await db.prepare(`SELECT COUNT(*) AS customers, AVG(c.points) AS avg_points, SUM(c.app_linked) AS app_linked,
    SUM(c.app_push) AS app_push, SUM(c.app_marketing) AS app_marketing, (SELECT COALESCE(SUM(o.total_cents), 0) FROM crm_orders o WHERE o.completed_at >= ?
      AND o.customer_id IN (SELECT c.id FROM crm_customers c WHERE ${where})) AS spend_90_cents
    FROM crm_customers c WHERE ${where}`).bind(now - 90 * DAY, ...params, ...params).first();
  return { customers: row?.customers || 0, avgPoints: row?.avg_points === null ? null : Math.round(row?.avg_points || 0),
    appLinked: row?.app_linked || 0, appPush: row?.app_push || 0, appMarketing: row?.app_marketing || 0, spend90Cents: row?.spend_90_cents || 0 };
}

const SORTS = { spend: 'spend_90_cents DESC', recent: 'c.last_visit DESC', visits: 'visits_90 DESC', points: 'c.points DESC' };
// Up to `limit` members with their key numbers. Identities are added by the caller, live.
export async function members(db, def, now, sort = 'spend', limit = 200) {
  const { where, params } = compile(def, now);
  const since90 = now - 90 * DAY, since365 = now - 365 * DAY;
  const { results = [] } = await db.prepare(`SELECT c.id, c.last_visit, c.points, c.app_linked, c.app_push, c.app_marketing, c.birth_month,
    (SELECT COUNT(*) FROM crm_orders o WHERE o.customer_id = c.id AND o.completed_at >= ?) AS visits_90,
    (SELECT COALESCE(SUM(o.total_cents), 0) FROM crm_orders o WHERE o.customer_id = c.id AND o.completed_at >= ?) AS spend_90_cents,
    (SELECT l.category_group FROM crm_lines l WHERE l.customer_id = c.id AND l.returned = 0 AND l.sold_at >= ?
      GROUP BY l.category_group ORDER BY SUM(l.net_cents) DESC LIMIT 1) AS top_group
    FROM crm_customers c WHERE ${where} ORDER BY ${SORTS[sort] || SORTS.spend} LIMIT ?`)
    .bind(since90, since90, since365, ...params, Math.min(Math.max(limit, 1), 500)).run();
  return results;
}
