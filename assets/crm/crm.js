// Treehouse CRM front end. All text is inserted with textContent; nothing is stored in the browser.
const $ = id => document.getElementById(id);
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const count = new Intl.NumberFormat('en-US');
const LABELS = { flower: 'Flower', concentrate: 'Concentrates & vapes', edible: 'Edibles', topical: 'Topicals', seed: 'Seeds', clone: 'Clones', other: 'Other' };
const TEMPLATES = [
  ['Lapsed 60–180 days', { lastVisit: { minDays: 60, maxDays: 180 } }],
  ['Regulars (4+ visits in 90 days)', { visits: { days: 90, min: 4 } }],
  ['Big spenders ($500+ in 90 days)', { spend: { days: 90, min: 500 } }],
  ['Can redeem $25+ (500+ points)', { pointsMin: 500, lastVisit: { maxDays: 365 } }],
  ['Birthdays this month', { birthday: 'this_month', lastVisit: { maxDays: 365 } }],
  ['Concentrate & vape buyers', { categories: { groups: ['concentrate'], days: 90 } }],
  ['Edible buyers', { categories: { groups: ['edible'], days: 90 } }],
  ['Recent visitors not on the app', { lastVisit: { maxDays: 30 }, app: 'not_linked' }],
  ['New customers (30 days)', { newWithinDays: 30 }],
  ['App notification subscribers', { app: 'push' }]
];
let session = null, current = null, currentName = '';

function el(tag, text = '', className = '') { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; }
function message(text = '', bad = false) { $('message').textContent = text; $('message').hidden = !text; $('message').classList.toggle('bad', bad); }
// Retries once after a short pause when the server is momentarily busy (e.g. while history loads).
async function api(path, body, retried = false) {
  const res = await fetch(`/api/crm/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CRM-CSRF': session?.csrf || '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new Error('Your sign-in expired. Reload the page to sign in again.');
  const data = await res.json();
  if (res.status === 503 && !retried) { await new Promise(r => setTimeout(r, 1500)); return api(path, body, true); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
const ago = ms => { if (!ms) return '—'; const d = Math.floor((Date.now() - ms) / 86400000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const change = (now, before) => before ? `${now >= before ? '▲' : '▼'} ${Math.abs(Math.round((now - before) / before * 100))}% vs prior 30 days` : '';

function kpi(label, value, note = '') {
  const card = el('div', '', 'kpi'); card.append(el('p', label, 'kpi-label'), el('p', value, 'kpi-value'));
  if (note) card.append(el('p', note, 'kpi-note')); return card;
}
function bars(target, rows, label) {
  const max = Math.max(1, ...rows.map(r => r.cents));
  target.replaceChildren(...rows.map(r => {
    const row = el('div', '', 'bar'), fill = el('span', '', 'fill'); fill.style.width = `${Math.round(r.cents / max * 100)}%`;
    row.append(el('span', label(r), 'bar-label'), fill, el('span', `${money.format(r.cents / 100)} · ${count.format(r.customers)} customers`, 'bar-value'));
    return row;
  }));
  if (!rows.length) target.append(el('p', 'No sales in this period yet.', 'muted'));
}
async function loadOverview() {
  const o = await api('overview'), t = o.totals || {};
  $('kpis').replaceChildren(
    kpi('Active customers · 30 days', count.format(t.active_30 || 0), `${count.format(t.active_90 || 0)} in 90 days`),
    kpi('Visits · 30 days', count.format(t.visits_30 || 0), change(t.visits_30, t.visits_prev_30)),
    kpi('Sales · 30 days', money.format((t.revenue_30_cents || 0) / 100), change(t.revenue_30_cents, t.revenue_prev_30_cents)),
    kpi('Average basket', t.visits_30 ? money.format(t.revenue_30_cents / t.visits_30 / 100) : '—'),
    kpi('New customers · 30 days', count.format(t.new_30 || 0)),
    kpi('Lapsed 60–180 days', count.format(t.lapsed_60_180 || 0), 'good win-back audience'),
    kpi('Birthdays this month', count.format(t.birthdays_month || 0)),
    kpi('Can redeem a reward', count.format(t.can_redeem || 0), '225+ points'),
    kpi('On My Treehouse', count.format(t.app_linked || 0), `${count.format(t.app_push || 0)} get notifications`),
    kpi('Online orders · 30 days', count.format(t.preorders_30 || 0)));
  bars($('categories'), o.categories || [], r => LABELS[r.grp] || r.grp);
  bars($('brands'), o.brands || [], r => r.name);
  const sources = ['orders', 'lines'].map(name => (o.sync || []).find(s => s.source === name));
  const loaded = o.loaded || {};
  $('sync-status').textContent = sources.some(s => !s) ? 'Waiting for the first sync from GrowFlow…'
    : sources.every(s => s.caught_up_at) ? `Up to date with GrowFlow · checked ${ago(Math.min(...sources.map(s => s.caught_up_at)))}`
    : `Loading history from GrowFlow · ${count.format(loaded.orders || 0)} orders and ${count.format(loaded.lines || 0)} items so far`
      + (loaded.lines_through ? `, items sold through ${new Date(loaded.lines_through).toLocaleDateString()}` : '')
      + ' · totals grow until this finishes';
}

function value(id) { const v = $(id).value.trim(); return v === '' ? undefined : Number(v); }
function readBuilder() {
  const d = {}, lvMin = value('lv-min'), lvMax = value('lv-max');
  if (lvMin !== undefined || lvMax !== undefined) d.lastVisit = { ...(lvMin !== undefined ? { minDays: lvMin } : {}), ...(lvMax !== undefined ? { maxDays: lvMax } : {}) };
  if (value('v-min') !== undefined) d.visits = { days: value('v-days') || 90, min: value('v-min') };
  if (value('s-min') !== undefined) d.spend = { days: value('s-days') || 90, min: value('s-min') };
  const groups = [...document.querySelectorAll('#groups input:checked')].map(i => i.value);
  if (groups.length) d.categories = { groups, days: value('c-days') || 90 };
  if ($('brand').value) d.brands = { ids: [$('brand').value], days: value('b-days') || 180 };
  if (value('points') !== undefined) d.pointsMin = value('points');
  if ($('birthday').value) d.birthday = $('birthday').value;
  if ($('app').value) d.app = $('app').value;
  if (value('new-days') !== undefined) d.newWithinDays = value('new-days');
  return d;
}
function fillBuilder(d) {
  $('builder').reset(); document.querySelectorAll('#groups input').forEach(i => { i.checked = false; });
  if (d.lastVisit) { if (d.lastVisit.minDays !== undefined) $('lv-min').value = d.lastVisit.minDays; if (d.lastVisit.maxDays !== undefined) $('lv-max').value = d.lastVisit.maxDays; }
  if (d.visits) { $('v-min').value = d.visits.min ?? ''; $('v-days').value = d.visits.days; }
  if (d.spend) { $('s-min').value = d.spend.min ?? ''; $('s-days').value = d.spend.days; }
  if (d.categories) { d.categories.groups.forEach(g => { const i = document.querySelector(`#groups input[value="${g}"]`); if (i) i.checked = true; }); $('c-days').value = d.categories.days; }
  if (d.brands) { $('brand').value = d.brands.ids[0]; $('b-days').value = d.brands.days; }
  if (d.pointsMin !== undefined) $('points').value = d.pointsMin;
  if (d.birthday) $('birthday').value = d.birthday;
  if (d.app) $('app').value = d.app;
  if (d.newWithinDays) $('new-days').value = d.newWithinDays;
}

async function countSegment(def, name = '') {
  current = def; currentName = name; $('list').hidden = true;
  const p = await api('preview', { definition: def });
  const box = $('preview'); box.hidden = false;
  const stats = el('div', '', 'preview-stats');
  stats.append(el('strong', `${count.format(p.customers)} customers`), el('span', `${money.format(p.spend90Cents / 100)} spent in 90 days`),
    el('span', p.avgPoints === null ? '' : `average ${count.format(p.avgPoints)} points`), el('span', `${count.format(p.appLinked)} on the app · ${count.format(p.appPush)} get notifications`));
  const save = el('button', 'Save segment', 'secondary'); save.type = 'button'; save.addEventListener('click', saveSegment);
  const show = el('button', 'Show customers'); show.type = 'button'; show.addEventListener('click', () => showCustomers().catch(e => message(e.message, true)));
  const actions = el('div', '', 'actions'); actions.append(show, save);
  box.replaceChildren(el('p', name || 'Custom segment', 'eyebrow'), stats, actions);
}
async function showCustomers(sort = 'spend') {
  if (!current) return;
  const { customers } = await api('customers', { definition: current, sort });
  const box = $('list'); box.hidden = false;
  const head = el('div', '', 'list-head'), select = el('select');
  [['spend', 'Most spent (90 days)'], ['recent', 'Most recent visit'], ['visits', 'Most visits (90 days)'], ['points', 'Most points']]
    .forEach(([v, t]) => { const o = el('option', t); o.value = v; select.append(o); });
  select.value = sort; select.addEventListener('change', () => showCustomers(select.value).catch(e => message(e.message, true)));
  head.append(el('h2', `Showing ${customers.length}${customers.length === 200 ? ' (first 200)' : ''}`), select);
  const table = el('table'), thead = el('thead'), tr = el('tr');
  ['Customer', 'Last visit', 'Visits · 90d', 'Spent · 90d', 'Buys most', 'Points', 'App', ''].forEach(h => tr.append(el('th', h)));
  thead.append(tr); table.append(thead);
  const body = el('tbody');
  for (const c of customers) {
    const row = el('tr'); const forget = el('button', 'Remove', 'link'); forget.type = 'button';
    forget.title = 'Customer asked to be removed from the CRM';
    forget.addEventListener('click', async () => {
      if (!confirm(`Remove ${c.name || 'this customer'} from the CRM? This deletes their purchase history here (not in GrowFlow).`)) return;
      try { await api('forget', { customerId: c.id }); row.remove(); message('Customer removed from the CRM.'); } catch (e) { message(e.message, true); }
    });
    [c.name || 'Name unavailable', ago(c.last_visit), count.format(c.visits_90), money.format(c.spend_90_cents / 100),
      LABELS[c.top_group] || '—', c.points === null ? '—' : count.format(Math.floor(c.points)), c.app_push ? 'Notifications' : c.app_linked ? 'Yes' : '—']
      .forEach(v => row.append(el('td', v)));
    const cell = el('td'); cell.append(forget); row.append(cell); body.append(row);
  }
  table.append(body);
  const wrap = el('div', '', 'table-wrap'); wrap.append(table);
  box.replaceChildren(head, wrap, el('p', 'This list was logged in Recent activity. Names come live from GrowFlow and aren’t stored.', 'muted'));
  if (!customers.length) box.append(el('p', 'No customers match.', 'muted'));
  void loadAudit();
}
async function saveSegment() {
  const name = prompt('Name this segment', currentName || '');
  if (!name) return;
  try { await api('segments/save', { name, definition: current }); message(`Saved “${name}”.`); await loadSaved(); } catch (e) { message(e.message, true); }
}
async function loadSaved() {
  const { segments } = await api('segments'), box = $('saved');
  box.replaceChildren(...segments.map(s => {
    const row = el('div', '', 'saved-row'), open = el('button', s.name, 'link'), del = el('button', 'Delete', 'link danger');
    open.type = del.type = 'button';
    open.addEventListener('click', () => { fillBuilder(s.definition); countSegment(s.definition, s.name).catch(e => message(e.message, true)); });
    del.addEventListener('click', async () => { if (!confirm(`Delete “${s.name}”?`)) return; await api('segments/delete', { id: s.id }); await loadSaved(); });
    row.append(open, el('span', `saved by ${s.created_by}`, 'muted'), del); return row;
  }));
  if (!segments.length) box.append(el('p', 'No saved segments yet. Count a segment, then choose “Save segment”.', 'muted'));
}
async function loadAudit() {
  const { audit } = await api('audit');
  const names = { view_customers: 'viewed a customer list', save_segment: 'saved a segment', delete_segment: 'deleted a segment', forget_customer: 'removed a customer' };
  $('audit').replaceChildren(...audit.map(a => el('p', `${new Date(a.at).toLocaleString()} · ${a.actor} ${names[a.action] || a.action}`)));
}

async function start() {
  try {
    session = await api('session');
    $('who').textContent = session.email;
    $('groups').replaceChildren(...session.groups.map(g => {
      const label = el('label'), box = el('input'); box.type = 'checkbox'; box.value = g; label.append(box, document.createTextNode(` ${LABELS[g]}`)); return label;
    }));
    $('templates').replaceChildren(...TEMPLATES.map(([name, def]) => {
      const b = el('button', name, 'chip'); b.type = 'button';
      b.addEventListener('click', () => { fillBuilder(def); countSegment(def, name).catch(e => message(e.message, true)); }); return b;
    }));
  } catch (e) { message(e.message, true); return; }
  // Each part loads on its own, so one slow part never blanks the whole page.
  const parts = [loadOverview(), loadSaved(), loadAudit(),
    api('brands').then(({ brands }) => $('brand').append(...brands.map(b => { const o = el('option', b.name); o.value = b.id; return o; })))];
  const failed = (await Promise.allSettled(parts)).find(r => r.status === 'rejected');
  if (failed) message(failed.reason?.message || 'Part of the page could not load. Reload to try again.', true);
}
$('builder').addEventListener('submit', e => { e.preventDefault(); const d = readBuilder();
  if (!Object.keys(d).length) { message('Add at least one rule.', true); return; }
  countSegment(d).catch(err => message(err.message, true)); });
$('show').addEventListener('click', async () => { const d = readBuilder();
  if (!Object.keys(d).length) { message('Add at least one rule.', true); return; }
  try { await countSegment(d); await showCustomers(); } catch (e) { message(e.message, true); } });
$('clear').addEventListener('click', () => { fillBuilder({}); $('preview').hidden = true; $('list').hidden = true; current = null; });
void start();
