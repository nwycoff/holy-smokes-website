// Can the menu show edibles' mg per dose? GrowFlow keeps ServingsPerContainer on full
// Products records, not on menu products. This finds the query that reads Products, then
// looks up a few menu edibles by their menu ID to see whether the IDs match and servings
// are filled in. Product names and serving counts only; no customer data is requested.
const REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
export const SCHEMA_QUERY = `query TreehouseServingsSchema {
  queryType: __type(name: "Query") { fields { name args { name type { ${REF} } } type { ${REF} } } }
  schema: __schema { types { name kind fields { name type { ${REF} } } inputFields { name } } }
}`;
export const MENU_QUERY = `query TreehouseServingsMenu($menuKey: String!) {
  findMenus(menuKey: $menuKey) { menuGroups { products { id name category unitWeight unitWeightUOM } } }
}`;
const SAMPLE = 10;

const named = t => t?.kind === 'NON_NULL' || t?.kind === 'LIST' ? named(t.ofType) : t?.name;
const typeName = t => !t ? '?' : t.kind === 'NON_NULL' ? `${typeName(t.ofType)}!` : t.kind === 'LIST' ? `[${typeName(t.ofType)}]` : t.name || '?';

// The Query field returning a connection of Products (edges { node: Products }), and what it accepts.
export function findProductsQuery(data) {
  const lines = [], types = new Map((data?.schema?.types || []).map(t => [t.name, t]));
  const nodeOf = field => {
    const edges = types.get(named(field.type))?.fields?.find(f => f.name === 'edges');
    return named(types.get(named(edges?.type))?.fields?.find(f => f.name === 'node')?.type);
  };
  const field = (data?.queryType?.fields || []).find(f => nodeOf(f) === 'Products');
  if (!field) { lines.push('FAIL  No query in the API returns Products records.'); return { lines }; }
  lines.push(`TYPE  ${field.name}(${(field.args || []).map(a => `${a.name}: ${typeName(a.type)}`).join(', ')})`);
  const whereArg = (field.args || []).find(a => a.name === 'where');
  const filters = (types.get(named(whereArg?.type))?.inputFields || []).map(f => f.name);
  const fields = (types.get('Products')?.fields || []).map(f => f.name);
  const ok = Boolean(whereArg && filters.includes('objectId') && fields.includes('objectId') && fields.includes('ServingsPerContainer'));
  lines.push(ok ? `OK    ${field.name} can look products up by objectId and read ServingsPerContainer.`
    : `FAIL  ${field.name} can't look products up by objectId (where: ${filters.slice(0, 30).join(', ') || 'none'}).`);
  const required = (field.args || []).filter(a => a.type?.kind === 'NON_NULL' && !['where', 'first'].includes(a.name));
  if (required.length) lines.push(`NOTE  Also requires: ${required.map(a => a.name).join(', ')}`);
  return { lines, name: ok && !required.length ? field.name : null, hasName: fields.includes('Name'),
    hasFirst: (field.args || []).some(a => a.name === 'first'), whereType: named(whereArg?.type) };
}
// The whole filter goes in as one variable (as the website's inventory lookup does), so
// GrowFlow's own ID type applies to the list.
export const productsQuery = ({ name, hasName, hasFirst, whereType }) => `query TreehouseServingsSample($where: ${whereType}!) {
  ${name}(${hasFirst ? `first: ${SAMPLE}, ` : ''}where: $where) { edges { node { objectId${hasName ? ' Name' : ''} ServingsPerContainer } } }
}`;

// Up to SAMPLE menu edibles, with the package total the menu already has.
export function menuEdibles(data) {
  return (data?.findMenus?.menuGroups || []).flatMap(g => g?.products || [])
    .filter(p => typeof p?.id === 'string' && /edible/i.test(p.category || '')).slice(0, SAMPLE);
}
export function summarizeServings(edibles, data) {
  const byId = new Map((data?.edges || []).map(e => e?.node).filter(n => typeof n?.objectId === 'string').map(n => [n.objectId, n]));
  const lines = [];
  let matched = 0, filled = 0;
  for (const p of edibles) {
    const record = byId.get(p.id), servings = record?.ServingsPerContainer;
    if (record) matched++;
    const has = Number.isFinite(servings) && servings > 0;
    if (has) filled++;
    const total = /^(mg|milligrams)$/i.test(p.unitWeightUOM || '') && Number.isFinite(p.unitWeight) ? p.unitWeight : null;
    lines.push(`SERV  ${p.name}: ${!record ? 'no Products record with this ID'
      : has ? `${servings} servings${total ? ` → ${Math.round(total / servings * 10) / 10} mg per dose (${total} mg package)` : ''}`
        : 'servings not filled in'}`);
  }
  lines.push(`COUNT  ${matched} of ${edibles.length} menu edibles found by ID; ${filled} have servings filled in.`);
  return lines;
}

// A fixed label for why GrowFlow refused; its raw error text is never shown.
const category = text => /unknown (argument|field)|cannot query field/i.test(text) ? ', unknown field'
  : /variable|expected type|got invalid value|BAD_USER_INPUT/i.test(text) ? ', wrong value type'
    : /menu.*not found|not found/i.test(text) ? ', not found' : '';
export async function runServingsCheck({ token, menuKey }, { transport, log }) {
  if (!/^gfr_\S+$/.test(token || '')) { log('FAIL  That does not look like a GrowFlow token (starts with gfr_).'); return 1; }
  if (!menuKey) { log('FAIL  This check needs the menu key to pick sample edibles.'); return 1; }
  const call = async (step, query, variables = {}) => {
    const response = await transport({ token, query, variables, maxBytes: 16777216 });
    if (response.status === 429) throw Object.assign(new Error(), { line: 'STOP  Rate limited. Wait a minute before running again.' });
    let payload; try { payload = JSON.parse(response.body); } catch { payload = null; }
    if (response.status === 401) throw Object.assign(new Error(), { line: 'FAIL  Token rejected (invalid, disabled, expired or revoked).' });
    if (!payload?.data) {
      const text = (payload?.errors || []).map(e => e?.message || '').join(' ');
      throw Object.assign(new Error(), { line: /permission|forbidden/i.test(text) ? `FAIL  This token lacks the read scope for the ${step} request${step === 'servings' ? ' (Read > Products)' : ''}.`
        : `FAIL  GrowFlow refused the ${step} request (HTTP ${response.status}${category(text)}). No retry.` });
    }
    return payload.data;
  };
  try {
    const found = findProductsQuery(await call('schema', SCHEMA_QUERY));
    for (const line of found.lines) log(line);
    if (!found.name) { log('\nRESULT Stopped. Copy the lines above to your developer.'); return 1; }
    const edibles = menuEdibles(await call('menu', MENU_QUERY, { menuKey }));
    if (!edibles.length) { log('NOTE  No edibles on this menu.'); return 1; }
    const data = await call('servings', productsQuery(found), { where: { objectId: { in: edibles.map(p => p.id) } } });
    for (const line of summarizeServings(edibles, data[found.name])) log(line);
    log('\nRESULT Done. Copy the lines above to your developer.');
    return 0;
  } catch (error) {
    log(error?.line || 'FAIL  Unexpected response. No raw errors displayed. No retry.');
    return 1;
  }
}
