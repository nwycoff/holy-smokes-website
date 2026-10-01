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
  ['Deals & news subscribers', { app: 'marketing' }]
];
let session = null, current = null, currentName = '', savedSegments = [], campaignSetup = null;
const TOPIC_LABELS = { new_arrivals: 'New arrivals & restocks', rewards: 'Rewards & points reminders', events: 'Events', specials: 'Specials' };
const LINK_LABELS = { home: 'App home', menu: 'Menu', rewards: 'My points', order: 'Order ahead' };

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
    kpi('On My Treehouse', count.format(t.app_linked || 0), `${count.format(t.app_push || 0)} get order alerts`),
    kpi('Get Deals & news', count.format(t.app_marketing || 0), 'opted in, with a device'),
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
    el('span', p.avgPoints === null ? '' : `average ${count.format(p.avgPoints)} points`), el('span', `${count.format(p.appLinked)} on the app · ${count.format(p.appMarketing || 0)} get Deals & news`));
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
      LABELS[c.top_group] || '—', c.points === null ? '—' : count.format(Math.floor(c.points)), c.app_marketing ? 'Deals & news' : c.app_push ? 'Order alerts' : c.app_linked ? 'Yes' : '—']
      .forEach(v => row.append(el('td', v)));
    const cell = el('td'); cell.append(forget);
    if (campaignSetup) {
      const mine = el('button', 'Use for my tests', 'link'); mine.type = 'button';
      mine.title = 'Your own record: test campaigns go to the phones on this customer’s app account';
      mine.addEventListener('click', async () => {
        try { await api('settings/test-customer', { customerId: c.id }); campaignSetup.testPhone = true; message(`Test campaigns will go to ${c.name || 'this customer'}’s phones.`); }
        catch (e) { message(e.message, true); }
      });
      cell.append(mine);
    }
    row.append(cell); body.append(row);
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
  savedSegments = segments; fillAudiences();
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
  const names = { view_customers: 'viewed a customer list', save_segment: 'saved a segment', delete_segment: 'deleted a segment', forget_customer: 'removed a customer',
    send_campaign: 'sent or scheduled a campaign', test_campaign: 'sent a test campaign', cancel_campaign: 'canceled a campaign', set_test_phone: 'chose their test phone' };
  $('audit').replaceChildren(...audit.map(a => el('p', `${new Date(a.at).toLocaleString()} · ${a.actor} ${names[a.action] || a.action}`)));
}

// --- Deals & news campaigns ---
function fillAudiences() {
  const select = $('cp-audience'), keep = select.value;
  const option = (value, text) => { const o = el('option', text); o.value = value; return o; };
  select.replaceChildren(option('all', 'Everyone opted in to the topic'), option('builder', 'The rules in “Find customers” above'),
    ...TEMPLATES.map(([name], i) => option(`tpl:${i}`, name)), ...savedSegments.map(seg => option(`seg:${seg.id}`, `Saved: ${seg.name}`)));
  if ([...select.options].some(o => o.value === keep)) select.value = keep;
}
function readCampaign() {
  const who = $('cp-audience').value, label = $('cp-audience').selectedOptions[0]?.textContent || '';
  let definition = null;
  if (who === 'builder') { definition = readBuilder(); if (!Object.keys(definition).length) throw new Error('Add at least one rule in “Find customers”, or pick another audience.'); }
  else if (who.startsWith('tpl:')) definition = TEMPLATES[Number(who.slice(4))][1];
  else if (who.startsWith('seg:')) definition = savedSegments.find(seg => seg.id === who.slice(4))?.definition || null;
  let sendAt = null;
  if ($('cp-when').value === 'later') {
    sendAt = new Date($('cp-at').value).getTime();
    if (!Number.isFinite(sendAt)) throw new Error('Pick a date and time to send.');
  }
  return { name: $('cp-name').value, topic: $('cp-topic').value, body: $('cp-body').value, link: $('cp-link').value,
    definition, audienceLabel: label.replace(/^Saved: /, ''), holdoutPct: Number($('cp-holdout').value), sendAt };
}
function describePreview(p) {
  const parts = [`Reaches ${count.format(p.reach)} ${p.reach === 1 ? 'person' : 'people'}`];
  if (p.heldBack) parts.push(`${count.format(p.heldBack)} held back to measure results`);
  if (p.weeklyLimit) parts.push(`${count.format(p.weeklyLimit)} skipped (already had ${campaignSetup.weeklyCap} this week)`);
  let text = `${parts.join(' · ')}. Only people who opted in to “${TOPIC_LABELS[$('cp-topic').value]}” and have a phone set up are counted.`;
  if (p.waitsForMorning) text += ' That time is outside 9 am–8 pm Central, so it will go out at 9 am.';
  return text;
}
async function checkCampaign() {
  const p = await api('campaigns/preview', { campaign: readCampaign() });
  $('cp-result').textContent = describePreview(p); return p;
}
function statusText(c) {
  if (c.status === 'scheduled') return `Scheduled for ${new Date(c.send_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  if (c.status === 'sending') return 'Sending';
  if (c.status === 'sent') return `Sent ${new Date(c.finished_at || c.started_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  return 'Canceled';
}
function resultText(r) {
  if (!r?.sent?.people) return '';
  const pct = g => Math.round(g.visited / g.people * 100), each = g => money.format(g.cents / g.people / 100);
  let text = `In the ${r.days >= 7 ? '7 days' : 'time'} since: ${pct(r.sent)}% of people sent it visited, ${each(r.sent)} spent per person`;
  if (r.holdout?.people) {
    text += `; held back: ${pct(r.holdout)}% visited, ${each(r.holdout)} per person.`;
    if (r.holdout.people < 30) text += ' The held-back group is small, so treat the difference as a rough guide.';
  } else text += '.';
  if (r.days < 7) text += ' Results settle after 7 days.';
  return text;
}
async function loadCampaigns() {
  let data;
  try { data = await api('campaigns'); }
  catch (e) { if (/switched on/.test(e.message)) { $('campaigns-section').hidden = true; return; } throw e; }
  const first = !campaignSetup; campaignSetup = data; $('campaigns-section').hidden = false;
  if (first) {
    const option = (value, text) => { const o = el('option', text); o.value = value; return o; };
    $('cp-topic').replaceChildren(...data.topics.map(t => { const o = option(t, TOPIC_LABELS[t] || t);
      if (t === 'specials' && !data.specialsAllowed) { o.disabled = true; o.textContent += ' (locked until confirmed)'; } return o; }));
    $('cp-link').replaceChildren(...data.links.map(l => option(l, LINK_LABELS[l] || l)));
    $('cp-holdout').replaceChildren(...data.holdouts.map(h => option(String(h), h === 10 ? '10% (recommended)' : h ? `${h}%` : 'None')));
    $('cp-holdout').value = '10'; $('cp-link').value = 'menu'; fillAudiences();
    $('cp-rules').textContent = `Customers get at most ${data.weeklyCap} a week, only 9 am–8 pm Central, and only topics they chose.`;
  }
  $('campaigns').replaceChildren(...data.campaigns.map(c => {
    const row = el('div', '', 'campaign-row'), title = el('div', '', 'title'), counts = c.counts || {};
    title.append(el('strong', c.name), el('span', statusText(c), `status ${c.status}`));
    if (['scheduled', 'sending'].includes(c.status)) {
      const cancel = el('button', 'Cancel', 'link danger'); cancel.type = 'button';
      cancel.addEventListener('click', async () => {
        if (!confirm(`Cancel “${c.name}”? Anyone not yet sent it won’t get it.`)) return;
        try { await api('campaigns/cancel', { id: c.id }); await loadCampaigns(); } catch (e) { message(e.message, true); }
      });
      title.append(cancel);
    }
    const tally = [['sent', 'sent'], ['holdout', 'held back'], ['capped', 'skipped for the weekly limit'], ['skipped', 'no longer opted in or no phone'],
      ['failed', 'couldn’t be delivered']].filter(([k]) => counts[k]).map(([k, t]) => `${count.format(counts[k])} ${t}`);
    const waiting = (counts.pending || 0) + (counts.sending || 0);
    if (waiting) tally.push(`${count.format(waiting)} still to send`);
    row.append(title, el('p', `${TOPIC_LABELS[c.topic] || c.topic} · ${c.audience_label} · opens ${LINK_LABELS[c.link] || c.link} · by ${c.created_by}`, 'muted'),
      el('p', `“${c.body}”`, 'result'));
    if (tally.length) row.append(el('p', tally.join(' · '), 'muted'));
    const result = resultText(c.results); if (result) row.append(el('p', result, 'result'));
    return row;
  }));
  if (!data.campaigns.length) $('campaigns').append(el('p', 'No campaigns yet. Write one above; send yourself a test first.', 'muted'));
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
  const parts = [loadOverview(), loadSaved(), loadAudit(), loadCampaigns(),
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
$('cp-body').addEventListener('input', () => {
  const text = $('cp-body').value.trim(); $('cp-preview').textContent = text || 'Your message appears here.';
  $('cp-count').textContent = `${text.length} of 120 characters`;
});
$('cp-when').addEventListener('change', () => { $('cp-at').hidden = $('cp-when').value !== 'later'; });
$('cp-check').addEventListener('click', () => checkCampaign().catch(e => message(e.message, true)));
$('cp-test').addEventListener('click', async () => {
  try {
    if (!campaignSetup?.testPhone) throw new Error('Choose your own customer record first: Show customers, find yourself, then “Use for my tests”.');
    await api('campaigns/test', { campaign: readCampaign() });
    message('Test queued. It should reach your phone within a minute or two, starting with “Test:”.'); void loadAudit();
  } catch (e) { message(e.message, true); }
});
$('campaign').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const campaign = readCampaign(), p = await checkCampaign();
    if (!p.reach) { message('Nobody in this audience can get it right now.', true); return; }
    const when = campaign.sendAt ? `at ${new Date(campaign.sendAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'now';
    if (!confirm(`Send “${campaign.name}” ${when} to about ${count.format(p.reach)} ${p.reach === 1 ? 'person' : 'people'}?`)) return;
    await api('campaigns/send', { campaign });
    message(campaign.sendAt ? 'Scheduled.' : 'Sending. It goes out within a minute or two.');
    $('campaign').reset(); $('cp-at').hidden = true; $('cp-holdout').value = '10'; $('cp-link').value = 'menu'; $('cp-result').textContent = '';
    $('cp-preview').textContent = 'Your message appears here.'; $('cp-count').textContent = '';
    await loadCampaigns(); void loadAudit();
  } catch (e) { message(e.message, true); }
});
void start();
