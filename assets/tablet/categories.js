// Departments, sub-filter facets and the house-brand flag come from the server
// (server/customer-app/taxonomy.mjs), so the tablet and the app group products the same way.
// A product shows under its own heading and any extra tabs it is also listed under
// (Treehouse for house products, CBD & Hemp for CBD-rich products).
export function inSection(product, section) {
 return section === 'All' || product.category === section || (Array.isArray(product.also) && product.also.includes(section));
}
// Checked values narrow: within a group any checked value matches; across groups every group
// with something checked must match. A group with nothing checked allows all.
export function matchesFacets(product, selected, skipGroup = null) {
 const groups = new Map();
 for (const id of selected) {
  const at = id.indexOf(':'), key = id.slice(0, at);
  if (key === skipGroup) continue;
  if (!groups.has(key)) groups.set(key, new Set());
  groups.get(key).add(id.slice(at + 1));
 }
 return [...groups].every(([key, values]) => values.has(product.facets?.[key]));
}
