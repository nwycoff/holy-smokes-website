import { inSection, matchesFacets } from './categories.js';
const $ = id => document.getElementById(id);
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const state = { menu: null, category: 'All', loading: false, error: '', selected: new Set() };
const controlIds = ['search', 'type', 'brand', 'budget', 'size', 'sort'];
const IDLE_MS = 120000;
let idleTimer, toastTimer, wakeLock, wakePending = false;
function node(tag, text = '', className = '') {
  const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item;
}
function selection() { return Object.fromEntries(controlIds.map(id => [id, $(id).value])); }
// skipGroup leaves one facet group out, for that group's counts.
function filtered(products, query, skipGroup = null) {
  const search = query.search.toLocaleLowerCase().trim();
  return products.filter(p => inSection(p, state.category)
    && matchesFacets(p, state.selected, skipGroup)
    && (!search || `${p.name} ${p.brand} ${p.category} ${p.sourceCategory || ''} ${Object.values(p.facets || {}).join(' ')} ${p.type}`.toLocaleLowerCase().includes(search))
    && (!query.type || (query.type === 'cbd' ? p.cbdRich : p.type === query.type))
    && (!query.brand || p.brand === query.brand)
    && p.variants.some(v => (!query.size || (p.flower && v.size === query.size))
      && (!query.budget || (query.budget === 'under20' ? v.priceCents < 2000
        : query.budget === '20to40' ? v.priceCents >= 2000 && v.priceCents <= 4000 : v.priceCents > 4000))));
}
// "Most popular" is offered only once the menu carries sales ranks (iPhone Safari ignores
// hidden options, so it is added and removed rather than hidden).
function offerPopularSort(select, available) {
  const option = select.querySelector('option[value="popular"]');
  if (available && !option) { const add = document.createElement('option'); add.value = 'popular'; add.textContent = 'Most popular'; select.options[0].after(add); }
  if (!available && option) { if (select.value === 'popular') select.value = 'price'; option.remove(); }
}
function sorted(products, sort) {
  const min = p => Math.min(...p.variants.map(v => v.priceCents));
  const compare = { name: (a,b) => a.name.localeCompare(b.name), 'price-desc': (a,b) => min(b)-min(a),
    thc: (a,b) => (b.thc?.[1] ?? -1)-(a.thc?.[1] ?? -1), price: (a,b) => min(a)-min(b),
    popular: (a,b) => (a.popular ?? Infinity)-(b.popular ?? Infinity) || min(a)-min(b) }[sort];
  return [...products].sort((a,b) => (compare || (()=>0))(a,b) || a.name.localeCompare(b.name));
}
function range(label, r, digits = 1) { return Array.isArray(r) && r.length === 2 && r.every(Number.isFinite)
  ? `${label} ${r[0].toFixed(digits)}${r[0] === r[1] ? '' : `–${r[1].toFixed(digits)}`}%` : ''; }
// Tap-to-open lab panel: cannabinoids as figures, the top terpenes as bars scaled to the
// largest (terpenes don't add up to 100%, so no pie). Stays open across re-renders.
const openLab = new Set();
function labDetails(product, make) {
  const details = make('details', '', 'lab'); details.open = openLab.has(product.id);
  details.addEventListener('toggle', () => { if (details.open) openLab.add(product.id); else openLab.delete(product.id); });
  details.append(make('summary', 'Lab results'));
  const pct = r => `${r[0].toFixed(2)}${r[0] !== r[1] ? '–' + r[1].toFixed(2) : ''}%`;
  const section = (title, rows, bars) => {
    if (!rows?.length) return;
    const box = make('div', '', 'lab-section'), top = Math.max(...rows.map(r => r.range[1]));
    box.append(make('p', title, 'lab-title'));
    for (const r of rows) {
      const row = make('div', '', 'lab-row'); row.append(make('span', r.name), make('strong', pct(r.range)));
      if (bars) { const bar = make('i', '', 'lab-bar'); bar.style.width = `${Math.max(4, r.range[1] / top * 100)}%`; row.append(bar); }
      box.append(row);
    }
    details.append(box);
  };
  section('Cannabinoids', product.lab.cannabinoids, false);
  section('Top terpenes', product.lab.terpenes, true);
  details.append(make('p', 'From the lab results on file for the packages in stock.', 'lab-note'));
  return details;
}
function card(product) {
  const item = node('article', '', 'product'); item.dataset.productId = product.id;
  const top = node('div', '', 'product-top'); top.append(node('span', [product.category, ...Object.values(product.facets || {})].filter((v,i,a)=>v && a.indexOf(v)===i).join(' · '), 'product-category'));
  if (product.type || product.cbdRich) top.append(node('span', product.type || 'CBD-rich', `product-type ${product.type || ''}`));
  item.append(top, node('p', product.brand || 'Treehouse selection', 'product-brand'), node('h2', product.name));
  item.append(node('p', [range('Total THC', product.thc), product.cbd?.[1] >= 1 ? range('CBD', product.cbd) : '', range('Terpenes', product.terpenes, 2)]
    .filter(Boolean).join(' · ') || 'Ask us for testing details', 'potency'));
  if (product.lab) item.append(labDetails(product, node));
  const variants = node('div', '', 'variants');
  for (const variant of product.variants) {
    const row = node('div', '', 'variant'), price = node('div');
    price.append(node('strong', currency.format(variant.priceCents / 100)));
    if (product.flower && variant.pricePerGramCents) price.append(node('small', `${currency.format(variant.pricePerGramCents / 100)}/g`));
    row.append(node('span', variant.size), price); variants.append(row);
  }
  item.append(variants);
  if (product.description) item.append(node('p', product.description, 'description'));
  return item;
}
function updateOptions(id, values, label) {
  const select = $(id), value = select.value;
  const options = [[ '', label ], ...values.map(v => [v,v])];
  if (JSON.stringify([...select.options].map(o => [o.value,o.textContent])) === JSON.stringify(options)) return;
  select.replaceChildren(...options.map(([value,text]) => { const option = node('option',text); option.value = value; return option; }));
  select.value = values.includes(value) ? value : '';
}
// The "Updated 2:14 PM" line and any connection notice, without touching the product cards.
function renderStatus() {
  $('notice').textContent = state.error; $('notice').hidden = !state.error;
  $('freshness').textContent = state.menu?.stale ? 'Update delayed' : state.menu ? 'Updated ' + new Date(state.menu.updatedAt).toLocaleTimeString([], { hour:'numeric',minute:'2-digit' }) : '';
}
// Rebuilding the cards stops a scroll in progress, so a minute's refresh only rebuilds them
// when the menu actually changed, and waits until the screen has been still for a moment.
const menuSignature = menu => menu ? JSON.stringify([menu.categories, menu.products]) : '';
let lastScroll = 0, pendingRender;
function renderWhenStill() {
  clearTimeout(pendingRender);
  if (Date.now() - lastScroll < 1200) { pendingRender = setTimeout(renderWhenStill, 400); return; }
  render(true);
}
function anchor() {
  const item = [...document.querySelectorAll('.product')].find(el => el.getBoundingClientRect().bottom > 0);
  return item && window.scrollY > 150 ? { id:item.dataset.productId, top:item.getBoundingClientRect().top } : null;
}
function restoreAnchor(saved) {
  if (!saved) return;
  const item = [...document.querySelectorAll('.product')].find(el => el.dataset.productId === saved.id);
  if (item) window.scrollBy(0, item.getBoundingClientRect().top - saved.top);
}
function render(preservePosition = false) {
  const saved = preservePosition ? anchor() : null;
  const products = state.menu?.products || [];
  const categories = ['All', ...(state.menu?.categories || [])];
  if (!categories.includes(state.category)) state.category = 'All';
  updateOptions('brand', [...new Set(products.map(p => p.brand).filter(Boolean))].sort(), 'All brands');
  updateOptions('size', [...new Map(products.filter(p => p.flower).flatMap(p => p.variants).map(v => [v.size,v.grams || 0])).entries()].sort((a,b)=>a[1]-b[1]).map(([size])=>size), 'All sizes');
  const buttons = categories.map(category => {
    const button = node('button', category); button.type = 'button'; button.setAttribute('aria-pressed', String(category === state.category));
    button.append(node('span', String(products.filter(p => inSection(p, category)).length)));
    button.addEventListener('click', () => { state.category = category; state.selected.clear(); render(); }); return button;
  });
  const categoryScroll = $('categories').scrollLeft;
  $('categories').replaceChildren(...buttons); $('categories').scrollLeft = categoryScroll; renderFacets(products);
  offerPopularSort($('sort'), products.some(p => p.popular));
  const query = selection(), visible = sorted(filtered(products, query), query.sort);
  $('products').replaceChildren(...visible.map(card)); $('products').setAttribute('aria-busy', String(state.loading && !state.menu));
  $('count').textContent = !state.menu ? state.loading ? 'Getting the menu ready…' : 'Menu temporarily unavailable' : `${visible.length} ${visible.length === 1 ? 'find' : 'finds'}${state.category !== 'All' ? ` · ${state.category}` : ''}`;
  $('clear').hidden = state.category === 'All' && !controlIds.filter(id => id !== 'sort').some(id => query[id]);
  renderStatus();
  $('empty').hidden = visible.length > 0;
  $('empty-title').textContent = state.menu ? products.length ? 'No matching finds.' : 'The selection is being updated.' : state.loading ? 'A few good finds are on the way.' : 'Let’s check with your budtender.';
  $('empty-copy').textContent = state.menu ? products.length ? 'Try a different search or clear your filters.' : 'Ask us what’s available at the counter.' : state.loading ? 'Getting the latest menu…' : 'We couldn’t load the menu. You can try again below.';
  $('retry').hidden = Boolean(state.loading || state.menu);
  $('tax').textContent = state.menu ? `${state.menu.pricesIncludeTax ? 'Prices include tax.' : 'Prices do not include tax.'} Availability and final pricing are confirmed with your budtender.` : '';
  restoreAnchor(saved);
}
async function refresh() {
  if (state.loading) return;
  const before = menuSignature(state.menu), first = !state.menu;
  state.loading = true; if (first) render();
  try {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch('/api/app/menu', { credentials:'same-origin', cache:'no-store', mode:'same-origin', redirect:'error', signal:AbortSignal.timeout(15000) });
        if (!response.ok) throw Object.assign(new Error('menu'), { status:response.status });
        result = await response.json();
        if (!Array.isArray(result.products) || !result.products.every(p => typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.variants) && p.variants.length && p.variants.every(v => Number.isFinite(v.priceCents))) || !Number.isFinite(result.updatedAt)) throw new Error('shape');
        break;
      } catch (error) {
        if (attempt || (error.status && error.status < 500 && error.status !== 429)) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    state.menu = result;
    state.error = result.stale ? 'Showing the last available menu. Please confirm availability with your budtender.' : '';
  } catch {
    if (state.menu) state.menu = { ...state.menu, stale:true };
    state.error = state.menu ? 'Showing the last available menu while we reconnect. Please confirm availability with your budtender.' : 'The menu connection is temporarily unavailable. Your budtender can help.';
  } finally {
    state.loading = false;
    if (first) render(true);
    else if (menuSignature(state.menu) === before) renderStatus();
    else renderWhenStill();
  }
}
function reset(automatic = false) {
  state.category = 'All'; state.selected.clear(); controlIds.forEach(id => { $(id).value = id === 'sort' ? 'price' : ''; });
  document.activeElement?.blur(); render(); window.scrollTo({top:0,behavior:'instant'}); $('categories').scrollLeft = 0;
  if (automatic) { $('reset-message').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(()=>{ $('reset-message').hidden = true; },3500); }
}
function activity() { clearTimeout(idleTimer); idleTimer = setTimeout(()=>reset(true), IDLE_MS); }
async function keepAwake() {
  if (document.hidden || wakeLock || wakePending || !('wakeLock' in navigator)) return;
  wakePending = true;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
  catch { /* Device kiosk settings provide the fallback. */ }
  finally { wakePending = false; }
}
controlIds.forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', () => render()));
$('reset').addEventListener('click',()=>reset()); $('clear').addEventListener('click',()=>reset()); $('retry').addEventListener('click',()=>void refresh());
for (const event of ['pointerdown','pointermove','keydown','input','scroll']) document.addEventListener(event,activity,{passive:true});
document.addEventListener('pointerdown',()=>void keepAwake(),{passive:true});
let scrollAnchor = null, resizing = false, resizeTimer, viewportWidth = innerWidth;
addEventListener('scroll',()=>{ lastScroll = Date.now(); if (!resizing && innerWidth === viewportWidth) scrollAnchor = anchor(); },{passive:true});
// Only a width change (rotation) moves the page back to the product that was in view. Phone
// browsers change the height while scrolling as the address bar slides in and out; that is ignored.
addEventListener('resize',()=>{
  if (innerWidth === viewportWidth && !resizing) return;
  resizing = true; clearTimeout(resizeTimer);
  resizeTimer = setTimeout(()=>{ restoreAnchor(scrollAnchor); resizing = false; viewportWidth = innerWidth; scrollAnchor = anchor(); },160);
});
addEventListener('online',()=>void refresh());
document.addEventListener('visibilitychange',()=>{ if (!document.hidden) { reset(); activity(); void refresh(); void keepAwake(); } });
setInterval(()=>{ if (!document.hidden) void refresh(); },60000);
activity(); void keepAwake(); void refresh();


// Boxes start unchecked (everything shows); checking narrows. Each count is what checking
// that box would show given the other groups and filters; boxes that would show nothing are disabled.
function renderFacets(products) {
 const existing = document.getElementById('category-facets');
 const focus = existing?.contains(document.activeElement) ? document.activeElement?.dataset.facet : null;
 existing?.remove();
 if (state.category === 'All') return;
 const groups = new Map();
 for (const p of products.filter(p => inSection(p, state.category))) for (const [key,value] of Object.entries(p.facets || {})) {
   if (!groups.has(key)) groups.set(key,new Set());
   groups.get(key).add(value);
 }
 const query = selection();
 const panel = node('div','','category-facets'); panel.id='category-facets';
 for (const [key,values] of groups) {
  if (values.size < 2) continue;
  const field = node('fieldset'); field.append(node('legend',key));
  const others = filtered(products, query, key);
  // "All" is checked while nothing in this group is picked; checking it clears the group.
  const picked = [...state.selected].filter(id => id.startsWith(`${key}:`));
  const allLabel = node('label'), allInput = document.createElement('input');
  allInput.type='checkbox';allInput.dataset.facet=`${key}:*`;allInput.checked=!picked.length;
  allInput.addEventListener('change',()=>{picked.forEach(id=>state.selected.delete(id));render();});
  allLabel.append(allInput,node('span','All'),node('small',String(others.length)));field.append(allLabel);
  for (const value of values) {
   const label=node('label'), input=document.createElement('input'), id=`${key}:${value}`;
   const count = others.filter(p => p.facets?.[key] === value).length;
   input.type='checkbox';input.dataset.facet=id;input.checked=state.selected.has(id);input.disabled=!count && !input.checked;
   input.addEventListener('change',()=>{input.checked?state.selected.add(id):state.selected.delete(id);render();});
   label.append(input,node('span',value),node('small',String(count)));field.append(label);
  }
  panel.append(field);
 }
 if (!panel.children.length) return;
 const reset=node('button','Show all '+state.category);reset.type='button';reset.hidden=!state.selected.size;
 reset.addEventListener('click',()=>{state.selected.clear();render();});panel.append(reset);
 const selected=$('categories').querySelector('[aria-pressed="true"]');
 selected.after(panel);
 if(focus) [...panel.querySelectorAll('input')].find(el=>el.dataset.facet===focus)?.focus();
}
