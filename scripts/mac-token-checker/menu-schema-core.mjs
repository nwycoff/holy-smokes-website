// Finds where GrowFlow keeps terpene results for the menu, and what an inventory row's
// StorageLocation looks like. Reads type definitions, then (optionally, with the menu key)
// lab results for a few menu products and a few inventory rows. No customer data is requested.
const REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
export const SCHEMA_QUERY = `query TreehouseMenuSchema {
  queryType: __type(name: "Query") { fields { name type { ${REF} } } }
  schema: __schema { types { name kind fields { name type { ${REF} } } } }
}`;
export const TERP = /terp|myrcene|limonene|caryophyllene|linalool|pinene|humulene|ocimene|terpinolene|bisabolol|nerolidol|guaiol|eucalyptol|camphene|geraniol/i;

export function typeName(t) {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${typeName(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeName(t.ofType)}]`;
  return t.name || '?';
}
const named = t => t?.kind === 'NON_NULL' || t?.kind === 'LIST' ? named(t.ofType) : t;
const LEAF = ['SCALAR', 'ENUM'];

// Field path → type, following the schema from a root query field.
function walk(types, rootType, path) {
  let type = types.get(named(rootType)?.name);
  for (const step of path) {
    const field = type?.fields?.find(f => f.name === step);
    if (!field) return null;
    type = types.get(named(field.type)?.name) || named(field.type);
  }
  return type;
}
// A selection set for a type: every leaf field, plus leaf fields one level down.
export function selection(types, type, depth = 1) {
  const parts = [];
  for (const f of type?.fields || []) {
    const inner = named(f.type);
    if (LEAF.includes(inner?.kind)) parts.push(f.name);
    else if (depth > 0 && types.get(inner?.name)?.fields) {
      const sub = selection(types, types.get(inner.name), depth - 1);
      if (sub) parts.push(`${f.name} { ${sub} }`);
    }
  }
  return parts.join(' ');
}

export function readSchema(data) {
  const lines = [], types = new Map((data?.schema?.types || []).map(t => [t.name, t]));
  const query = { fields: data?.queryType?.fields || [] };
  const root = name => query.fields.find(f => f.name === name)?.type;
  const describe = (label, type, depth = 1) => {
    if (!type?.fields) { lines.push(`NOTE  ${label}: ${type ? `${type.kind} ${type.name}` : 'not found'}`); return; }
    lines.push(`TYPE  ${label} (${type.name}): ${type.fields.map(f => `${f.name}: ${typeName(f.type)}`).join(', ')}`);
    if (depth > 0) for (const f of type.fields) {
      const inner = types.get(named(f.type)?.name);
      if (inner?.fields && inner.name !== type.name) describe(`${label}.${f.name}`, inner, depth - 1);
    }
  };
  const tests = walk(types, root('findMenus'), ['menuGroups', 'products', 'packages', 'testResults']);
  describe('Menu package testResults', tests);
  const product = walk(types, root('findMenus'), ['menuGroups', 'products']);
  const productLab = (product?.fields || []).filter(f => TERP.test(f.name) || /lab|test|aroma|flavou?r|effect/i.test(f.name));
  lines.push(productLab.length ? `TYPE  Menu product lab-related fields: ${productLab.map(f => `${f.name}: ${typeName(f.type)}`).join(', ')}`
    : 'NOTE  Menu products have no lab, terpene or flavor fields of their own.');
  const anywhere = [];
  for (const t of types.values()) if (!t.name.startsWith('__')) for (const f of t.fields || [])
    if (TERP.test(f.name)) anywhere.push(`${t.name}.${f.name}: ${typeName(f.type)}`);
  lines.push(anywhere.length ? `TERP  Terpene fields anywhere in the API: ${anywhere.slice(0, 80).join(', ')}${anywhere.length > 80 ? ' …' : ''}`
    : 'TERP  No field anywhere in the API is named after terpenes.');
  const inventory = walk(types, root('findInventory'), ['edges', 'node']);
  const location = inventory?.fields?.find(f => f.name === 'StorageLocation');
  lines.push(location ? `TYPE  Inventory.StorageLocation: ${typeName(location.type)} (${named(location.type)?.kind})`
    : 'NOTE  Inventory has no StorageLocation field.');
  const locationType = types.get(named(location?.type)?.name);
  if (locationType?.fields) describe('Inventory.StorageLocation', locationType, 0);
  return { lines, types, tests, inventory, locationType, hasTerpenes: anywhere.length > 0 };
}

export function sampleQueries(schema) {
  const testSel = schema.tests?.fields ? selection(schema.types, schema.tests) : '';
  const menu = testSel ? `query TreehouseMenuLabSample($menuKey: String!) {
  findMenus(menuKey: $menuKey) { menuGroups { name products { name category packages { id testResults { ${testSel} } } } } }
}` : null;
  const locationSel = schema.locationType?.fields ? ` { ${selection(schema.types, schema.locationType, 0)} }` : '';
  const inventory = `query TreehouseInventorySample { findInventory(first: 8) { edges { node { Qty StorageLocation${locationSel} } } } }`;
  return { menu, inventory };
}

const short = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)} …` : text;
};
const hasData = v => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)
  && !(typeof v === 'object' && !Array.isArray(v) && !Object.values(v).some(hasData));
// Up to `limit` menu products with any terpene-looking result, then a count of how many have one.
export function summarizeMenuSample(data, limit = 6) {
  const lines = [];
  let products = 0, withTerps = 0;
  for (const group of data?.findMenus?.menuGroups || []) for (const p of group.products || []) {
    products++;
    const found = [];
    for (const pkg of p.packages || []) for (const [k, v] of Object.entries(pkg.testResults || {}))
      if ((TERP.test(k) || (typeof v === 'string' && TERP.test(v))) && hasData(v)) found.push(`${k}=${short(v)}`);
    if (!found.length) continue;
    withTerps++;
    if (withTerps <= limit) lines.push(`SAMPLE ${p.name} [${p.category}] ${[...new Set(found)].slice(0, 6).join(' | ')}`);
  }
  const first = (data?.findMenus?.menuGroups || []).flatMap(g => g.products || []).flatMap(p => (p.packages || []).map(pkg => [p.name, pkg.testResults]))
    .find(([, t]) => t && Object.values(t).some(hasData));
  if (first) lines.push(`SAMPLE Full lab result for ${first[0]}: ${short(first[1])}`);
  lines.push(`COUNT  ${withTerps} of ${products} menu products have terpene results.`);
  return lines;
}
export function summarizeInventorySample(data) {
  const rows = (data?.findInventory?.edges || []).map(e => e?.node);
  if (!rows.length) return ['NOTE  No inventory rows returned.'];
  return rows.map(r => `ROOM   Qty ${r?.Qty} · StorageLocation ${short(r?.StorageLocation)}`);
}

export async function runMenuSchemaCheck({ token, menuKey }, { transport, log }) {
  if (!/^gfr_\S+$/.test(token || '')) { log('FAIL  That does not look like a GrowFlow token (starts with gfr_).'); return 1; }
  const call = async (query, variables = {}) => {
    const response = await transport({ token, query, variables, maxBytes: 16777216 });
    if (response.status === 429) throw Object.assign(new Error(), { line: 'STOP  Rate limited. Wait a minute before running again.' });
    let payload; try { payload = JSON.parse(response.body); } catch { payload = null; }
    if (response.status === 401) throw Object.assign(new Error(), { line: 'FAIL  Token rejected (invalid, disabled, expired or revoked).' });
    if (!payload?.data) {
      const text = (payload?.errors || []).map(e => e?.message || '').join(' ');
      throw Object.assign(new Error(), { line: /permission|forbidden/i.test(text) ? 'FAIL  This token lacks a needed read scope (Menus or Packages & inventory).'
        : `FAIL  GrowFlow refused the request (HTTP ${response.status}). No retry.` });
    }
    return payload.data;
  };
  try {
    log('Schema (type definitions only):');
    const schema = readSchema(await call(SCHEMA_QUERY));
    for (const line of schema.lines) log(line);
    const queries = sampleQueries(schema);
    log('');
    log('Inventory rooms (8 rows, quantities and room details only):');
    for (const line of summarizeInventorySample(await call(queries.inventory))) log(line);
    if (menuKey && queries.menu) {
      log('');
      log('Menu lab results (product names and lab values only):');
      for (const line of summarizeMenuSample(await call(queries.menu, { menuKey }))) log(line);
    } else if (!menuKey) log('\nNOTE  Menu sample skipped (no menu key entered).');
    log('');
    log('RESULT Done. Copy the lines above to your developer.');
    return 0;
  } catch (error) {
    log(error?.line || 'FAIL  Unexpected response. No raw errors displayed. No retry.');
    return 1;
  }
}
