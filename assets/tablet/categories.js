// Departments, sub-filter facets and the house-brand flag come from the server
// (server/customer-app/taxonomy.mjs), so the tablet and the app group products the same way.
export const HOUSE = 'Treehouse';
export function inSection(product, section) {
 return section === 'All' || (section === HOUSE ? product.house === true : product.category === section);
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
