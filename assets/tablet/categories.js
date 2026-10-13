// Departments, sub-filter facets and the house-brand flag come from the server
// (server/customer-app/taxonomy.mjs), so the tablet and the app group products the same way.
// A product shows under its own heading and any extra tabs it is also listed under
// (Treehouse for house products, CBD & Hemp for CBD-rich products).
export function inSection(product, section) {
 return section === 'All' || product.category === section || (Array.isArray(product.also) && product.also.includes(section));
}
// The "By terpene" filter goes by each product's main terpene: the one its lab results show the
// most of, from the lab panel's top five, with the two pinenes and the two nerolidols each counted
// as one. Nearly every flower has caryophyllene and limonene somewhere in its top five, so
// "has it at all" would barely narrow anything; the main one does. Null without lab terpenes.
export const TERPENE = 'Terpene';
const TERPENE_FAMILY = { 'α-Pinene': 'Pinene', 'β-Pinene': 'Pinene', 'cis-Nerolidol': 'Nerolidol', 'trans-Nerolidol': 'Nerolidol', 'α-Terpinene': 'Terpinene' };
export function mainTerpene(product) {
 const totals = new Map();
 for (const terpene of product?.lab?.terpenes || []) {
  const amount = Array.isArray(terpene?.range) ? Number(terpene.range[1]) : NaN;
  if (typeof terpene?.name !== 'string' || !(amount > 0)) continue;
  const name = TERPENE_FAMILY[terpene.name] || terpene.name;
  totals.set(name, (totals.get(name) || 0) + amount);
 }
 return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}
// What each terpene smells like, beside it in the list. Aroma only: no effects or health claims.
export const TERPENE_AROMAS = { Caryophyllene: 'peppery, spicy', Limonene: 'citrus', Linalool: 'floral, lavender', Myrcene: 'earthy, musky',
 Humulene: 'hoppy, woody', Pinene: 'pine', Bisabolol: 'floral, chamomile', Terpinolene: 'fresh, fruity', 'Caryophyllene oxide': 'spicy, woody',
 Eucalyptol: 'minty, cool', Nerolidol: 'woody, floral', Terpinene: 'citrus, woody' };
// Headings where shoppers pick by terpene: flower and what's made from it to smoke or vape.
export const TERPENE_HEADINGS = new Set(['Treehouse', 'Flower', 'Smalls', 'Shake', 'Pre-Rolls', 'Vapes', 'Concentrates']);

// Checked values narrow: within a group any checked value matches; across groups every group
// with something checked must match. A group with nothing checked allows all. The terpene group
// matches each product's main terpene.
export function matchesFacets(product, selected, skipGroup = null) {
 const groups = new Map();
 for (const id of selected) {
  const at = id.indexOf(':'), key = id.slice(0, at);
  if (key === skipGroup) continue;
  if (!groups.has(key)) groups.set(key, new Set());
  groups.get(key).add(id.slice(at + 1));
 }
 return [...groups].every(([key, values]) => values.has(key === TERPENE ? mainTerpene(product) : product.facets?.[key]));
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
