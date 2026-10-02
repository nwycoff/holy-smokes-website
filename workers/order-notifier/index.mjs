import { notifyReadyOrders } from '../../server/customer-app/push.mjs';
import { sendCampaigns, sendOwnerAlerts } from '../../server/crm/campaigns.mjs';

// Scheduled Worker: GrowFlow has no webhooks, so this checks recent open app orders every
// minute and sends "your order is ready" when one is marked Fulfilled. It also sends Deals &
// news campaigns written in the CRM. Only fixed diagnostic codes are logged.
export default {
  async scheduled(_event, env, ctx) {
    const deps = { fetch: (url, options) => globalThis.fetch(url, options), now: Date.now,
      report: code => { try { console.warn(`TREEHOUSE_APP_FAILURE ${code}`); } catch { /* Never break a run. */ } } };
    ctx.waitUntil(Promise.all([notifyReadyOrders(env, deps).catch(() => deps.report('NOTIFIER_RUN')),
      sendCampaigns(env, deps).catch(() => deps.report('CAMPAIGN_RUN')),
      sendOwnerAlerts(env, deps).catch(() => deps.report('OWNER_ALERTS'))]));
  }
};
