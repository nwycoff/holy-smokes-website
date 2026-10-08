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
// The potency line on a product card. Edibles are shopped by milligrams, not by percent of
// the edible's weight, so they show the package total (their mg size) instead of percentages.
export function potencyLine(product, fallback) {
 if (product.category === 'Edibles') {
  const totals = [...new Set((product.variants || []).map(v => v.size).filter(size => /^\d+(\.\d+)?\s*mg$/i.test(size)))];
  if (!totals.length) return 'Ask us for the mg per package';
  return `${totals.join(' / ')} per package${product.dose ? ` · ${product.dose.mg} mg per dose (${product.dose.servings} servings)` : ''}`;
 }
 const range = (label, r, digits = 1) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite)
  ? `${label} ${r[0].toFixed(digits)}${r[0] === r[1] ? '' : `–${r[1].toFixed(digits)}`}%` : '';
 return [range('Total THC', product.thc), product.cbd?.[1] >= 1 ? range('CBD', product.cbd) : '', range('Terpenes', product.terpenes, 2)]
  .filter(Boolean).join(' · ') || fallback;
}
// The tag line on a card: heading and sub-filter values, except the dose range, which the
// potency line already gives exactly.
export function cardTags(product) {
 return [product.category, ...Object.entries(product.facets || {}).filter(([key]) => key !== 'Per dose').map(([, value]) => value)]
  .filter((v, i, a) => v && a.indexOf(v) === i).join(' · ');
}
// Sub-filter values in number order when they all have one ("Up to 5mg" before "10–25mg").
export function facetOrder(values) {
 const first = value => Number(/\d[\d,.]*/.exec(value)?.[0].replace(/,/g, ''));
 return values.every(v => Number.isFinite(first(v))) ? [...values].sort((a, b) => first(a) - first(b)) : [...values];
}
// An edible's largest package total in mg (-1 when none), for sorting by strength.
export function packageMg(product) {
 return Math.max(-1, ...(product.variants || []).filter(v => /^\d+(\.\d+)?\s*mg$/i.test(v.size)).map(v => parseFloat(v.size)));
}
