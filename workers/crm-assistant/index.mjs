import { tickAssistant } from '../../server/crm/assistant.mjs';

// Scheduled Worker: every 5 minutes it queues the campaign assistant's weekly plan (Mondays
// 9 am Central) or daily check (10 am), picks up runs requested from the CRM, and runs one.
// The assistant only writes suggestions; people approve them in the CRM. Only fixed codes are logged.
export default {
  async scheduled(_event, env, ctx) {
    const deps = { now: Date.now,
      report: code => { try { console.warn(`TREEHOUSE_CRM_FAILURE ${code}`); } catch { /* Never break a run. */ } } };
    ctx.waitUntil(tickAssistant(env, deps).catch(() => deps.report('ASSISTANT_TICK')));
  }
};
