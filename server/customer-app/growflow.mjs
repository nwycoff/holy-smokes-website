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
      id name brand strain cannabisType category categoryId image description uom
      unitWeight unitWeightUOM netWeight netWeightUOM
      variants { weight uom price }
      packages { id inventoryQty isSellable storageLocation
        testResults { uom totalPotentialPsychoactiveThc cbd }
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
// These are refused before GrowFlow runs the operation, so nothing was written.
const REFUSED = ['PERMISSION', 'AUTH', 'VALIDATION', 'PREORDERS_OFF'];
// Errors marked sent=true happened after the request left, so a write may have landed.
export async function queryGrowflow(env, deps, query, variables, token = env.APP_GROWFLOW_TOKEN, timeoutMs = 10000) {
  const key = await hash(env.APP_LIMIT_SECRET, `growflow:${env.GROWFLOW_ORG}`);
  const backoff = await env.APP_DB.prepare('SELECT until_at FROM rewards_backoff WHERE key = ?').bind(key).first();
  if (backoff?.until_at > deps.now()) throw new AppError('GROWFLOW_BACKOFF');
  if (!await consumeLimits(env.APP_DB, env.APP_LIMIT_SECRET,
    [{ subject: 'app-growflow', window: 60000, max: 30 }], deps.now())) throw new AppError('GROWFLOW_LIMIT', 429);
  try {
    return await sendGrowflow(env, deps, key, query, variables, token, timeoutMs);
  } catch (error) {
    const failure = error instanceof AppError ? error : new AppError('GROWFLOW_HTTP');
    if (!(error instanceof AppError)) failure.category = error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
    // A 429 or a refused operation was not processed; anything else may have reached GrowFlow.
    failure.sent = failure.code !== 'GROWFLOW_RATE_LIMITED' && !REFUSED.includes(failure.category);
    throw failure;
  }
}
async function sendGrowflow(env, deps, key, query, variables, token, timeoutMs) {
  const res = await fetchSafe(deps, `https://retail.growflow.com/c/${env.GROWFLOW_ORG}/graphql`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  }, timeoutMs);
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
    throw failure;
  }
  const payload = await res.json();
  if (payload.errors?.length || !payload.data) {
    const failure = new AppError('GROWFLOW_QUERY');
    failure.category = graphqlCategory(payload.errors);
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
// Percentage lab results across the eligible packages, as [min, max]; null unless every
// package reports a valid percentage (conflicting tests show as a range).
function potencyRange(packages, field) {
  const values = packages.map(p => {
    const t = p.testResults, v = t?.[field];
    return ['%', 'percent', 'percentage', 'pct'].includes(normalized(t?.uom))
      && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  });
  return values.length && values.every(v => v !== null) ? [Math.min(...values), Math.max(...values)] : null;
}
const GRAMS = { g: 1, gram: 1, grams: 1, gr: 1, oz: 28.3495, ounce: 28.3495, ounces: 28.3495 };
const GRAMS_PER = { grams: 1, g: 1, milligrams: 0.001, mg: 0.001, oz: 28.3495 };

// Purchase-limit groups, matching the store's Medical Purchase Limits in GrowFlow (which the
// API does not expose). OMMA does not separate liquid edibles, so they count as edibles.
// `measure` follows the store setting: unit weight, net weight, or a count.
export const LIMIT_GROUPS = {
  flower: { label: 'flower', unit: 'g', measure: 'unit' },
  concentrate: { label: 'concentrate', unit: 'g', measure: 'unit' },
  edible: { label: 'edible', unit: 'oz', measure: 'net' },
  topical: { label: 'topical', unit: 'oz', measure: 'unit' },
  seed: { label: 'seed', unit: 'each', measure: 'count' },
  clone: { label: 'clone', unit: 'each', measure: 'count' }
};
const GROUP_PATTERNS = [
  ['seed', /\bseeds?\b/], ['clone', /\bclones?\b|immature plant/],
  ['topical', /topical|lotion|balm|salve|transdermal|\bpatch/],
  ['edible', /edible|gumm|chocolate|candy|candies|beverage|drink|soda|baked|cookie|brownie|\bmints?\b|syrup|capsule/],
  ['concentrate', /concentrate|extract|vape|vapor|cartridge|\bcarts?\b|\bpods?\b|wax|shatter|resin|rosin|badder|budder|crumble|distillate|\bdabs?\b|kief|hash|\brso\b|diamonds?|sauce|sugar|terp/],
  ['flower', /flower|pre-?rolls?|joints?|blunts?|\bbuds?\b|shake|smalls|\btrim\b|usable|moon ?rocks?/]
];
// GrowFlow's category Type decides when known; otherwise the category name.
// Gear and non-cannabis items (e.g. "Dab Accessories", "Batteries / Pens") never count toward
// a cannabis limit, even when their name mentions a product type.
const NOT_CANNABIS = /accessor|\bpapers?\b|\bwraps?\b|\bpipes?\b|\bbongs?\b|\brigs?\b|torch|butane|banger|\bbowls?\b|carb cap|burner|apparel|nicotine|batter(y|ies)|grinder|lighter|rolling tray|\bmerch/;
export function limitGroup(type, name) {
  for (const text of [type, name].map(v => String(v || '').toLowerCase()).filter(Boolean)) {
    if (NOT_CANNABIS.test(text)) return null;
    for (const [group, pattern] of GROUP_PATTERNS) if (pattern.test(text)) return group;
  }
  return null;
}
function limitUse(group, product, variant) {
  if (!group) return null;
  const spec = LIMIT_GROUPS[group];
  if (spec.measure === 'count') return 1;
  const [amount, uom] = spec.measure === 'net' ? [product.netWeight, product.netWeightUOM] : [product.unitWeight, product.unitWeightUOM];
  const perUnit = GRAMS_PER[normalized(uom)];
  const grams = spec.measure === 'unit' && variant.grams ? variant.grams
    : Number.isFinite(amount) && amount > 0 && perUnit ? amount * perUnit : null;
  if (!grams) return null; // Unknown weight: left to the POS, which enforces limits at checkout.
  return Math.round((spec.unit === 'oz' ? grams / 28.3495 : grams) * 1000) / 1000;
}
// Product photos come from GrowFlow; only plain https image URLs are passed to the app.
function imageUrl(value) {
  try {
    const url = new URL(clean(value));
    return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 500 ? url.href : null;
  } catch { return null; }
}
const plainText = value => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) : '';
export function normalizeMenu(input, location, now, categoryTypes = new Map()) {
  if (!input || !Array.isArray(input.menuGroups) || typeof input.pricesIncludeTax !== 'boolean'
    || !clean(location)) throw new AppError('MENU_SHAPE');
  const seen = new Set(), products = [], categories = [];
  for (const group of input.menuGroups) {
    if (!group || !Array.isArray(group.products) || typeof group.name !== 'string') throw new AppError('MENU_SHAPE');
    const category = clean(group.name).replace(/^Screen\s*\d+\s*[-–—:]\s*/i, '') || 'More products';
    for (const p of group.products) {
      if (!p || typeof p.id !== 'string' || !clean(p.name)) throw new AppError('MENU_SHAPE');
      if (seen.has(p.id)) continue;
      // inventoryBackedMenu supplies eligible quantities and normalized location flags.
      // This guard also supports legacy/demo callers that pass menu packages directly.
      const eligiblePackages = (Array.isArray(p.packages) ? p.packages : []).filter(pkg =>
        pkg?.isSellable === true && (pkg.storageLocation === null
          || (typeof pkg.storageLocation === 'string' && normalized(pkg.storageLocation) === normalized(location)))
        && typeof pkg.inventoryQty === 'number' && Number.isFinite(pkg.inventoryQty) && pkg.inventoryQty > 0);
      if (!eligiblePackages.length) continue;
      const variants = (Array.isArray(p.variants) ? p.variants : []).filter(v => v
        && Number.isSafeInteger(v.price) && v.price >= 0).map(v => {
        const weighed = Number.isFinite(v.weight) && v.weight > 0 && clean(v.uom);
        const grams = weighed && GRAMS[normalized(v.uom)] ? v.weight * GRAMS[normalized(v.uom)] : null;
        return { priceCents: v.price, size: weighed ? `${v.weight} ${clean(v.uom)}` : 'Each', weight: weighed ? v.weight : null,
          grams: grams ? Math.round(grams * 100) / 100 : null, pricePerGramCents: grams ? Math.round(v.price / grams) : null };
      });
      // Eligible stock: package quantities are units for "Each" products and grams for
      // "Grams" products. A size is orderable only while stock covers at least one of it.
      const stockUnits = eligiblePackages.reduce((sum, pkg) => sum + pkg.inventoryQty, 0);
      const byWeight = normalized(p.uom) === 'grams';
      const stocked = variants.map(v => {
        const per = byWeight && v.grams ? v.grams : 1;
        return { ...v, unitsEach: per, available: Math.floor(stockUnits / per + 1e-9) };
      }).filter(v => v.available >= 1);
      if (!stocked.length) continue;
      const group = limitGroup(categoryTypes.get(p.categoryId), p.category);
      for (const v of stocked) v.limitUse = limitUse(group, p, v);
      variants.splice(0, variants.length, ...stocked);
      seen.add(p.id);
      if (!categories.includes(category)) categories.push(category);
      const flower = /flower|smalls|top shelf/i.test(`${p.category} ${category}`);
      const thc = potencyRange(eligiblePackages, 'totalPotentialPsychoactiveThc'), cbd = potencyRange(eligiblePackages, 'cbd');
      products.push({ id: p.id, name: flower ? clean(p.strain) || clean(p.name) : clean(p.name),
        packageIds: [...new Set((p.packages || []).map(pkg => pkg.id).filter(Boolean))],
        brand: clean(p.brand), category, sourceCategory: clean(p.category), flower, type: ['indica', 'sativa', 'hybrid'].includes(normalized(p.cannabisType))
          ? normalized(p.cannabisType) : '', variants, thc, cbd,
        // CBD-rich: tested CBD at least 1% and at least equal to THC (CBD-dominant or balanced).
        cbdRich: Boolean(cbd && cbd[1] >= 1 && cbd[1] >= (thc ? thc[1] : 0)),
        image: imageUrl(p.image), description: plainText(p.description), stockUnits, limitGroup: group });
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
    && Number.isFinite(n.PointsNeeded) && n.PointsNeeded > 0 && Number.isSafeInteger(n.Amount) && n.Amount > 0)
    .map(n => ({ id: n.objectId, name: clean(n.Name), points: n.PointsNeeded,
      // Amount is in cents, like menu prices (a $10.00 reward is 1000). Confirmed against the
      // live store. Percentage rewards are listed but never turned into a dollar estimate.
      amountCents: /percent/i.test(String(n.Type || '')) ? null : n.Amount,
      type: clean(n.Type) }))
    .sort((a, b) => a.points - b.points);
  return { tiers, updatedAt: now };
}
export async function getRewards(env, deps) {
  const key = await hash(env.APP_LIMIT_SECRET, `rewards:v2-cents:${env.GROWFLOW_ORG}:${env.APP_GROWFLOW_TOKEN}`);
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

// What customers see: exact inventory stays on the server. Availability is capped at 10,
// the most one order can hold, so the app can limit quantities without revealing stock.
export function publicMenu(menu) {
  return { ...menu, products: menu.products.map(({ stockUnits, packageIds, ...p }) => ({ ...p,
    variants: p.variants.map(({ unitsEach, available, ...v }) => ({ ...v, available: Math.min(available, 10) })) })) };
}
// Product category Types (e.g. "Flower", "Edible") for purchase limits. Needs the Product
// categories read scope; without it, or on any failure, names are used instead. Cached an hour.
export const CATEGORIES_QUERY = `query TreehouseCategoryTypes {
  findProductCategories(first: 100) { edges { node { objectId Type } } }
}`;
export async function getCategoryTypes(env, deps) {
  const key = await hash(env.APP_LIMIT_SECRET, `categories:v1:${env.GROWFLOW_ORG}:${env.APP_GROWFLOW_TOKEN}`);
  const cached = await env.APP_DB.prepare('SELECT value, updated_at FROM app_cache WHERE key = ?').bind(key).first();
  if (cached && deps.now() - cached.updated_at < 3600000) return new Map(JSON.parse(cached.value));
  let pairs = cached ? JSON.parse(cached.value) : [];
  try {
    const edges = (await queryGrowflow(env, deps, CATEGORIES_QUERY, {}))?.findProductCategories?.edges;
    if (!Array.isArray(edges)) throw new AppError('CATEGORIES_SHAPE');
    pairs = edges.map(e => e?.node).filter(n => typeof n?.objectId === 'string' && typeof n.Type === 'string')
      .map(n => [n.objectId, clean(n.Type)]);
  } catch (error) {
    deps.report(`CATEGORIES_REFRESH${error?.category ? `_${error.category}` : ''}`);
  }
  // Store even an empty result so a missing scope is retried hourly, not every refresh.
  await env.APP_DB.prepare(`INSERT INTO app_cache(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, JSON.stringify(pairs), deps.now()).run();
  return new Map(pairs);
}

// The store's per-order limits: defaults match GrowFlow's Medical Purchase Limits, and
// APP_PURCHASE_LIMITS (JSON, e.g. {"flower":84}) overrides any group's maximum.
export function purchaseLimits(env) {
  if (env.APP_PURCHASE_LIMITS_ENABLED !== 'true') return null;
  let overrides = {};
  try { overrides = JSON.parse(env.APP_PURCHASE_LIMITS || '{}') || {}; } catch { overrides = {}; }
  const defaults = { flower: 84, concentrate: 28, edible: 72, topical: 72, seed: 10, clone: 6 };
  return Object.fromEntries(Object.entries(LIMIT_GROUPS).map(([group, spec]) => [group, { ...spec,
    max: Number.isFinite(overrides[group]) && overrides[group] >= 0 ? overrides[group] : defaults[group] }]));
}
export async function getMenu(env, deps) {
  const key = await hash(env.APP_LIMIT_SECRET,
    `menu:v8-authoritative-inventory:${env.GROWFLOW_ORG}:${env.APP_MENU_KEY}:${env.APP_FRONT_LOCATION}:${inventoryStore(env)}:${env.APP_GROWFLOW_TOKEN}`);
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
    // The full menu (hundreds of products with photos and weights) can take GrowFlow a while.
    const result = await queryGrowflow(env, deps, MENU_QUERY, { menuKey: env.APP_MENU_KEY }, env.APP_GROWFLOW_TOKEN, 25000);
    const types = purchaseLimits(env) ? await getCategoryTypes(env, deps) : new Map();
    const checked = await inventoryBackedMenu(result.findMenus, env, deps);
    const menu = normalizeMenu(checked, env.APP_FRONT_LOCATION, deps.now(), types);
    // A small public summary (no stock levels or prices) for the CRM's campaign assistant.
    const summary = { updatedAt: menu.updatedAt, categories: menu.categories,
      products: menu.products.map(p => ({ id: p.id, name: p.name, brand: p.brand, category: p.category })) };
    const save = (k, v) => env.APP_DB.prepare(`INSERT INTO app_cache(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(k, JSON.stringify(v), deps.now());
    await env.APP_DB.batch([save(key, menu), save('menu:summary', summary)]);
    return menu;
  } catch (error) {
    deps.report(`MENU_REFRESH_${error?.code || 'ERROR'}${error?.category ? `_${error.category}` : ''}`);
    return fallback();
  }
}



// Store object ID verified against the owner's inventory diagnostic on 2026-10-07.
// Explicit store scoping prevents similarly named rooms at another store contributing stock.
export const inventoryStore = env => env.APP_INVENTORY_STORE_ID || 'nhB4pzbWYZ';
export const INVENTORY_QUERY = `query TreehouseSellableInventory($where: InventoryWhereInput!, $after: String) {
  findInventory(first: 100, where: $where, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { objectId Qty StorageLocation Package { objectId } } }
  }
}`;
export async function readSellableInventory(ids, env, deps) {
  const unique = [...new Set(ids)];
  if (!clean(env.APP_FRONT_LOCATION) || unique.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))
    throw new AppError('INVENTORY_SHAPE');
  const quantities = new Map(unique.map(id => [id, 0])), seen = new Set();
  let requests = 0;
  for (let start = 0; start < unique.length; start += 100) {
    const batch = unique.slice(start, start + 100), cursors = new Set();
    let after = null;
    do {
      if (++requests > 30) throw new AppError('INVENTORY_PAGE_LIMIT');
      const data = await queryGrowflow(env, deps, INVENTORY_QUERY, {
        where: { Package: { have: { objectId: { in: batch } } },
          Store: { have: { objectId: { equalTo: inventoryStore(env) } } } }, after
      });
      const page = data?.findInventory;
      if (!Array.isArray(page?.edges) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new AppError('INVENTORY_SHAPE');
      for (const { node: row } of page.edges) {
        if (!row || typeof row.objectId !== 'string' || seen.has(row.objectId) || !batch.includes(row.Package?.objectId)
          || !Number.isFinite(row.Qty)) throw new AppError('INVENTORY_SHAPE');
        seen.add(row.objectId);
        const location = row.StorageLocation;
        // Owner policy: unknown/unassigned sellability is allowed; explicit false is excluded.
        // Query is store-scoped; reject any contradictory embedded store identity.
        if (location?.IsSellable === false || location?.IsDeleted === true
          || location?.IsWaste === true || location?.IsReturn === true
          || (location?.Store?.objectId && location.Store.objectId !== inventoryStore(env))) continue;
        const id = row.Package.objectId;
        quantities.set(id, quantities.get(id) + row.Qty);
      }
      if (!page.pageInfo.hasNextPage) break;
      const next = page.pageInfo.endCursor;
      if (typeof next !== 'string' || !next || cursors.has(next)) throw new AppError('INVENTORY_PAGINATION');
      cursors.add(next); after = next;
    } while (true);
  }
  return new Map([...quantities].map(([id,qty]) => [id, Math.max(0,qty)]));
}
export async function inventoryBackedMenu(menu, env, deps) {
  if (!Array.isArray(menu?.menuGroups)) throw new AppError('MENU_SHAPE');
  const ids = [];
  for (const group of menu.menuGroups) {
    if (!Array.isArray(group.products)) throw new AppError('MENU_SHAPE');
    for (const product of group.products) {
      if (!Array.isArray(product.packages)) throw new AppError('MENU_SHAPE');
      for (const pkg of product.packages) ids.push(pkg.id);
    }
  }
  const quantities = await readSellableInventory(ids, env, deps);
  return { ...menu, menuGroups: menu.menuGroups.map(group => ({ ...group, products: group.products.map(product => {
    const seen = new Set();
    return { ...product, packages: product.packages.filter(pkg => {
      if (seen.has(pkg.id)) return false;
      seen.add(pkg.id); return true;
    }).map(pkg => ({ ...pkg, inventoryQty: quantities.get(pkg.id) || 0,
      storageLocation: env.APP_FRONT_LOCATION, isSellable: (quantities.get(pkg.id) || 0) > 0 })) };
  }) })) };
}
export async function verifyPreorderInventory(menu, drawn, env, deps) {
  const products = [...drawn.keys()].map(id => menu.products.find(p => p.id === id));
  if (products.some(p => !Array.isArray(p?.packageIds) || !p.packageIds.length)) throw new AppError('INVENTORY_UNAVAILABLE');
  const quantities = await readSellableInventory(products.flatMap(p => p.packageIds), env, deps);
  for (const product of products) {
    const available = [...new Set(product.packageIds)].reduce((sum,id) => sum + (quantities.get(id) || 0), 0);
    if (drawn.get(product.id) > available + 1e-9) throw new AppError('OUT_OF_STOCK', 409);
  }
}
