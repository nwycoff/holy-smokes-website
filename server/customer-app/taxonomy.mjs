// How the app and the counter tablet group products, from each product's GrowFlow product
// category (exact names from the owner's 2026-10-07 export). Departments follow the common
// dispensary-menu layout (Dutchie, Weedmaps, Jane); facets are the sub-filters inside each.
// Unknown categories land in "More" so new products never disappear; hidden categories are
// never shown to customers. Infusion is never read from names; the only thing read from a
// name is a blunt's pack size ("2pk", "(2 Pack)").
export const DEPARTMENTS = ['Flower', 'Pre-Rolls', 'Vapes', 'Concentrates', 'Edibles', 'Tinctures & Topicals',
  'CBD & Hemp', 'Seeds & Clones', 'Accessories', 'More'];
// The house brand gets its own first tab (its products also stay in Flower).
export const HOUSE = 'Treehouse';

// Not for sale (waste), not for under-21 patients (nicotine), or not sold (samples).
export const HIDDEN = new Set(['Waste', 'Waste - Disposable', 'waste - pre-roll multi pk', 'Nicotine Products',
  'Sample- Flower', 'Pre-Pack Flower Samples']);

const flower = (Style, Packaging, house = false) => ({ department: 'Flower', facets: { Style, Packaging }, house });
const preRoll = (Type, Format, Pack, packFromName = false) => ({ department: 'Pre-Rolls', facets: { Type, Format, Pack }, packFromName });
const dept = (department, key, value) => ({ department, facets: { [key]: value } });

export const CATEGORIES = {
  'Bulk Flower': flower('Whole flower', 'Bulk'),
  'Top-Shelf Flower': flower('Whole flower', 'Bulk'),
  'Pre-Pack Flower - 1g': flower('Whole flower', 'Pre-packed'),
  'Pre-Pack Flower 3.5g': flower('Whole flower', 'Pre-packed'),
  'Pre-Pack Flower 7g': flower('Whole flower', 'Pre-packed'),
  'Pre-Pack Flower 14g': flower('Whole flower', 'Pre-packed'),
  'Pre-Pack Flower - 28g': flower('Whole flower', 'Pre-packed'),
  'Smalls': flower('Smalls', 'Bulk'),
  'Pre-Pack Smalls - 3.5g': flower('Smalls', 'Pre-packed'),
  'Pre-Pack Smalls - 7g': flower('Smalls', 'Pre-packed'),
  'Pre-Pack Smalls - 14g': flower('Smalls', 'Pre-packed'),
  'Pre-Pack Smalls - 28g': flower('Smalls', 'Pre-packed'),
  'Shake': flower('Shake', 'Bulk'),
  'Pre-Pack Shake': flower('Shake', 'Pre-packed'),
  'Infused Flower': flower('Infused', 'Pre-packed'),
  'Moonrocks': flower('Infused', 'Pre-packed'),
  'Infused Shake': flower('Infused', 'Pre-packed'),
  'Tree House Top Shelf Flower': flower('Whole flower', 'Bulk', true),
  'Tree House Small Bud': flower('Smalls', 'Bulk', true),
  'Pre-Pack Tree House Flower 3.5g': flower('Whole flower', 'Pre-packed', true),
  'Pre-Pack Tree House Flower - 7g': flower('Whole flower', 'Pre-packed', true),
  'Pre-Pack Tree House Flower 14g': flower('Whole flower', 'Pre-packed', true),
  'Pre-Pack Tree House Smalls 3.5g': flower('Smalls', 'Pre-packed', true),
  'Pre-Pack Tree House Smalls 7g': flower('Smalls', 'Pre-packed', true),
  'Pre-Pack Tree House Smalls 14g': flower('Smalls', 'Pre-packed', true),
  'Pre-Pack Tree House Smalls 28g': flower('Smalls', 'Pre-packed', true),

  'Pre-Roll': preRoll('Regular', 'Joints', 'Singles'),
  'Pre-Roll Multipack': preRoll('Regular', 'Joints', 'Multipacks'),
  'Infused Pre-Roll': preRoll('Infused', 'Joints', 'Singles'),
  'Infused Pre-Roll Multi pk': preRoll('Infused', 'Joints', 'Multipacks'),
  'Infused Blunt': preRoll('Infused', 'Blunts', 'Singles', true),

  '510 Carts': dept('Vapes', 'Style', 'Cartridges'),
  'Disposable Carts': dept('Vapes', 'Style', 'Disposables'),

  'Live Resin 1g': dept('Concentrates', 'Style', 'Live resin'),
  'Live Resin - 3.5': dept('Concentrates', 'Style', 'Live resin'),
  'Live Resin - 7g': dept('Concentrates', 'Style', 'Live resin'),
  'Live Resin - 14g': dept('Concentrates', 'Style', 'Live resin'),
  'Live Resin - 28g': dept('Concentrates', 'Style', 'Live resin'),
  'Live Diamond': dept('Concentrates', 'Style', 'Diamonds'),
  'Live Diamonds - 3.5g': dept('Concentrates', 'Style', 'Diamonds'),
  'Live Diamonds 7g': dept('Concentrates', 'Style', 'Diamonds'),
  'Live Diamond - 14g': dept('Concentrates', 'Style', 'Diamonds'),
  'Live Diamond - 28g': dept('Concentrates', 'Style', 'Diamonds'),
  'Cured': dept('Concentrates', 'Style', 'Cured resin'),
  'Cured - 3.5g': dept('Concentrates', 'Style', 'Cured resin'),
  'Cured - 7g': dept('Concentrates', 'Style', 'Cured resin'),
  'Cured - 14g': dept('Concentrates', 'Style', 'Cured resin'),
  'Cured - 28g': dept('Concentrates', 'Style', 'Cured resin'),
  'Rosin': dept('Concentrates', 'Style', 'Rosin'),
  'Live Bubble Hash': dept('Concentrates', 'Style', 'Hash'),
  'Shatter': dept('Concentrates', 'Style', 'Shatter'),
  'Crumble': dept('Concentrates', 'Style', 'Crumble'),
  '2g WAX': dept('Concentrates', 'Style', 'Wax'),
  'Concentrate': dept('Concentrates', 'Style', 'Other'),

  'Edible less than 100mg': dept('Edibles', 'Strength', 'Up to 100mg'),
  '100mg Edibles': dept('Edibles', 'Strength', 'Up to 100mg'),
  '250mg-500mg Edibles': dept('Edibles', 'Strength', '250–500mg'),
  '1000mg Edible': dept('Edibles', 'Strength', '1,000mg'),
  '2000mg-5000mg Edibles': dept('Edibles', 'Strength', '2,000–5,000mg'),
  '10,000mg Edibles': dept('Edibles', 'Strength', '10,000mg'),

  'Tincture': dept('Tinctures & Topicals', 'Style', 'Tinctures'),
  'Capsule': dept('Tinctures & Topicals', 'Style', 'Capsules'),
  'Topical': dept('Tinctures & Topicals', 'Style', 'Topicals'),
  'Transdermal Patch': dept('Tinctures & Topicals', 'Style', 'Patches'),
  'Suppository': dept('Tinctures & Topicals', 'Style', 'Suppositories'),

  'CBD': dept('CBD & Hemp', 'Style', 'CBD'),
  'Delta 8 Products': dept('CBD & Hemp', 'Style', 'Delta 8'),

  'Seed': dept('Seeds & Clones', 'Style', 'Seeds'),
  'Clone': dept('Seeds & Clones', 'Style', 'Clones'),

  'Batteries / Pens': dept('Accessories', 'Style', 'Batteries & pens'),
  'Dab Pen & Accessories': dept('Accessories', 'Style', 'Batteries & pens'),
  'Bong / Rig': dept('Accessories', 'Style', 'Glass'),
  'Pipe': dept('Accessories', 'Style', 'Glass'),
  'Oil Burners': dept('Accessories', 'Style', 'Glass'),
  'Papers / Wraps': dept('Accessories', 'Style', 'Papers & wraps'),
  'Bangers / Bowls': dept('Accessories', 'Style', 'Dab tools'),
  'Carb Caps': dept('Accessories', 'Style', 'Dab tools'),
  'Dab Accessories': dept('Accessories', 'Style', 'Dab tools'),
  'Puffco': dept('Accessories', 'Style', 'Dab tools'),
  'Puffco Accessaries & Tops': dept('Accessories', 'Style', 'Dab tools'),
  'Torch / Butane': dept('Accessories', 'Style', 'Torches & butane'),
  'Smoking Accessories': dept('Accessories', 'Style', 'Other'),
  'Apparel': dept('Accessories', 'Style', 'Apparel')
};

// "2pk", "2 pk", "2-pack", "(2 Pack)", "7pk": two or more is a multipack.
const PACK = /\b(\d{1,2})\s*-?\s*(?:pk|pack)s?\b/i;
export function packOf(name) {
  const match = PACK.exec(String(name || ''));
  return match && Number(match[1]) >= 2 ? 'Multipacks' : null;
}

// { department, facets, house } for a product, or null when it must not be shown.
export function classifyProduct(category, name) {
  const key = typeof category === 'string' ? category.trim() : '';
  if (HIDDEN.has(key)) return null;
  const match = CATEGORIES[key];
  if (!match) return { department: 'More', facets: {}, house: false };
  const facets = { ...match.facets };
  if (match.packFromName) facets.Pack = packOf(name) || facets.Pack;
  return { department: match.department, facets, house: Boolean(match.house) };
}
