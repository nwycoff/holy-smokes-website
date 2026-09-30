# My Treehouse launch checklist

Everything below is for the **live** site: Cloudflare Pages project `holy-smokes-website` (`www.treehousepharmacy.com`), which deploys `main`. All of it was verified first on the separate `treehouse-app-test` project. Nothing live exists yet: no live app database, tokens, keys or notifier.

Every feature ships **switched off**. Merging to `main` publishes the code, but customers only see "My Treehouse is being prepared" at `/app/` until the switches in section 4 are turned on. The existing website, `/rewards` points checker and TV menus are unaffected.

Details for each step live in [CUSTOMER-APP-SETUP.md](CUSTOMER-APP-SETUP.md) (customer app, sections 1–9) and [STAFF-ENROLLMENT-SETUP.md](STAFF-ENROLLMENT-SETUP.md) (staff page).

## 1. Before launch (people, not code)

- [ ] Android phone test: order, notifications (works in Chrome without adding to the Home Screen).
- [ ] Staff walk-through on a test order: accept, attach packages, fulfill (sends "ready"), apply a reward from the order note, check out.
- [ ] Two-factor authentication on for every Cloudflare, GrowFlow and Auth0 login with access.
- [ ] Legal sign-off on storing license numbers. **Until then, leave `APP_LICENSE_MEMORY_ENABLED` off**; everything else can launch without it.
- [ ] Decide GrowFlow **Auto-accept new pre-orders** for the app's menu (recommended off at first).
- [ ] Review and merge the pull request (section 3); nothing else in this list requires code changes.

## 2. Create the live resources (before merging)

Order matters: a database migration must exist before code that reads it is deployed.

- [ ] **Live app database:** create a new D1 database (e.g. `treehouse-app-live-data`). **Not** `treehouse-points-live-limits`; that belongs to the points checker. Run every file in `app-migrations/` **in order, once each** (0001 → 0007). Keep D1 read replication off.
- [ ] Bind it to `holy-smokes-website` → Settings → Bindings → **Production** as `APP_DB`.
- [ ] **Auth0:** add the live callback, login and logout URLs for `www.treehousepharmacy.com` (CUSTOMER-APP-SETUP.md section 1). Confirm verification and password-reset emails arrive.
- [ ] **GrowFlow tokens** (new live tokens, saved in Bitwarden):
  - App token (`APP_GROWFLOW_TOKEN`): **Customers**, **Menus** and **Discounts** read only.
  - Preorder token (`APP_PREORDER_TOKEN`): **Create preorders** only. Must be a different token.
- [ ] **GrowFlow settings:** store Pre-orders on; the app's menu allows pre-orders.
- [ ] **Cloudflare Access for `/staff/`** on the live hostname, following STAFF-ENROLLMENT-SETUP.md (allow-list of individual staff emails, no Bypass).
- [ ] **Keys generated straight into Cloudflare, never displayed or saved elsewhere** (ask Claude to do these, as on the test project):
  - `APP_LIMIT_SECRET` (new random value; save in Bitwarden, since the notifier needs the same value).
  - `APP_ENROLLMENT_SECRET` only if you still want the owner terminal tool.
  - New notification key pair: public key → `APP_VAPID_PUBLIC_KEY`; private key → live notifier only.
  - `APP_LICENSE_KEY` (only when license memory is approved). Losing it only means customers re-enter their license once.

## 3. Settings on `holy-smokes-website` → Production

Start with every switch **off** (`false` or absent):

| Setting | Live value |
|---|---|
| `APP_ENABLED` | `false` until section 4 |
| `APP_ALLOWED_HOSTS` | `www.treehousepharmacy.com` (exact hostnames the app is served on) |
| `APP_AUTH_ISSUER`, `APP_AUTH_CLIENT_ID` | From the live Auth0 application |
| `APP_AUTH_CLIENT_SECRET` | Secret, from Auth0 |
| `APP_LIMIT_SECRET` | Secret (section 2) |
| `APP_GROWFLOW_TOKEN`, `APP_PREORDER_TOKEN` | Secrets (section 2) |
| `GROWFLOW_ORG` | `holysmokesdispensary` |
| `GROWFLOW_PATIENT_ID_FIELDS` | `PatientLicenseNumber,MedicalLicenseNumber,CustomerStateLicense` |
| `APP_MENU_KEY` | Secret: the published menu's key |
| `APP_FRONT_LOCATION` | Same front-room value as the test project |
| `APP_MENU_ENABLED`, `APP_PREORDER_ENABLED`, `APP_REWARD_TIERS_ENABLED`, `APP_PUSH_ENABLED`, `APP_STAFF_ENABLED` | `false` until section 4 |
| `APP_VAPID_PUBLIC_KEY` | Public half of the live key pair |
| `APP_STAFF_ACCESS_ISSUER`, `APP_STAFF_ACCESS_AUD`, `APP_STAFF_EMAILS` | From the live staff Access application |
| `APP_LICENSE_MEMORY_ENABLED` | `false` until legal sign-off |

Then merge the pull request. Pages deploys `main` to the live site.

## 4. Turn on, one step at a time

Redeploy after each change (Deployments → latest → Retry deployment) and check before moving on.

1. [ ] `APP_ENABLED=true`: sign in, and link the owner's account with a staff-page code.
2. [ ] `APP_STAFF_ENABLED=true`: approved staff can sign in at `/staff/`; an unapproved email cannot.
3. [ ] `APP_MENU_ENABLED=true`: menu matches the front-room selection and prices.
4. [ ] `APP_REWARD_TIERS_ENABLED=true`: reward list matches GrowFlow (amounts in dollars, e.g. $10, not $1,000).
5. [ ] `APP_PREORDER_ENABLED=true`: place one supervised order, check it in Sales → Pre-Orders, cancel it.
6. [ ] **Live notifier:** in `workers/order-notifier/wrangler.toml`, fill in `[env.live]` (live database ID and public key), deploy with `npx wrangler deploy --env live`, and add its secrets with `npx wrangler secret put <NAME> --env live`: `APP_VAPID_PRIVATE_JWK`, `APP_PREORDER_TOKEN` and `APP_LIMIT_SECRET` (same values as the live site). Then `APP_PUSH_ENABLED=true` on the site and test a "ready" notification.
7. [ ] Only after legal sign-off: `APP_LICENSE_KEY` + `APP_LICENSE_MEMORY_ENABLED=true`.

## 5. After launch

- Watch the logs for the first days (`npx wrangler pages deployment tail` for the site, `npx wrangler tail --env live` in `workers/order-notifier`). Codes worth attention: `PREORDER_UNCONFIRMED` (check GrowFlow for the order), `PUSH_SEND_GAVE_UP`, `REWARDS_REFRESH_*`, `MENU_REFRESH`.
- Staff update a patient's license number **and** expiration in GrowFlow when they bring a renewed card.
- To pause anything, set its switch to `false` and redeploy. Orders already in GrowFlow are unaffected.
- The `treehouse-app-test` project, its database and `treehouse-app-test-notifier` can stay for future testing, or be deleted once live is stable.
