import { runSync } from '../../server/crm/sync.mjs';

// Scheduled Worker: keeps the CRM database in step with GrowFlow every few minutes, then applies
// app adoption flags and retention. Only fixed diagnostic codes are logged.
export default {
  async scheduled(_event, env, ctx) {
    const deps = { fetch: (url, options) => globalThis.fetch(url, options), now: Date.now,
      report: code => { try { console.warn(`TREEHOUSE_CRM_FAILURE ${code}`); } catch { /* Never break a run. */ } } };
    ctx.waitUntil(runSync(env, deps).catch(() => deps.report('CRM_RUN')));
  }
};
