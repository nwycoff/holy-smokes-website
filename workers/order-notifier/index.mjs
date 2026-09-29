import { notifyReadyOrders } from '../../server/customer-app/push.mjs';

// Scheduled Worker: GrowFlow has no webhooks, so this checks recent open app orders every
// minute and sends "your order is ready" when one is marked Fulfilled. Only fixed
// diagnostic codes are logged.
export default {
  async scheduled(_event, env, ctx) {
    const deps = { fetch: (url, options) => globalThis.fetch(url, options), now: Date.now,
      report: code => { try { console.warn(`TREEHOUSE_APP_FAILURE ${code}`); } catch { /* Never break a run. */ } } };
    ctx.waitUntil(notifyReadyOrders(env, deps).catch(() => deps.report('NOTIFIER_RUN')));
  }
};
