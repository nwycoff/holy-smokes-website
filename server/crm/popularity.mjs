// "Most popular" for the app and tablet menus: how often each product sold in the last 30 days
// (returns excluded), published hourly from the CRM to the app database as a rank only, never
// counts or customers. Runs in the CRM sync Worker, which can read both databases.
const DAY = 86400000;
export const POPULARITY_KEY = 'menu:popularity';
const EVERY = 3600000, WINDOW = 30 * DAY;

export async function publishPopularity(env, now) {
  if (!env.APP_DB || !env.CRM_DB) return false;
  const cached = await env.APP_DB.prepare('SELECT updated_at FROM app_cache WHERE key = ?').bind(POPULARITY_KEY).first();
  if (cached && now - cached.updated_at < EVERY) return false;
  const { results = [] } = await env.CRM_DB.prepare(`SELECT product_id FROM crm_lines
    WHERE sold_at >= ? AND returned = 0 AND product_id IS NOT NULL
    GROUP BY product_id ORDER BY COUNT(*) DESC, product_id LIMIT 3000`).bind(now - WINDOW).run();
  const ranks = Object.fromEntries(results.map((row, i) => [row.product_id, i + 1]));
  await env.APP_DB.prepare(`INSERT INTO app_cache(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(POPULARITY_KEY, JSON.stringify({ updatedAt: now, ranks }), now).run();
  return true;
}
