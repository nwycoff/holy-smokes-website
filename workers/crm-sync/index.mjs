import { runSync } from '../../server/crm/sync.mjs';
import { maybeVerify } from '../../server/crm/verify.mjs';
import { publishPopularity } from '../../server/crm/popularity.mjs';

// Scheduled Worker: keeps the CRM database in step with GrowFlow every few minutes, then applies
// app adoption flags and retention. Only fixed diagnostic codes are logged.
export default {
  async scheduled(_event, env, ctx) {
    const deps = { fetch: (url, options) => globalThis.fetch(url, options), now: Date.now,
      report: code => { try { console.warn(`TREEHOUSE_CRM_FAILURE ${code}`); } catch { /* Never break a run. */ } } };
    // When CRM_VERIFY_ONCE has a new label, one tick re-checks the CRM against GrowFlow instead.
    ctx.waitUntil((async () => {
      if (await maybeVerify(env, deps).catch(() => { deps.report('CRM_VERIFY'); return false; })) return;
      await runSync(env, deps);
      await publishPopularity(env, deps.now()).catch(() => deps.report('CRM_POPULARITY'));
    })().catch(() => deps.report('CRM_RUN')));
  }
};
