// The website's Menu pages (/menu and one page per heading, e.g. /menu/pre-rolls), built on
// the server so search engines see each heading's own title, description, links and current
// products in the page itself. The browse script (assets/tablet/menu.js, website mode) then
// takes over in the browser exactly as before. menu.html is the template.
import { getMenu, publicMenu } from '../customer-app/growflow.mjs';
import { menuReady } from '../customer-app/http.mjs';
import { CATEGORIES, DEPARTMENTS, HOUSE } from '../customer-app/taxonomy.mjs';

export const ORIGIN = 'https://www.treehousepharmacy.com';
// "Pre-Rolls" → "pre-rolls", "Tinctures & Capsules" → "tinctures-capsules".
export const slugOf = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Every heading a page can exist for, in menu order. "More" (new, unmapped categories) has no page.
export const HEADINGS = [HOUSE, ...DEPARTMENTS.filter(d => d !== 'More')];
const BY_SLUG = new Map(HEADINGS.map(h => [slugOf(h), h]));

// What each heading holds, for its description and intro. Plain facts only (no effect or
// health claims).
const HOLDS = {
  [HOUSE]: 'our own Treehouse-grown flower and Treehouse Farms pre-rolls',
  Flower: 'whole flower by the gram, eighth, quarter, half and ounce, plus infused flower and moonrocks',
  Smalls: 'smalls — smaller buds at a better price per gram',
  Shake: 'shake and infused shake',
  'Pre-Rolls': 'joints, blunts, infused pre-rolls and multipacks',
  Vapes: '510 cartridges and disposable vapes',
  Concentrates: 'live resin, diamonds, cured resin, rosin, hash, shatter, crumble and wax',
  Edibles: 'edibles from 100mg to 10,000mg',
  'Tinctures & Capsules': 'tinctures, capsules and suppositories',
  'Topicals & Patches': 'topicals and transdermal patches',
  'CBD & Hemp': 'CBD-rich cannabis and hemp CBD',
  'Seeds & Clones': 'seeds and clones',
  Accessories: 'batteries and pens, glass, papers and wraps, dab tools and torches'
};
// The overview page shows this many products (most popular first); each heading shows all of its own.
const OVERVIEW_PRODUCTS = 60;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inHeading = (p, heading) => p.category === heading || (Array.isArray(p.also) && p.also.includes(heading));
const money = cents => `$${(cents / 100).toFixed(2)}`;
const range = (label, r, digits = 1) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite)
  ? `${label} ${r[0].toFixed(digits)}${r[0] === r[1] ? '' : `–${r[1].toFixed(digits)}`}%` : '';

// The same card markup the browse script draws, so nothing shifts when it takes over.
export function cardHtml(p) {
  const tags = [p.category, ...Object.values(p.facets || {})].filter((v, i, a) => v && a.indexOf(v) === i).join(' · ');
  const potency = [range('Total THC', p.thc), p.cbd?.[1] >= 1 ? range('CBD', p.cbd) : '', range('Terpenes', p.terpenes, 2)]
    .filter(Boolean).join(' · ') || 'Ask us for testing details';
  const variants = (p.variants || []).map(v => `<div class="variant"><span>${escapeHtml(v.size)}</span><div><strong>${money(v.priceCents)}</strong>${
    p.flower && v.pricePerGramCents ? `<small>${money(v.pricePerGramCents)}/g</small>` : ''}</div></div>`).join('');
  return `<article class="product" data-product-id="${escapeHtml(p.id)}">${p.image ? `<img class="product-photo" src="${escapeHtml(p.image)}" alt="" loading="lazy" decoding="async">` : ''}`
    + `<div class="product-top"><span class="product-category">${escapeHtml(tags)}</span>${p.type || p.cbdRich ? `<span class="product-type ${escapeHtml(p.type)}">${escapeHtml(p.type || 'CBD-rich')}</span>` : ''}</div>`
    + `<p class="product-brand">${escapeHtml(p.brand || 'Treehouse selection')}</p><h2>${escapeHtml(p.name)}</h2><p class="potency">${escapeHtml(potency)}</p>`
    + `<div class="variants">${variants}</div>${p.description ? `<p class="description">${escapeHtml(p.description)}</p>` : ''}</article>`;
}

// Everything that differs between Menu pages, from the heading (null = the overview) and the menu.
export function pageParts(heading, menu) {
  const products = menu?.products || [];
  const shown = heading ? products.filter(p => inHeading(p, heading))
    : [...products].sort((a, b) => (a.popular ?? Infinity) - (b.popular ?? Infinity)).slice(0, OVERVIEW_PRODUCTS);
  const count = heading ? shown.length : products.length;
  const path = heading ? `/menu/${slugOf(heading)}` : '/menu';
  const title = heading ? `${heading === HOUSE ? 'Treehouse Products' : heading} in Ponca City, OK | Treehouse Pharmacy Menu`
    : 'Live Menu | Treehouse Pharmacy — Dispensary in Ponca City, OK';
  const description = heading
    ? `${menu ? `${count} ${count === 1 ? 'product' : 'products'} in stock now` : 'Shop'} at Treehouse Pharmacy in Ponca City, OK: ${HOLDS[heading]}. Prices, THC and lab results, updated through the day. Order ahead for pickup.`
    : 'Browse the live menu at Treehouse Pharmacy in Ponca City, OK: flower, smalls, pre-rolls, vapes, concentrates, edibles and more, with prices, THC and lab results updated through the day.';
  const h1 = heading ? (heading === HOUSE ? 'Treehouse Products' : heading) : 'Live Menu';
  const intro = heading
    ? `${menu ? `${count} ${count === 1 ? 'product' : 'products'} on our shelves right now` : 'On our shelves right now'}: ${HOLDS[heading]}. Updated through the day.`
    : 'Everything on our shelves right now — flower, pre-rolls, vapes, concentrates, edibles and more, with lab results — updated through the day.';
  // Real links to every heading that has products (all headings when the menu can't be read).
  const linked = HEADINGS.filter(h => !menu || products.some(p => inHeading(p, h)));
  const links = [['All', '/menu', products.length], ...linked.map(h => [h, `/menu/${slugOf(h)}`, products.filter(p => inHeading(p, h)).length])]
    .map(([name, href, n]) => `<a href="${href}"${(name === 'All' ? !heading : name === heading) ? ' aria-current="page"' : ''}>${escapeHtml(name)}${menu ? `<span>${n}</span>` : ''}</a>`).join('');
  const cards = shown.map(cardHtml).join('');
  const breadcrumbs = [{ name: 'Home', item: `${ORIGIN}/` }, { name: 'Menu', item: `${ORIGIN}/menu` },
    ...(heading ? [{ name: h1, item: `${ORIGIN}${path}` }] : [])];
  const structured = [{
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs.map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.name, item: b.item }))
  }, {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, url: `${ORIGIN}${path}`, description,
    about: { '@type': 'MedicalBusiness', additionalType: 'https://schema.org/Store', name: 'Treehouse Pharmacy', url: `${ORIGIN}/`,
      telephone: '+1-580-716-6720', address: { '@type': 'PostalAddress', streetAddress: '1801 N Union St', addressLocality: 'Ponca City',
        addressRegion: 'OK', postalCode: '74601', addressCountry: 'US' } }
  }];
  const found = `${shown.length} ${shown.length === 1 ? 'find' : 'finds'}${heading ? ` · ${heading}` : ''}`;
  const updated = menu ? `Updated ${new Date(menu.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })}` : '';
  return { path, title, description, h1, intro, links, cards, count, heading, structured, found: menu ? found : '', updated };
}

export function renderPage(template, parts) {
  const head = `<title>${escapeHtml(parts.title)}</title>
  <meta name="description" content="${escapeHtml(parts.description)}" />
  <link rel="canonical" href="${ORIGIN}${parts.path}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(parts.title)}" />
  <meta property="og:description" content="${escapeHtml(parts.description)}" />
  <meta property="og:url" content="${ORIGIN}${parts.path}" />
  <meta property="og:image" content="${ORIGIN}/images/img7.jpeg" />
  <script type="application/ld+json">${JSON.stringify(parts.structured).replace(/</g, '\\u003c')}</script>`;
  // Each swap is a function, so "$" in prices or names is never read as a replacement pattern.
  const swaps = [
    [/<title>[\s\S]*?<\/title>/, () => ''],
    [/<meta name="description"[^>]*>/, () => ''],
    [/<link rel="canonical"[^>]*>/, () => ''],
    [/<!--menu:head-->/, () => head],
    [/(<h1 id="menu-title"[^>]*>)[\s\S]*?(<\/h1>)/, (_, open, close) => `${open}${escapeHtml(parts.h1)}${close}`],
    [/(<p id="menu-intro"[^>]*>)[\s\S]*?(<\/p>)/, (_, open, close) => `${open}${escapeHtml(parts.intro)}${close}`],
    [/(<nav id="categories"[^>]*>)(<\/nav>)/, (_, open, close) => `${open}${parts.links}${close}`],
    [/(<div id="products"[^>]*>)(<\/div>)/, (_, open, close) => `${parts.cards ? open.replace('aria-busy="true"', 'aria-busy="false"') : open}${parts.cards}${close}`],
    [/(<p id="count"[^>]*>)[\s\S]*?(<\/p>)/, (match, open, close) => parts.found ? `${open}${escapeHtml(parts.found)}${close}` : match],
    [/(<span id="freshness"[^>]*>)[\s\S]*?(<\/span>)/, (match, open, close) => parts.updated ? `${open}${escapeHtml(parts.updated)}${close}` : match],
    [/<body data-menu="website"/, match => `${match}${parts.heading ? ` data-category="${escapeHtml(parts.heading)}"` : ''}`]
  ];
  let html = template;
  for (const [pattern, replace] of swaps) {
    if (!pattern.test(html)) throw new Error(`MENU_TEMPLATE ${pattern}`);
    html = html.replace(pattern, replace);
  }
  return html;
}

// Pages Function entry: /menu, /menu/, /menu/<heading>, and old /menu?category=<name> links.
export async function handleMenuPage(context, overrides = {}) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const slug = url.pathname.replace(/^\/menu\/?/, '').replace(/\/$/, '');
  const linked = url.searchParams.get('category');
  if (!slug && linked) {
    const heading = HEADINGS.find(h => h === linked || slugOf(h) === slugOf(linked));
    return Response.redirect(new URL(heading ? `/menu/${slugOf(heading)}` : '/menu', url), 301);
  }
  const heading = slug ? BY_SLUG.get(slug) : null;
  if (slug && !heading) {
    const missing = await env.ASSETS.fetch(new URL('/404.html', url));
    return new Response(missing.body, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  let page = await env.ASSETS.fetch(new URL('/menu.html', url));
  if (page.status >= 300 && page.status < 400 && page.headers.get('location')) page = await env.ASSETS.fetch(new URL(page.headers.get('location'), url));
  const template = await page.text();
  const deps = { fetch: (u, o) => globalThis.fetch(u, o), now: Date.now,
    report: code => { try { console.warn(`TREEHOUSE_MENU_PAGE ${code}`); } catch { /* never break a page */ } }, ...overrides };
  let menu = null;
  if (deps.loadMenu || menuReady(env)) {
    try { menu = deps.loadMenu ? await deps.loadMenu() : publicMenu(await getMenu(env, deps)); }
    catch (error) { deps.report(`MENU_${error?.code || 'ERROR'}`); }
  }
  let html;
  try { html = renderPage(template, pageParts(heading, menu)); }
  catch { deps.report('TEMPLATE'); html = template; }
  return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    // Shared caches may keep a page a minute, matching how often the menu itself refreshes.
    'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff'
  } });
}

// For sitemap.xml: every heading page with a known category behind it.
export const SITEMAP_PATHS = ['/menu', ...HEADINGS.filter(h => h === HOUSE || Object.values(CATEGORIES).some(c => c.department === h))
  .map(h => `/menu/${slugOf(h)}`)];
