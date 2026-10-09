import { cardTags, facetOrder, inSection, matchesFacets, packageMg, potencyLine } from './categories.js';
const $ = id => document.getElementById(id);
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const state = { menu: null, category: 'All', loading: false, error: '', selected: new Set() };
const controlIds = ['search', 'type', 'brand', 'budget', 'size', 'sort'];
const IDLE_MS = 120000;
// The same browse-only menu runs on the counter tablet (/tablet/) and the website's Menu pages
// (<body data-menu="website">). Only the tablet resets itself after two idle minutes and keeps
// the screen awake. On the website each heading is its own page (/menu/pre-rolls, built on the
// server with its products already in it, see server/site/menu-page.mjs): headings are plain
// links, the page's heading comes from <body data-category>, and product photos show.
const site = document.body.dataset.menu === 'website';
// The website's wide layout, with headings in a column (assets/menu/site.css), and the observer for
// its pinned options line. Declared up here: the first render runs before the code further down.
const sidebar = matchMedia('(min-width: 901px)');
let pinWatch = null;
// The heading this page is showing; on the website it changes as shoppers switch headings in place.
let pageHeading = site ? document.body.dataset.category || 'All' : 'All';
const slugOf = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Server-built cards stay on screen until the live menu replaces them.
const prerendered = site && document.getElementById('products').children.length > 0;
state.category = pageHeading;
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
    // Edibles alone go by mg in the package; a percent of an edible's weight isn't comparable.
    thc: products.length && products.every(p => p.category === 'Edibles') ? (a,b) => packageMg(b)-packageMg(a)
      : (a,b) => (b.thc?.[1] ?? -1)-(a.thc?.[1] ?? -1), price: (a,b) => min(a)-min(b),
    popular: (a,b) => (a.popular ?? Infinity)-(b.popular ?? Infinity) || min(a)-min(b) }[sort];
  return [...products].sort((a,b) => (compare || (()=>0))(a,b) || a.name.localeCompare(b.name));
}
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
  if (site && product.image) {
    const photo = node('img', '', 'product-photo'); photo.src = product.image; photo.alt = ''; photo.loading = 'lazy'; photo.decoding = 'async';
    photo.addEventListener('error', () => photo.remove()); item.append(photo);
  }
  const top = node('div', '', 'product-top'); top.append(node('span', cardTags(product), 'product-category'));
  if (product.type || product.cbdRich) top.append(node('span', product.type || 'CBD-rich', `product-type ${product.type || ''}`));
  item.append(top, node('p', product.brand || 'Treehouse selection', 'product-brand'), node('h2', product.name));
  item.append(node('p', potencyLine(product, 'Ask us for testing details'), 'potency'));
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
  if (state.menu && !categories.includes(state.category)) state.category = 'All';
  updateOptions('brand', [...new Set(products.map(p => p.brand).filter(Boolean))].sort(), 'All brands');
  updateOptions('size', [...new Map(products.filter(p => p.flower).flatMap(p => p.variants).map(v => [v.size,v.grams || 0])).entries()].sort((a,b)=>a[1]-b[1]).map(([size])=>size), 'All sizes');
  const buttons = categories.map(category => {
    const count = node('span', String(products.filter(p => inSection(p, category)).length));
    // Website: a link to the heading's own page ("More", new categories without a page, stays in place).
    if (site && category !== 'More') {
      const link = node('a', category); link.href = category === 'All' ? '/menu' : `/menu/${slugOf(category)}`;
      if (category === state.category) link.setAttribute('aria-current', 'page');
      link.addEventListener('click', event => {
        // A plain click switches in place; Ctrl/Cmd/Shift-click and middle-click open the page as usual.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); switchHeading(category, true, link.getBoundingClientRect().top);
      });
      link.append(count); return link;
    }
    const button = node('button', category); button.type = 'button'; button.setAttribute('aria-pressed', String(category === state.category));
    button.append(count);
    button.addEventListener('click', () => { state.category = category; state.selected.clear(); render(); }); return button;
  });
  const categoryScroll = $('categories').scrollLeft;
  $('categories').replaceChildren(...buttons); $('categories').scrollLeft = categoryScroll; renderFacets(products);
  offerPopularSort($('sort'), products.some(p => p.popular));
  const query = selection(), visible = sorted(filtered(products, query), query.sort);
  $('products').replaceChildren(...visible.map(card)); $('products').setAttribute('aria-busy', String(state.loading && !state.menu));
  $('count').textContent = !state.menu ? state.loading ? 'Getting the menu ready…' : 'Menu temporarily unavailable' : `${visible.length} ${visible.length === 1 ? 'find' : 'finds'}${state.category !== 'All' ? ` · ${state.category}` : ''}`;
  $('clear').hidden = state.category === pageHeading && !state.selected.size && !controlIds.filter(id => id !== 'sort').some(id => query[id]);
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
  state.loading = true; if (first && !prerendered) render();
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
// Website: show another heading without reloading. The address, tab title, page heading and intro
// follow (from the server's #menu-pages details). The heading that was tapped stays exactly where it
// was on screen while the products and sub-filters change around it (headings differ a lot in
// length, and some have sub-filters), so the page never jumps. Back/Forward have no tapped heading:
// they only bring the products back into view if the shopper had scrolled past them.
const headingPages = (() => { try { return JSON.parse(document.getElementById('menu-pages')?.textContent || '{}'); } catch { return {}; } })();
function switchHeading(category, push, tappedTop = null) {
  state.category = category; state.selected.clear(); pageHeading = category; render();
  if (tappedTop !== null) {
    const tapped = [...document.querySelectorAll('#categories a, #categories button')].find(el => el.firstChild?.textContent === category);
    if (tapped) window.scrollBy({ top: tapped.getBoundingClientRect().top - tappedTop, behavior: 'instant' });
  }
  const details = headingPages[category];
  if (details) {
    document.title = details.title;
    $('menu-title') && ($('menu-title').textContent = details.h1);
    $('menu-intro') && ($('menu-intro').textContent = details.intro);
    document.querySelector('meta[name="description"]')?.setAttribute('content', details.description);
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', `https://www.treehousepharmacy.com${details.path}`);
    if (push) history.pushState({ category }, '', details.path);
  }
  if (tappedTop !== null) return;
  const layout = document.querySelector('.layout'), nav = document.getElementById('mainNav');
  const top = layout?.getBoundingClientRect().top ?? 0, offset = (nav?.offsetHeight || 0) + 16;
  if (top < offset) window.scrollTo({ top: window.scrollY + top - offset, behavior: 'smooth' });
}
// Headings' titles and intros differ in length; reserving room for the longest at the current width
// keeps everything below them (the headings themselves) from moving when they change.
function reserveRoom() {
  const pages = Object.values(headingPages);
  for (const [id, field] of [['menu-title', 'h1'], ['menu-intro', 'intro']]) {
    const el = $(id); if (!el || !pages.length) continue;
    const probe = el.cloneNode(); probe.removeAttribute('id');
    probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;width:${el.clientWidth}px;min-height:0;margin:0`;
    el.parentNode.append(probe);
    let tallest = 0;
    for (const page of pages) { probe.textContent = page[field]; tallest = Math.max(tallest, probe.offsetHeight); }
    probe.remove(); el.style.minHeight = `${tallest}px`;
  }
}
if (site) {
  reserveRoom();
  let reservedWidth = innerWidth;
  addEventListener('resize', () => { if (innerWidth !== reservedWidth) { reservedWidth = innerWidth; reserveRoom(); } });
  document.fonts?.ready.then(reserveRoom);
  history.replaceState({ category: pageHeading }, '', location.href);
  addEventListener('popstate', event => {
    const category = event.state?.category ?? Object.keys(headingPages).find(name => headingPages[name].path === location.pathname) ?? 'All';
    switchHeading(category, false);
  });
}
function reset(automatic = false) {
  // On a website heading page, clearing filters keeps that heading.
  state.category = pageHeading; state.selected.clear(); controlIds.forEach(id => { $(id).value = id === 'sort' ? 'price' : ''; });
  document.activeElement?.blur(); render(); $('categories').scrollLeft = 0;
  if (!site) window.scrollTo({top:0,behavior:'instant'});
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
$('reset')?.addEventListener('click',()=>reset()); $('clear').addEventListener('click',()=>reset()); $('retry').addEventListener('click',()=>void refresh());
if (!site) {
  for (const event of ['pointerdown','pointermove','keydown','input','scroll']) document.addEventListener(event,activity,{passive:true});
  document.addEventListener('pointerdown',()=>void keepAwake(),{passive:true});
}
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
document.addEventListener('visibilitychange',()=>{ if (document.hidden) return; if (!site) { reset(); activity(); void keepAwake(); } void refresh(); });
setInterval(()=>{ if (!document.hidden) void refresh(); },60000);
if (!site) { activity(); void keepAwake(); }
void refresh();


// Boxes start unchecked (everything shows); checking narrows. Each count is what checking
// that box would show given the other groups and filters; boxes that would show nothing are disabled.
function renderFacets(products) {
 const existing = document.getElementById('category-facets');
 const focus = existing?.contains(document.activeElement) ? document.activeElement?.dataset.facet : null;
 existing?.remove(); $('facet-pin')?.remove(); pinWatch?.disconnect();
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
  for (const value of facetOrder([...values])) {
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
 const selected=$('categories').querySelector('[aria-pressed="true"], [aria-current="page"]');
 // Website, wide: above the products, so switching headings never moves the heading list, with a
 // one-line summary pinned under the site header once they scroll away. Website, tablet and phone
 // widths (headings as a row of chips): below the row. Counter tablet: under the chosen heading.
 if (site && sidebar.matches) { document.querySelector('.selection .toolbar').after(panel); pinSummary(panel); }
 else if (site) $('categories').after(panel); else selected.after(panel);
 if(focus) [...panel.querySelectorAll('input')].find(el=>el.dataset.facet===focus)?.focus();
}
// The pinned line: the heading and its picked options, and a button back up to all of them. It takes
// no room in the page (zero height, sticky) and shows only while the options are above the screen.
if (site) sidebar.addEventListener('change', () => render());
function pinSummary(panel) {
 const below = ($('mainNav')?.offsetHeight || 0) + 8;
 const chosen = [...state.selected].map(id => id.slice(id.indexOf(':') + 1));
 const pin = node('div', '', 'facet-pin'); pin.id = 'facet-pin'; pin.hidden = true; pin.style.top = `${below}px`;
 const bar = node('button', '', 'facet-pin-bar'); bar.type = 'button';
 bar.append(node('span', [state.category, ...(chosen.length ? chosen : ['All'])].join(' · ')), node('strong', 'Change filters'));
 bar.addEventListener('click', () => window.scrollTo({ top: panel.getBoundingClientRect().top + window.scrollY - below,
  behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
 pin.append(bar); panel.after(pin);
 pinWatch = new IntersectionObserver(([entry]) => { pin.hidden = entry.isIntersecting || entry.boundingClientRect.top > below; },
  { rootMargin: `-${below}px 0px 0px 0px` });
 pinWatch.observe(panel);
}
