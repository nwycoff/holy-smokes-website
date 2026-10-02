// Shop-level numbers for the CRM dashboard and the campaign assistant. Totals only: nothing
// here identifies a customer.
const DAY = 86400000;

export async function overview(env, now) {
  const db = env.CRM_DB, ago = d => now - d * DAY;
  const totals = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM crm_customers WHERE last_visit >= ?) AS active_30,
      (SELECT COUNT(*) FROM crm_customers WHERE last_visit >= ?) AS active_90,
      (SELECT COUNT(*) FROM crm_customers WHERE last_visit >= ?) AS active_365,
      (SELECT COUNT(*) FROM crm_customers WHERE last_visit < ? AND last_visit >= ?) AS lapsed_60_180,
      (SELECT COUNT(*) FROM crm_customers WHERE first_seen >= ? AND last_visit IS NOT NULL) AS new_30,
      (SELECT COUNT(*) FROM crm_customers WHERE birth_month = ? AND last_visit >= ?) AS birthdays_month,
      (SELECT COUNT(*) FROM crm_customers WHERE app_linked = 1) AS app_linked,
      (SELECT COUNT(*) FROM crm_customers WHERE app_push = 1) AS app_push,
      (SELECT COUNT(*) FROM crm_customers WHERE app_marketing = 1) AS app_marketing,
      (SELECT COUNT(*) FROM crm_customers WHERE points >= 225 AND last_visit >= ?) AS can_redeem,
      (SELECT COUNT(*) FROM crm_orders WHERE completed_at >= ?) AS visits_30,
      (SELECT COALESCE(SUM(total_cents), 0) FROM crm_orders WHERE completed_at >= ?) AS revenue_30_cents,
      (SELECT COUNT(*) FROM crm_orders WHERE completed_at >= ? AND completed_at < ?) AS visits_prev_30,
      (SELECT COALESCE(SUM(total_cents), 0) FROM crm_orders WHERE completed_at >= ? AND completed_at < ?) AS revenue_prev_30_cents,
      (SELECT COUNT(*) FROM crm_orders WHERE completed_at >= ? AND is_preorder = 1) AS preorders_30`)
    .bind(ago(30), ago(90), ago(365), ago(60), ago(180), ago(30), new Date(now).getMonth() + 1, ago(365), ago(365),
      ago(30), ago(30), ago(60), ago(30), ago(60), ago(30), ago(30)).first();
  const { results: categories = [] } = await db.prepare(`SELECT category_group AS grp, SUM(net_cents) AS cents, COUNT(DISTINCT customer_id) AS customers
    FROM crm_lines WHERE sold_at >= ? AND returned = 0 GROUP BY category_group ORDER BY cents DESC`).bind(ago(90)).run();
  const { results: brands = [] } = await db.prepare(`SELECT l.brand_id AS id, COALESCE(b.name, 'Unknown') AS name, SUM(l.net_cents) AS cents,
    COUNT(DISTINCT l.customer_id) AS customers FROM crm_lines l LEFT JOIN crm_brands b ON b.id = l.brand_id
    WHERE l.sold_at >= ? AND l.returned = 0 AND l.brand_id IS NOT NULL GROUP BY l.brand_id ORDER BY cents DESC LIMIT 10`).bind(ago(90)).run();
  const { results: sync = [] } = await db.prepare('SELECT source, since, caught_up_at, updated_at FROM crm_sync_state').bind().run();
  // What is actually stored, by sale date (the sync cursor follows GrowFlow's last-edited time instead).
  const loaded = await db.prepare(`SELECT (SELECT COUNT(*) FROM crm_orders) AS orders, (SELECT COUNT(*) FROM crm_lines) AS lines,
    (SELECT MAX(sold_at) FROM crm_lines) AS lines_through`).bind().first();
  return { totals, categories, brands, sync, loaded, now };
}

// The best-selling brands over 90 days, with GrowFlow brand IDs for segment rules.
export async function topBrands(env, now, limit = 40) {
  const { results = [] } = await env.CRM_DB.prepare(`SELECT l.brand_id AS id, COALESCE(b.name, 'Unknown') AS name,
    SUM(l.net_cents) AS cents, COUNT(DISTINCT l.customer_id) AS buyers FROM crm_lines l LEFT JOIN crm_brands b ON b.id = l.brand_id
    WHERE l.sold_at >= ? AND l.returned = 0 AND l.brand_id IS NOT NULL GROUP BY l.brand_id ORDER BY cents DESC LIMIT ?`)
    .bind(now - 90 * DAY, limit).run();
  return results;
}
