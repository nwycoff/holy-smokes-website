import { consumeLimits } from '../rewards.mjs';
import { AppError, fetchSafe, hash } from './http.mjs';

// Contracts checked against the supplied retailGraphQLSchema.graphql. Live
// permission/field checks and POS price comparison are required before enabling.
export const CUSTOMER_QUERY = `query TreehouseAccountPoints($where: CustomersWhereInput!) {
  findCustomers(where: $where, first: 2) {
    pageInfo { hasNextPage } edges { node { objectId CurrentPoints } }
  }
}`;
export const MENU_QUERY = `query TreehouseMobileMenu($menuKey: String!) {
  findMenus(menuKey: $menuKey) {
    pricesIncludeTax
    menuGroups { name products {
      id name brand strain cannabisType category
      variants { weight uom price }
      packages { inventoryQty isSellable storageLocation
        testResults { uom totalPotentialPsychoactiveThc }
      }
    } }
  }
}`;
// Preorders use a separate token limited to creating preorders and reading their status.
export const PREORDER_CUSTOMER_QUERY = `query TreehousePreorderCustomer($where: CustomersWhereInput!) {
  findCustomers(where: $where, first: 2) {
    pageInfo { hasNextPage } edges { node { objectId Name Birthday CustomerType CurrentPoints
      CustomerStateLicenseExpiration LicenseEffectiveEndDate } }
  }
}`;
export const CREATE_PREORDER = `mutation TreehouseCreatePreorder($menuKey: String!, $preorder: PreorderInput!) {
  createPreorder(menuKey: $menuKey, preorder: $preorder) { success order { id orderNumber status } }
}`;
export const PREORDER_STATUS = `query TreehousePreorderStatus($orderId: String!) {
  preorderStatus(orderId: $orderId) { success order { id orderNumber status } }
}`;
// Fixed diagnostic categories only; GrowFlow's raw error text is never logged.
function graphqlCategory(errors) {
  const text = (errors || []).map(e => `${e?.message || ''} ${e?.extensions?.code || ''}`).join(' ');
  if (!text.trim()) return 'NO_DATA';
  if (/insufficient permissions|forbidden/i.test(text)) return 'PERMISSION';
  if (/unauthenticated|invalid or revoked/i.test(text)) return 'AUTH';
  if (/GRAPHQL_VALIDATION_FAILED|GRAPHQL_PARSE_FAILED|BAD_USER_INPUT|variable "\$|unknown argument|cannot query field|expected type|got invalid value/i.test(text))
    return 'VALIDATION';
  // Store/menu settings that switch preorders off; GrowFlow refuses before creating anything.
  if (/pre-?orders? (are|is) not (allowed|enabled)/i.test(text)) return 'PREORDERS_OFF';
  if (/not found/i.test(text)) return 'NOT_FOUND';
  return 'OTHER';
}
// TEST PROJECT ONLY: APP_DIAGNOSTIC_ERRORS=true also logs GrowFlow's error text with digits
// masked and length capped. Never enable it on the live site; remove it after diagnosis.
export function errorDetail(errors) {
  return (errors || []).slice(0, 3).map(e => `${String(e?.extensions?.code || '-')}: ${String(e?.message || '')}`)
    .join(' | ').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\d/g, '#').slice(0, 200);
}
// These are refused before GrowFlow runs the operation, so nothing was written.
const REFUSED = ['PERMISSION', 'AUTH', 'VALIDATION', 'PREORDERS_OFF'];
// Errors marked sent=true happened after the request left, so a write may have landed.
export async function queryGrowflow(env, deps, query, variables, token = env.APP_GROWFLOW_TOKEN) {
  const key = await hash(env.APP_LIMIT_SECRET, `growflow:${env.GROWFLOW_ORG}`);
  const backoff = await env.APP_DB.prepare('SELECT until_at FROM rewards_backoff WHERE key = ?').bind(key).first();
  if (backoff?.until_at > deps.now()) throw new AppError('GROWFLOW_BACKOFF');
  if (!await consumeLimits(env.APP_DB, env.APP_LIMIT_SECRET,
    [{ subject: 'app-growflow', window: 60000, max: 30 }], deps.now())) throw new AppError('GROWFLOW_LIMIT', 429);
  try {
    return await sendGrowflow(env, deps, key, query, variables, token);
  } catch (error) {
    const failure = error instanceof AppError ? error : new AppError('GROWFLOW_HTTP');
    if (!(error instanceof AppError)) failure.category = error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
    // A 429 or a refused operation was not processed; anything else may have reached GrowFlow.
    failure.sent = failure.code !== 'GROWFLOW_RATE_LIMITED' && !REFUSED.includes(failure.category);
    throw failure;
  }
}
async function sendGrowflow(env, deps, key, query, variables, token) {
  const res = await fetchSafe(deps, `https://retail.growflow.com/c/${env.GROWFLOW_ORG}/graphql`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const remaining = res.headers.has('ratelimit-remaining') ? Number(res.headers.get('ratelimit-remaining')) : Infinity;
  if (res.status === 429 || (Number.isFinite(remaining) && remaining <= 20)) {
    const reset = Number(res.headers.get('ratelimit-reset'));
    const retry = res.headers.get('retry-after') || '';
    const retryMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - deps.now();
    const delay = Math.max(60000, Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0,
      Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 0);
    await env.APP_DB.prepare(`INSERT INTO rewards_backoff(key, until_at) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET until_at = MAX(until_at, excluded.until_at)`)
      .bind(key, deps.now() + delay).run();
  }
  if (res.status === 429) throw new AppError('GROWFLOW_RATE_LIMITED');
  if (!res.ok) {
    let errors = null;
    try { errors = (await res.json())?.errors; } catch { /* Non-JSON bodies stay unclassified. */ }
    // A validation or permission refusal (e.g. HTTP 400 BAD_USER_INPUT) means nothing ran.
    const refused = errors ? graphqlCategory(errors) : '';
    const failure = new AppError('GROWFLOW_HTTP');
    failure.category = REFUSED.includes(refused) ? refused : `STATUS_${res.status}`;
    if (env.APP_DIAGNOSTIC_ERRORS === 'true')
      deps.report(`GROWFLOW_ERROR_DETAIL HTTP ${res.status} ${errorDetail(errors) || '(no GraphQL errors in body)'}`);
    throw failure;
  }
  const payload = await res.json();
  if (payload.errors?.length || !payload.data) {
    const failure = new AppError('GROWFLOW_QUERY');
    failure.category = graphqlCategory(payload.errors);
    if (env.APP_DIAGNOSTIC_ERRORS === 'true') deps.report(`GROWFLOW_ERROR_DETAIL ${errorDetail(payload.errors)}`);
    throw failure;
  }
  return payload.data;
}
export function singleCustomer(data) {
  const c = data?.findCustomers;
  if (!Array.isArray(c?.edges) || typeof c.pageInfo?.hasNextPage !== 'boolean') throw new AppError('CUSTOMER_SHAPE');
  if (c.edges.length !== 1 || c.pageInfo.hasNextPage) return null;
  const row = c.edges[0]?.node;
  if (!row || typeof row.objectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.objectId)) return null;
  return row;
}
export const eligibleCustomer = where => ({ ...where, IsDeleted: { notEqualTo: true },
  IsAnon: { notEqualTo: true }, Disabled: { notEqualTo: true }, Active: { notEqualTo: false } });

const clean = value => typeof value === 'string' ? value.trim().slice(0, 250) : '';
const normalized = value => clean(value).toLocaleLowerCase('en-US');
function thcRange(packages) {
  const values = packages.map(p => {
    const t = p.testResults;
    return ['%', 'percent', 'percentage', 'pct'].includes(normalized(t?.uom))
      && typeof t?.totalPotentialPsychoactiveThc === 'number'
      && Number.isFinite(t.totalPotentialPsychoactiveThc) && t.totalPotentialPsychoactiveThc >= 0
      && t.totalPotentialPsychoactiveThc <= 100 ? t.totalPotentialPsychoactiveThc : null;
  });
  return values.length && values.every(v => v !== null) ? [Math.min(...values), Math.max(...values)] : null;
}
export function normalizeMenu(input, location, now) {
  if (!input || !Array.isArray(input.menuGroups) || typeof input.pricesIncludeTax !== 'boolean'
    || !clean(location)) throw new AppError('MENU_SHAPE');
  const seen = new Set(), products = [], categories = [];
  for (const group of input.menuGroups) {
    if (!group || !Array.isArray(group.products) || typeof group.name !== 'string') throw new AppError('MENU_SHAPE');
    const category = clean(group.name).replace(/^Screen\s*\d+\s*[-–—:]\s*/i, '') || 'More products';
    for (const p of group.products) {
      if (!p || typeof p.id !== 'string' || !clean(p.name)) throw new AppError('MENU_SHAPE');
      if (seen.has(p.id)) continue;
      // Include the configured front room and explicitly unassigned legacy packages.
      // Missing/malformed fields never fall back to aggregate inventory.
      const eligiblePackages = (Array.isArray(p.packages) ? p.packages : []).filter(pkg =>
        pkg?.isSellable === true && (pkg.storageLocation === null
          || (typeof pkg.storageLocation === 'string' && normalized(pkg.storageLocation) === normalized(location)))
        && typeof pkg.inventoryQty === 'number' && Number.isFinite(pkg.inventoryQty) && pkg.inventoryQty > 0);
      if (!eligiblePackages.length) continue;
      const variants = (Array.isArray(p.variants) ? p.variants : []).filter(v => v
        && Number.isSafeInteger(v.price) && v.price >= 0).map(v => {
        const weighed = Number.isFinite(v.weight) && v.weight > 0 && clean(v.uom);
        return { priceCents: v.price, size: weighed ? `${v.weight} ${clean(v.uom)}` : 'Each', weight: weighed ? v.weight : null };
      });
      if (!variants.length) continue;
      seen.add(p.id);
      if (!categories.includes(category)) categories.push(category);
      const flower = /flower|smalls|top shelf/i.test(`${p.category} ${category}`);
      products.push({ id: p.id, name: flower ? clean(p.strain) || clean(p.name) : clean(p.name),
        brand: clean(p.brand), category, type: ['indica', 'sativa', 'hybrid'].includes(normalized(p.cannabisType))
          ? normalized(p.cannabisType) : '', variants, thc: thcRange(eligiblePackages) });
    }
  }
  products.sort((a, b) => Math.min(...a.variants.map(v => v.priceCents)) - Math.min(...b.variants.map(v => v.priceCents))
    || a.name.localeCompare(b.name));
  return { products, categories, pricesIncludeTax: input.pricesIncludeTax, updatedAt: now, stale: false };
}

// Loyalty reward tiers are GrowFlow discounts with IsLoyaltyDiscount set. Needs the Discounts
// read scope on APP_GROWFLOW_TOKEN. Rewards are applied by staff at checkout, not by the API.
export const REWARDS_QUERY = `query TreehouseRewardTiers {
  findDiscounts(first: 50, where: { IsLoyaltyDiscount: { equalTo: true }, Active: { equalTo: true },
    IsDeleted: { notEqualTo: true } }) {
    edges { node { objectId Name PointsNeeded Amount Type } }
  }
}`;
export function normalizeRewards(data, now) {
  const edges = data?.findDiscounts?.edges;
  if (!Array.isArray(edges)) throw new AppError('REWARDS_SHAPE');
  const tiers = edges.map(e => e?.node).filter(n => n && typeof n.objectId === 'string'
    && /^[A-Za-z0-9_-]{1,64}$/.test(n.objectId) && clean(n.Name)
    && Number.isFinite(n.PointsNeeded) && n.PointsNeeded > 0 && Number.isFinite(n.Amount) && n.Amount > 0)
    .map(n => ({ id: n.objectId, name: clean(n.Name), points: n.PointsNeeded,
      // Percentage rewards are listed but never turned into a dollar estimate.
      amountCents: /percent/i.test(String(n.Type || '')) ? null : Math.round(n.Amount * 100),
      type: clean(n.Type) }))
    .sort((a, b) => a.points - b.points);
  return { tiers, updatedAt: now };
}
export async function getRewards(env, deps) {
  const key = await hash(env.APP_LIMIT_SECRET, `rewards:v1:${env.GROWFLOW_ORG}:${env.APP_GROWFLOW_TOKEN}`);
  const cached = await env.APP_DB.prepare('SELECT value, updated_at FROM app_cache WHERE key = ?').bind(key).first();
  const age = cached ? deps.now() - cached.updated_at : Infinity;
  if (age < 600000) return JSON.parse(cached.value);
  const lock = await env.APP_DB.prepare(`INSERT INTO app_locks(key, expires_at) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at
    WHERE app_locks.expires_at <= ? RETURNING key`).bind(key, deps.now() + 60000, deps.now()).first();
  const fallback = () => { if (age > 3600000) throw new AppError('REWARDS_UNAVAILABLE'); return JSON.parse(cached.value); };
  if (!lock) return fallback();
  try {
    const rewards = normalizeRewards(await queryGrowflow(env, deps, REWARDS_QUERY, {}), deps.now());
    await env.APP_DB.prepare(`INSERT INTO app_cache(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(key, JSON.stringify(rewards), deps.now()).run();
    return rewards;
  } catch (error) {
    deps.report(`REWARDS_REFRESH${error?.category ? `_${error.category}` : ''}`);
    return fallback();
  }
}

export async function getMenu(env, deps) {
  const key = await hash(env.APP_LIMIT_SECRET,
    `menu:v3-front-and-unassigned:${env.GROWFLOW_ORG}:${env.APP_MENU_KEY}:${env.APP_FRONT_LOCATION}:${env.APP_GROWFLOW_TOKEN}`);
  const cached = await env.APP_DB.prepare('SELECT value, updated_at FROM app_cache WHERE key = ?').bind(key).first();
  const age = cached ? deps.now() - cached.updated_at : Infinity;
  const fallback = () => {
    if (age > 300000) throw new AppError('MENU_UNAVAILABLE');
    return { ...JSON.parse(cached.value), stale: true };
  };
  if (age < 60000) return JSON.parse(cached.value);
  // Database lock limits the whole app to one menu refresh/minute, not one per visitor.
  const lock = await env.APP_DB.prepare(`INSERT INTO app_locks(key, expires_at) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at
    WHERE app_locks.expires_at <= ? RETURNING key`).bind(key, deps.now() + 60000, deps.now()).first();
  if (!lock) return fallback();
  try {
    const result = await queryGrowflow(env, deps, MENU_QUERY, { menuKey: env.APP_MENU_KEY });
    const menu = normalizeMenu(result.findMenus, env.APP_FRONT_LOCATION, deps.now());
    await env.APP_DB.prepare(`INSERT INTO app_cache(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(key, JSON.stringify(menu), deps.now()).run();
    return menu;
  } catch {
    deps.report('MENU_REFRESH');
    return fallback();
  }
}
