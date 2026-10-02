import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { AppError, bodyJSON, fetchSafe, hash, json, randomToken, sameOrigin } from '../customer-app/http.mjs';
import { crmReady, forgetStatements } from './sync.mjs';
import { GROUPS, members, preview, validateDefinition } from './segments.mjs';
import { overview } from './insights.mjs';
import { assistantReady, assistantView, decideSuggestion, requestRun, setAssistantUpdates } from './suggestions.mjs';
import { saveWelcomeConfig, welcomeConfig, welcomeStats } from './welcome.mjs';
import { campaignsReady, cancelCampaign, createAutomation, createCampaign, listAutomations, listCampaigns, previewCampaign,
  setAutomationActive, validateAutomation, validateCampaign, AUTOMATION_HOUR, COOLDOWNS, HOLDOUTS, LINKS, QUIET, WEEKLY_CAP } from './campaigns.mjs';
import { TOPICS } from '../customer-app/marketing.mjs';
import { getMenu } from '../customer-app/growflow.mjs';
import { menuReady } from '../customer-app/http.mjs';

// Owner/manager CRM at /crm/, behind its own Cloudflare Access application. Every request is
// re-verified here (signature, issuer, audience, approved email). Customer names are fetched
// live from GrowFlow for display and never stored; list views, exports and removals are audited.
const DAY = 86400000;
const resolvers = new WeakMap();
function config(env) {
  const issuer = String(env.CRM_ACCESS_ISSUER || '').replace(/\/$/, '');
  const audience = String(env.CRM_ACCESS_AUD || '');
  const emails = String(env.CRM_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (env.CRM_ENABLED !== 'true' || !crmReady(env) || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)
    || !/^[a-f0-9]{64}$/.test(audience) || !emails.length || emails.some(v => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
    || typeof env.CRM_SECRET !== 'string' || env.CRM_SECRET.length < 32)
    throw new AppError('CRM_CONFIG');
  return { issuer, audience, emails };
}
async function authenticate(request, env, deps) {
  const { issuer, audience, emails } = config(env);
  const assertion = request.headers.get('cf-access-jwt-assertion');
  if (!assertion || assertion.length > 16384) throw new AppError('CRM_AUTH', 401);
  let cache = resolvers.get(deps.fetch);
  if (!cache) { cache = new Map(); resolvers.set(deps.fetch, cache); }
  let keys = cache.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      cacheMaxAge: 300000, cooldownDuration: 30000, timeoutDuration: 10000,
      [customFetch]: (url, init) => fetchSafe(deps, url, init)
    });
    if (cache.size >= 4) cache.clear();
    cache.set(issuer, keys);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(assertion, keys, {
      issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email', 'type'],
      currentDate: new Date(deps.now()), clockTolerance: 5, maxTokenAge: '8h'
    }));
  } catch { throw new AppError('CRM_AUTH', 401); }
  if (payload.type !== 'app' || typeof payload.email !== 'string' || !emails.includes(payload.email.toLowerCase()))
    throw new AppError('CRM_FORBIDDEN', 403);
  return { email: payload.email.toLowerCase(), csrf: await hash(env.CRM_SECRET, `crm-csrf:${assertion}`) };
}

async function limit(env, deps, key, max, windowMs = 60000) {
  const now = deps.now(), bucket = Math.floor(now / windowMs);
  const row = await env.CRM_DB.prepare(`INSERT INTO crm_limits(key, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`)
    .bind(await hash(env.CRM_SECRET, `${key}:${bucket}`), (bucket + 1) * windowMs).first();
  if (!row || row.hits > max) throw new AppError('CRM_LIMIT', 429);
}
async function audit(env, deps, actor, action, detail) {
  await env.CRM_DB.prepare('INSERT INTO crm_audit(id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(randomToken(), deps.now(), actor, action, detail ? JSON.stringify(detail).slice(0, 2000) : null).run();
}

// Live display names from GrowFlow (read-only CRM token). Nothing here is written anywhere.
const NAMES_QUERY = `query TreehouseCrmNames($ids: [ID!]) {
  findCustomers(where: { objectId: { in: $ids } }, first: 100) { edges { node { objectId Name } } }
}`;
async function names(env, deps, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const res = await fetchSafe(deps, `https://retail.growflow.com/c/${env.GROWFLOW_ORG}/graphql`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.CRM_GROWFLOW_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: NAMES_QUERY, variables: { ids: ids.slice(i, i + 100) } })
    }, 20000);
    if (!res.ok) throw new AppError(res.status === 429 ? 'CRM_RATE_LIMITED' : 'CRM_NAMES');
    const payload = await res.json();
    if (payload.errors?.length) throw new AppError('CRM_NAMES');
    for (const edge of payload.data?.findCustomers?.edges || [])
      if (typeof edge?.node?.objectId === 'string') out.set(edge.node.objectId, String(edge.node.Name || '').trim().slice(0, 120));
  }
  return out;
}

export async function handleCrm({ request, env }, overrides = {}) {
  const deps = { fetch: (url, init) => globalThis.fetch(url, init), now: Date.now,
    report: code => console.warn(`TREEHOUSE_CRM_FAILURE ${code}`), ...overrides };
  const url = new URL(request.url), route = url.pathname.replace(/^\/api\/crm\//, '').replace(/\/$/, '');
  const allowed = { session: 'GET', overview: 'GET', brands: 'GET', segments: 'GET', audit: 'GET',
    preview: 'POST', customers: 'POST', 'segments/save': 'POST', 'segments/delete': 'POST', forget: 'POST',
    campaigns: 'GET', 'campaigns/preview': 'POST', 'campaigns/send': 'POST', 'campaigns/test': 'POST', 'campaigns/cancel': 'POST',
    'settings/test-customer': 'POST', 'automations/create': 'POST', 'automations/active': 'POST',
    assistant: 'GET', 'assistant/run': 'POST', 'assistant/decide': 'POST', 'settings/assistant-updates': 'POST', 'welcome/save': 'POST' };
  if (!allowed[route]) return json(404, { error: 'Not found.' });
  if (allowed[route] !== request.method) return json(405, { error: 'Method not allowed.' }, { Allow: allowed[route] });
  try {
    const user = await authenticate(request, env, deps);
    await limit(env, deps, `crm:${user.email}`, 120);
    if (request.method === 'POST' && (!sameOrigin(request) || request.headers.get('x-crm-csrf') !== user.csrf))
      throw new AppError('CRM_CSRF', 403);
    const now = deps.now(), db = env.CRM_DB;
    if (route === 'session') return json(200, { email: user.email, csrf: user.csrf, groups: GROUPS });
    if (route === 'overview') return json(200, await overview(env, now));
    if (route === 'brands') {
      const { results = [] } = await db.prepare(`SELECT b.id, b.name, SUM(l.net_cents) AS cents FROM crm_brands b
        JOIN crm_lines l ON l.brand_id = b.id AND l.sold_at >= ? AND l.returned = 0 GROUP BY b.id ORDER BY cents DESC LIMIT 100`)
        .bind(now - 365 * DAY).run();
      return json(200, { brands: results.map(({ id, name }) => ({ id, name })) });
    }
    if (route === 'segments') {
      const { results = [] } = await db.prepare('SELECT id, name, definition, created_by, updated_at FROM crm_segments ORDER BY name').bind().run();
      return json(200, { segments: results.map(s => ({ ...s, definition: JSON.parse(s.definition) })) });
    }
    if ((route.startsWith('campaigns') || route.startsWith('automations') || route.startsWith('assistant') || route.startsWith('welcome')) && !campaignsReady(env))
      throw new AppError('CAMPAIGNS_CONFIG');
    if ((route.startsWith('assistant') || route === 'settings/assistant-updates') && !assistantReady(env)) throw new AppError('ASSISTANT_CONFIG');
    if (route === 'assistant') return json(200, await assistantView(env, now, user.email));
    const testCustomer = async () => (await db.prepare('SELECT test_customer_id FROM crm_settings WHERE email = ?')
      .bind(user.email).first())?.test_customer_id || null;
    // Today's menu sections and brands, for campaigns that open the menu filtered to one.
    const menuChoices = async () => {
      if (!menuReady(env)) return { categories: [], brands: [] };
      try {
        const menu = await getMenu(env, { ...deps, report: () => {} });
        return { categories: menu.categories || [], brands: [...new Set(menu.products.map(p => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b)) };
      } catch { return { categories: [], brands: [] }; }
    };
    if (route === 'campaigns') return json(200, { campaigns: await listCampaigns(env, now), testPhone: Boolean(await testCustomer()),
      menuChoices: await menuChoices(),
      topics: TOPICS, links: Object.keys(LINKS), holdouts: HOLDOUTS,
      weeklyCap: WEEKLY_CAP, quietHours: QUIET, automations: await listAutomations(env, now), cooldowns: COOLDOWNS,
      automationHour: AUTOMATION_HOUR, welcome: { ...await welcomeConfig(env), ...await welcomeStats(env) } });
    if (route === 'audit') {
      const { results = [] } = await db.prepare('SELECT at, actor, action, detail FROM crm_audit ORDER BY at DESC LIMIT 100').bind().run();
      return json(200, { audit: results });
    }
    const input = await bodyJSON(request);
    if (route === 'preview') return json(200, await preview(db, validateDefinition(input.definition), now));
    if (route === 'customers') {
      const def = validateDefinition(input.definition), sort = ['spend', 'recent', 'visits', 'points'].includes(input.sort) ? input.sort : 'spend';
      await limit(env, deps, `crm-list:${user.email}`, 20);
      const rows = await members(db, def, now, sort, 200);
      const named = rows.length ? await names(env, deps, rows.map(r => r.id)) : new Map();
      await audit(env, deps, user.email, 'view_customers', { definition: def, sort, shown: rows.length });
      return json(200, { customers: rows.map(r => ({ ...r, name: named.get(r.id) || null })) });
    }
    if (route === 'segments/save') {
      const def = validateDefinition(input.definition);
      const name = typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80) : '';
      if (!name) throw new AppError('SEGMENT_NAME', 400);
      const segmentId = typeof input.id === 'string' && /^[a-f0-9]{64}$/.test(input.id) ? input.id : randomToken();
      await db.prepare(`INSERT INTO crm_segments(id, name, definition, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at`)
        .bind(segmentId, name, JSON.stringify(def), user.email, now, now).run();
      await audit(env, deps, user.email, 'save_segment', { name });
      return json(200, { id: segmentId });
    }
    if (route === 'segments/delete') {
      if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw new AppError('INPUT', 400);
      await db.prepare('DELETE FROM crm_segments WHERE id = ?').bind(input.id).run();
      await audit(env, deps, user.email, 'delete_segment', null);
      return json(200, { deleted: true });
    }
    if (route === 'campaigns/preview') return json(200, await previewCampaign(env, validateCampaign(input.campaign, env, now), now));
    if (route === 'campaigns/send') {
      await limit(env, deps, `crm-send:${user.email}`, 10, 3600000);
      const campaign = validateCampaign(input.campaign, env, now), id = await createCampaign(env, user.email, campaign, now);
      await audit(env, deps, user.email, 'send_campaign', { name: campaign.name, topic: campaign.topic, audience: campaign.audienceLabel,
        sendAt: campaign.sendAt });
      return json(200, { id });
    }
    if (route === 'campaigns/test') {
      await limit(env, deps, `crm-test:${user.email}`, 10, 600000);
      const customerId = await testCustomer();
      if (!customerId) throw new AppError('CAMPAIGN_TEST_PHONE', 400);
      await createCampaign(env, user.email, validateCampaign(input.campaign, env, now), now, customerId);
      await audit(env, deps, user.email, 'test_campaign', null);
      return json(200, { queued: true });
    }
    if (route === 'assistant/run') {
      await limit(env, deps, `crm-assistant:${user.email}`, 6, 3600000);
      const result = await requestRun(env, user.email, input.kind, now);
      if (!result.already) await audit(env, deps, user.email, 'assistant_run', { kind: input.kind });
      return json(200, result);
    }
    if (route === 'settings/assistant-updates') {
      const result = await setAssistantUpdates(env, user.email, input.on, now);
      await audit(env, deps, user.email, input.on ? 'assistant_updates_on' : 'assistant_updates_off', null);
      return json(200, result);
    }
    if (route === 'assistant/decide') {
      const result = await decideSuggestion(env, user.email, input, now);
      await audit(env, deps, user.email, `${result.decision === 'approved' ? 'approve' : result.decision === 'edited' ? 'edit' : 'dismiss'}_suggestion`, null);
      return json(200, result);
    }
    if (route === 'automations/create') {
      await limit(env, deps, `crm-send:${user.email}`, 10, 3600000);
      const automation = validateAutomation(input.automation, env, now), id = await createAutomation(env, user.email, automation, now);
      await audit(env, deps, user.email, 'create_automation', { name: automation.name, topic: automation.topic,
        audience: automation.audienceLabel, cooldownDays: automation.cooldownDays });
      return json(200, { id });
    }
    if (route === 'automations/active') {
      if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id) || typeof input.active !== 'boolean') throw new AppError('INPUT', 400);
      await setAutomationActive(env, input.id, input.active, now);
      await audit(env, deps, user.email, input.active ? 'resume_automation' : 'pause_automation', null);
      return json(200, { active: input.active });
    }
    if (route === 'welcome/save') {
      const config = await saveWelcomeConfig(env, user.email, input.welcome, now);
      await audit(env, deps, user.email, 'welcome_gift', { on: config.on, description: config.description, endsOn: config.endsOn });
      return json(200, { welcome: { ...config, ...await welcomeStats(env) } });
    }
    if (route === 'campaigns/cancel') {
      if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw new AppError('INPUT', 400);
      await cancelCampaign(env, input.id, now);
      await audit(env, deps, user.email, 'cancel_campaign', null);
      return json(200, { canceled: true });
    }
    if (route === 'settings/test-customer') {
      if (typeof input.customerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.customerId)) throw new AppError('INPUT', 400);
      await db.prepare(`INSERT INTO crm_settings(email, test_customer_id, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET test_customer_id = excluded.test_customer_id, updated_at = excluded.updated_at`)
        .bind(user.email, input.customerId, now).run();
      await audit(env, deps, user.email, 'set_test_phone', null);
      return json(200, { testPhone: true });
    }
    if (route === 'forget') {
      // A customer's request to be removed. Their GrowFlow record is untouched.
      if (typeof input.customerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.customerId)) throw new AppError('INPUT', 400);
      await db.batch(forgetStatements(db, input.customerId));
      await audit(env, deps, user.email, 'forget_customer', null);
      return json(200, { forgotten: true });
    }
  } catch (error) {
    // Unexpected errors are logged as a fixed category, never their text.
    const text = String(error?.message || ''), known = error instanceof AppError;
    const code = known ? error.code : /overloaded|too many|busy|locked/i.test(text) ? 'CRM_DB_BUSY'
      : /timeout|timed out/i.test(text) ? 'CRM_DB_TIMEOUT' : /D1_|SQLITE|no such|constraint/i.test(text) ? 'CRM_DB_ERROR' : 'INTERNAL';
    // Database messages describe SQL, not rows; numbers are masked anyway.
    const detail = code.startsWith('CRM_DB_') ? ` ${text.replace(/\d+/g, '#').slice(0, 200)}` : '';
    try { deps.report(code + detail); } catch { /* Logging never breaks a response. */ }
    const messages = { CRM_AUTH: 'Please sign in again.', CRM_FORBIDDEN: 'This account is not approved for the CRM.',
      CRM_CONFIG: 'The CRM is not set up yet.', CRM_LIMIT: 'Too many requests. Please wait a minute.',
      CRM_CSRF: 'Please reload the page and try again.', SEGMENT_RULES: 'Please check the segment rules.',
      SEGMENT_NAME: 'Please give the segment a name.', CRM_RATE_LIMITED: 'GrowFlow is busy. Please try again in a minute.',
      INPUT: 'Please check the information and try again.',
      CAMPAIGNS_CONFIG: 'Deals & news campaigns aren’t switched on yet.', ASSISTANT_CONFIG: 'The campaign assistant isn’t switched on yet.',
      SUGGESTION_DONE: 'That suggestion was already decided or has expired.',
      WELCOME_DESCRIPTION: 'Describe the gift (shown in the app), e.g. “a pre-roll for a penny”.',
      WELCOME_CODE: 'The notification needs {code} where the customer’s code goes.', CAMPAIGN_NAME: 'Please give the campaign a name.',
      CAMPAIGN_LENGTH: 'The message needs to be 10 to 120 characters.',
      CAMPAIGN_DISCREET: 'Notifications show on lock screens, so please leave out cannabis words (product types, THC, strains, weights). Say it inside the app instead.',
      CAMPAIGN_CLAIMS: 'Please leave out health claims (pain, anxiety, relief, cures…). Oklahoma rules don’t allow them.',
      CAMPAIGN_TIME: 'Please pick a time within the next 30 days.', CAMPAIGN_DONE: 'That campaign has already finished.',
      CAMPAIGN_TEST_PHONE: 'Choose your own customer record first: Show customers, find yourself, then “Use for my tests”.',
      CRM_DB_BUSY: 'The CRM is busy loading history from GrowFlow. Please try again in a moment.',
      CRM_DB_TIMEOUT: 'That took too long while history is loading. Please try again in a moment.' };
    return json(known ? error.status : 503, { error: messages[code] || 'The CRM is temporarily unavailable.' });
  }
}
