# My Treehouse: first test release

Current additions: see [staff enrollment](STAFF-ENROLLMENT-SETUP.md), [CRM setup](CRM-SETUP.md), and [guided signup, QR attribution and rollout](SIGNUP-ROLLOUT.md). The first-release description below is historical; later sections and the linked guides describe subsequent features.

This branch adds `/app/` and a clearly labelled `/app/demo/`. It does not change the existing website navigation, the public `/rewards` checker, or the store's Windows/Raspberry Pi menus. No preorder, loyalty adjustment, marketing subscription or notification is created.

## What is implemented

- Responsive home, searchable menu, budget/category filters, points and account pages.
- Installable web app with a public offline shell. Account and API data are never cached by the service worker.
- Hosted Auth0 Universal Login (verified email, passwords/recovery managed by Auth0), Authorization Code + PKCE + state + nonce, validated RS256 signatures.
- Seven-day, revocable, opaque HttpOnly secure sessions. Provider tokens are discarded after login. Account data is cleared from the page on backgrounding/sign-out.
- Owner-issued, one-use connection codes after an in-person identity check. Codes expire after ten minutes; database stores their HMAC, not the usable code. A customer record can belong to only one app account.
- Points lookup uses only the customer ID attached to that server-side session. Browser callers cannot supply another customer's ID.
- Menu availability uses store-scoped `findInventory` quantities. Explicitly non-sellable, deleted, waste and return locations are excluded. Unknown sellability and unassigned inventory are allowed by owner policy; room names and METRC rooms do not determine eligibility.
- Brand followed by strain for flower, falling back to product name. Prices are provider variant prices in cents, with the menu's explicit tax flag. THC comes only from eligible packages; conflicting tests appear as a range. Terpenes come from the same menu lab results (`testResults`: 14 named terpenes plus `totalTerpenes`) on in-stock packages: cards on the app and tablet show total terpenes next to THC, as a range when packages differ. The total is the lab's figure, or the sum of the named terpenes when the lab gave none. The TV application is unchanged.

## Review without any secrets

Use Node 22 or newer:

```sh
npm ci
npm test
npm run build
python3 -m http.server 8876 --bind 127.0.0.1 --directory dist
```

Visit `http://127.0.0.1:8876/app/demo/`. The sample menu and 750 points are fictional. The demo never calls `/api/app/*`, accepts real patient information, places an order, or saves a login. A plain file:// URL will not load its JavaScript modules correctly.

Browser regression tests: `npx playwright install chromium`, then `npm run test:browser`. They use a loopback server and synthetic data only. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an already installed Chromium binary. Screenshots in `docs/` show the demo, not a real customer's balance.

## Approval and isolation

Remote publication requires the owner's approval. Suggested branch: `feature/treehouse-customer-app`, based on main `9dca9c56d03c832ad786256db4d9e6979d7e9463`. Do not push or merge main.

After approval, create a **separate** Cloudflare Pages project, e.g. `treehouse-app-test`, using this feature branch. Calling it the production branch *of that separate test project* does not make it the live website. Keep the live site's branch and domains unchanged.

Build command: `npm run build`; output: `dist`; root: blank; `NODE_VERSION`: `22`.

Protect the base test hostname, all deployment subdomains and all paths with Cloudflare Access before adding live secrets. Restrict access to the owner's chosen email. Preview URLs are not inherently private. Keep ordinary branch previews disabled if they are not covered by Access. Do not copy live customer credentials into arbitrary branch builds.

## 1. Set up hosted sign-in

Create an Auth0 tenant and a **Regular Web Application**. Start with an email/password database connection and Universal Login. Enable email verification and password recovery; confirm the email sender actually delivers to your own address. Choose RS256 token signing and client-secret POST token endpoint authentication. Keep bot/brute-force protections enabled. Review the provider's current plan, acceptable-use terms and email limits before adopting it for production; no paid plan is required by this code.

For the example test project:

| Auth0 setting | Value |
|---|---|
| Allowed Callback URLs | `https://treehouse-app-test.pages.dev/api/app/callback` |
| Application Login URI | `https://treehouse-app-test.pages.dev/app/` |
| Allowed Logout URLs | `https://treehouse-app-test.pages.dev/app/` |

The app clears its own sessions on logout and forces an interactive provider login on the next sign-in. It does not use hidden iframe renewal or save refresh tokens. An unverified email cannot establish an app session. No patient name, patient ID, points or purchases are sent to Auth0.

Use the stable test hostname, not a deployment hash, for sign-in testing. Only explicitly configured callback URLs should be allowed.

## 2. Create a separate D1 database

Create `treehouse-app-test-data`, execute `app-migrations/0001_customer_app.sql` in that database, and bind it as `APP_DB` on the test project. **Do not run this migration in the existing rewards limiter database.** Keep D1 read replication off for this first version so enrollment/session revocation reads use the primary database.

This database contains opaque account identities, the link to GrowFlow's customer record, expiring sessions/codes, counters and a normalized public menu cache. It does not contain passwords, patient license numbers, birth dates, purchase history or saved points balances. Protect database access and backups accordingly.

## 3. Add the test settings

Generate the two independent random app secrets locally, save them in Bitwarden, and enter them as Cloudflare **Secrets**. Do not put them in GitHub or chat. A suitable generator on Mac is `openssl rand -hex 32` (run once per secret).

| Setting | Type | Test value |
|---|---|---|
| `APP_ENABLED` | Text | `false` until setup is complete |
| `APP_ALLOWED_HOSTS` | Text | `treehouse-app-test.pages.dev` |
| `APP_AUTH_ISSUER` | Text | Your exact Auth0 tenant HTTPS URL, ending `/` |
| `APP_AUTH_CLIENT_ID` | Text | Auth0 application client ID |
| `APP_AUTH_CLIENT_SECRET` | Secret | Auth0 application client secret |
| `APP_LIMIT_SECRET` | Secret | New random value, at least 32 characters |
| `APP_ENROLLMENT_SECRET` | Secret | Different random value, at least 32 characters; owner only |
| `APP_GROWFLOW_TOKEN` | Secret | **Separate test token**, with Customers, Menus, **Packages & inventory** and **Products** read scopes (Products: edibles' servings per container) |
| `GROWFLOW_ORG` | Text | `holysmokesdispensary` |
| `GROWFLOW_PATIENT_ID_FIELDS` | Text | `PatientLicenseNumber,MedicalLicenseNumber,CustomerStateLicense` |
| `APP_MENU_ENABLED` | Text | `false` until menu validation is complete |
| `APP_MENU_KEY` | Secret | Published menu's access key |
| `APP_PREORDER_ENABLED` | Text | `false` until step 6 is complete |
| `APP_PREORDER_TOKEN` | Secret | **Another separate token** with only the Create preorders scope; must differ from `APP_GROWFLOW_TOKEN` |

GrowFlow token and menu key are different credentials. No create/write scope is needed to read inventory. Optional `APP_INVENTORY_STORE_ID` defaults to `nhB4pzbWYZ`, verified from the owner’s inventory diagnostic. Other stores must set their own ID.

Keep all `REWARDS_*` settings and the live points token unchanged. This feature uses its own `APP_*` settings and database. Rebuild/redeploy the test project after changing variables/bindings as needed by Pages. There is no production rollout in these steps.

## 4. Test account linking

1. Set `APP_ENABLED=true` on the protected test project. Leave the menu flag false initially.
2. Create your own test sign-in account, verify its email, and sign in again. You should see an unlinked account, not a patient search or points.
3. Only after checking the consenting customer's identity in person, run `node scripts/issue-app-enrollment.mjs`. Use the **enrollment secret**, never the GrowFlow token. Inputs are hidden; only a temporary code is printed.
4. If Cloudflare Access protects the test project, the CLI also needs a service token allowed by that same test Access application. It prompts for the Access client ID/secret when needed. Keep that permission limited to the test application. Do not remove Access protection to get the CLI through.
5. Give the code only to the verified customer. Enter it under My points. Confirm the balance against GrowFlow and confirm a second account cannot reuse the code or see that balance.
6. Test sign-out, sign-out on all devices, password recovery, email verification, an expired code and removal of the local app connection.

The initial owner tool is deliberately not a public staff portal. Before wider staff rollout, add individual staff roles and an audited staff UI so an enrollment secret is not shared among employees. Never give it to customers. Existing linked accounts use recovery; issuing another code must not take over the record.

## 5. Validate and enable the menu

The query is based on the supplied schema, not a completed live test of these exact new requests. Confirm on the test token:

- The menu scope returns all intended groups and the documented package/variant fields.
- Check split stock: 3 sellable Front units plus 2 non-sellable Back units must allow only 3. An item with only non-sellable stock disappears.
- Unknown sellability and unassigned inventory are allowed. Explicit non-sellable status is excluded regardless of room name; zero eligible stock stays hidden.
- Price, package size, tax flag and THC match the approved customer menu/POS. This version uses `variants.price`, not an invented medical-price or weight-tier calculation.
- If different strains share a product, fix that source record instead of inventing labels.

Then set `APP_MENU_ENABLED=true` on the test project. The shared backend refreshes at most once per minute. It can show an explicitly marked prior menu for up to five minutes during an outage; after that it hides the menu. No pickup reservation or stock promise is made.

## 6. Pickup preorders

Linked customers can add menu items to an order and send it to GrowFlow as a **pickup** preorder, paid in store. There is no delivery, pickup-time choice, online payment, points redemption or cancellation from the app.

How it works:

- The browser sends only product IDs, sizes, the prices it showed and quantities. The server looks each one up in the shared menu cache and refuses the order if an item is gone or a price changed. The total sent to GrowFlow is the server's own sum of `variants.price` × quantity. It is refused while the menu is marked delayed.
- Up to 10 items per order. One open order per account, enforced by a unique database index. Only `Completed` (checked out) and `Canceled` close an order. In GrowFlow, `Fulfilled` means packed and waiting for checkout, so the app shows it as "Ready for pickup" and keeps it open.
- GrowFlow requires the customer's first name, last name, birth date and customer type on every preorder. The server reads `Name`, `Birthday` and `CustomerType` from the **linked** customer record with `APP_GROWFLOW_TOKEN` at order time, sends them with the record's `id`, and does not store them. The first name is everything before the last word of `Name`. A record with a one-word name, a missing birth date or a type other than Medical/Recreational cannot order; the customer is asked to call.
- **Medical license number:** GrowFlow rejects medical preorders without `customer.medicalLicenseNumber`, and API tokens cannot read license numbers (they are filter-only, as in the points checker). The customer enters theirs at checkout. The server confirms it with a `findCustomers` filter on the linked record's `GROWFLOW_PATIENT_ID_FIELDS` (exact match, dashes optional, case-insensitive), then sends it. It is never stored or logged. GrowFlow also requires `medicalLicenseExpires` alongside it (a GraphQL `DateTime`; the app sends midnight UTC of the expiry date, since a bare YYYY-MM-DD fails validation); the server reads `CustomerStateLicenseExpiration` (falling back to `LicenseEffectiveEndDate`) from the linked record, and refuses the order with a "please ask your budtender" message if neither is set or the license has expired. The field sits in a real form so Android/Chrome autofill can offer to remember it on the phone; iPhone Safari does not remember custom fields. Wrong numbers count toward the 5-attempts-per-hour limit.
- `APP_PREORDER_TOKEN` is used only for `createPreorder` and `preorderStatus`. The mutation is never retried. If GrowFlow may have received a request but the app could not confirm it (timeout, server error, malformed reply), the account's order slot stays blocked as `Unconfirmed` for 30 minutes and the customer is told to call, so a retry cannot quietly become a second order. A 429 or `success: false` frees the slot immediately.
- `app_preorders` stores only the GrowFlow order ID and number, status, total, item count and times. Line items, names, birth dates and notes are not stored in the app database.
- Limits: 5 order attempts per account per hour and 10 per IP per hour (counted only after input passes validation), status checks at most once per 30 seconds per order, all within the app's shared 30 GrowFlow requests/minute.

Setup and test gates:

0. In GrowFlow, **Settings → Store settings → Menu Settings**: turn on **Pre-orders**. Decide whether to turn on **Auto-accept new pre-orders**; if it is on, app orders skip the New column and go straight to Unfulfilled. App orders appear under **Sales → Pre-Orders**, arrive with products as placeholders ("Needs Package ID"), and staff attach packages to fulfill them, as with Dutchie or Weedmaps orders. Automatic pull-sheet printing works on the Windows/iOS GrowFlow apps with a receipt printer (Settings → Print → Pre-Order Fulfillment Pull Sheet). The help center only describes customer texts coming from the menu service (such as Dutchie), so don't expect GrowFlow to text customers about app orders; the app shows the status instead.
1. Run `app-migrations/0002_customer_app_preorders.sql` in `APP_DB` after 0001.
2. Create the separate GrowFlow token with **Create preorders** only, and save it as the `APP_PREORDER_TOKEN` secret. No other token changes are needed; the customer lookup uses `APP_GROWFLOW_TOKEN`, which already has Customers read.
2b. Check the live schema: in Terminal, type `bash `, drag `scripts/mac-token-checker/Check-Preorder-Schema.command` into the window, press Enter, and paste the preorder token when asked (hidden). It makes two read-only requests (type definitions, and a status lookup for a made-up order ID), creates nothing, and prints OK/DIFF/NOTE lines. Resolve every DIFF before the test order.
3. Test first in GrowFlow's `integrations` sandbox if available (request access from apipartners@growflow.com). Otherwise do one supervised test on your own linked record and cancel it in GrowFlow.
4. Confirm in GrowFlow that the test order appears under the right existing customer (not a duplicate customer), with the right products, quantities, sizes and total, and whether a preorder holds or allocates stock.
5. **Weighted products:** each line sends `qty` (count) and, for sized variants, `weight` (e.g. 3.5). Confirm that GrowFlow reads "2 × 3.5 g" as two eighths, not 7 units or 2 g. Adjust `server/customer-app/preorders.mjs` before launch if not.
6. Check how GrowFlow reports statuses as staff fill, complete and cancel the order, and that the app follows them.
7. Only then set `APP_PREORDER_ENABLED=true` on the protected test project.

Set `APP_PREORDER_ENABLED=false` to stop new orders at any time. Existing GrowFlow orders are unaffected.

## 7. "Your order is ready" notifications

Customers with an open order can tap **Notify me when it's ready**. Their phone asks permission, and the app saves that device's Web Push subscription (`app_push_subscriptions`: the push service address and the device's public encryption keys, no names or order details). A scheduled Worker, `workers/order-notifier`, runs every minute: for orders from the last 12 hours whose owner has a subscribed device, it checks `preorderStatus` (at most once per minute per order, 10 orders per run, within the shared 30/minute GrowFlow cap) and, once an order is **Fulfilled**, sends each subscribed device an encrypted notification ("Your Treehouse order is ready…"). Completed or canceled orders are never notified.

Delivery is tracked per order and device in `app_push_deliveries` (sending, sent, failed, gone). A run leases a delivery for two minutes before sending, so overlapping runs cannot both send it; it is marked sent only after the push service accepts it. Failed sends retry after 1, 2, 4 and 8 minutes (5 attempts), a run cut off mid-send is retried when its lease expires, and retries stop once the order is picked up or canceled. Delivery is at-least-once: a run stopped between the push service accepting a message and the app recording it can resend once. Each push carries a per-order `Topic`, and the app's notifications share one tag, so a repeat replaces the earlier notification instead of stacking. `PUSH_SEND` (will retry) and `PUSH_SEND_GAVE_UP` appear in the notifier's log. Subscriptions the push service reports as gone are deleted; "Sign out on all devices" and removing the rewards connection delete them too; "Sign out" and "Turn off order notifications on this device" remove the current device.

iPhone: notifications only work after **Share → Add to Home Screen**, opening the app from that icon (iOS 16.4+). The app shows that hint in Safari. Android/Chrome works in the browser or installed.

The code sends Web Push itself (RFC 8291 encryption, RFC 8292 VAPID signing) with no extra package. Only allowlisted push services (Google, Apple, Mozilla, Microsoft) can be stored or called.

Setup for the test project:

1. Run `app-migrations/0003_customer_app_push.sql` **once** in `APP_DB` (its `ALTER TABLE` cannot be repeated). Then run `app-migrations/0005_customer_app_push_deliveries.sql`.
2. Generate a VAPID key pair. The public key goes on the Pages project as `APP_VAPID_PUBLIC_KEY` together with `APP_PUSH_ENABLED=true`, and as a var on the notifier. The private key (JWK JSON) goes **only** on the notifier Worker as the secret `APP_VAPID_PRIVATE_JWK`. If it is ever lost or exposed, generate a new pair; existing devices must tap the button again.
3. Deploy the notifier from `workers/order-notifier` (`npx wrangler deploy`). It is bound to the test `APP_DB` and has no public URL. Give it the secrets `APP_PREORDER_TOKEN` and `APP_LIMIT_SECRET` with **the same values as the Pages project** (the limiter secret must match so both share one GrowFlow budget).
4. Test: place an order, tap **Notify me**, allow notifications, close the app, then mark the order Fulfilled in GrowFlow. The notification should arrive within about two minutes, and tapping it opens the order screen.

Turn off: set `APP_PUSH_ENABLED=false` on the Pages project (hides the button) and on the notifier, or delete the notifier's cron trigger.

## 8. Loyalty rewards at checkout

**My points** lists the store's reward tiers (e.g. 225 points → $10 off) with what the customer's balance covers, and the order screen has a **Use my points** dropdown. Tiers are read live from GrowFlow: active, non-deleted discounts with `IsLoyaltyDiscount`, cached for 10 minutes (older copies are served for up to an hour during an outage), so changes in GrowFlow's loyalty settings appear automatically.

GrowFlow preorders have **no discount field**, so the app cannot apply a reward itself. It also deliberately does not call `adjustCustomerLoyaltyPoints`: that only changes the balance, and staff redeeming at checkout would deduct the points a second time. Instead:

- A tier can only be chosen when the customer's balance covers it and, for dollar rewards, the order subtotal is at least the reward amount. Others show greyed out with the reason.
- At order time the server re-reads `CurrentPoints` from the linked record, refuses a tier the customer can't afford or that exceeds the order, and adds `REWARD REQUESTED: <tier name> (<points> points at order time). Apply at checkout.` to the start of the order note. `preOrderTotal` stays the full price. The tier name is shown back to the customer on their order.
- Staff apply the loyalty discount at checkout as usual, which deducts the points in GrowFlow. Points are not reserved; the app tells customers that if they spend points in store first, it will be adjusted at the counter.

Setup: add the **Discounts** read scope to the existing `APP_GROWFLOW_TOKEN` token in GrowFlow (no new token needed), run `app-migrations/0006_customer_app_preorder_reward.sql` **once** in `APP_DB` (0004 and 0005 first), then set `APP_REWARD_TIERS_ENABLED=true` and redeploy. GrowFlow's discount `Amount` is in cents, like menu prices (a $10 reward is `1000`), confirmed against the live store. Percentage-type rewards are listed without a dollar estimate.

## 9. Remember my license number (optional, opt-in)

GrowFlow's API cannot return a customer's license number (it is filter-only), so the app can remember it itself when the customer asks. **Get legal sign-off before enabling this with real customers**: it means the app stores medical marijuana patient license numbers, and the privacy text says so.

- The order screen shows **Remember my license number for next time**, unticked by default. The number is saved only if the box is ticked **and** GrowFlow has just confirmed it matches the linked record.
- It is encrypted with AES-256-GCM under `APP_LICENSE_KEY` (32 random bytes, base64url, a Cloudflare secret used for nothing else), bound to the app account, and stored in `app_users.license_enc`. Only the last four characters (`license_hint`) are ever sent to the browser, as "On file, ending ABCD ✓".
- It is decrypted only while placing an order and re-checked against GrowFlow every time. If it no longer matches (e.g. a renewed license) or cannot be decrypted (e.g. a rotated key), it is deleted and the customer is asked again.
- It is deleted when the customer taps **Forget my saved license number** under Account, types a number without ticking the box, or removes their rewards connection. D1's Time Travel keeps prior database states (7 days free / 30 days paid), so an encrypted copy can remain in recovery history until it ages out.
- Tests check that the full number never appears in responses, logs, the session, or the unencrypted database.

Security depends on the Cloudflare account: anyone who can deploy code or change secrets there could decrypt. Require two-factor authentication and limit who has access.

Setup: run `app-migrations/0007_customer_app_saved_license.sql` **once** in `APP_DB` (before deploying this code; the session query reads its columns), set `APP_LICENSE_KEY` as a secret and `APP_LICENSE_MEMORY_ENABLED=true`, then redeploy. Rotating `APP_LICENSE_KEY` makes every saved number unreadable; customers are simply asked to enter it again. Set `APP_LICENSE_MEMORY_ENABLED=false` to hide the option and stop using saved numbers (run `UPDATE app_users SET license_enc = NULL, license_hint = NULL` to delete them).

## 10. Menu filters, photos and value

The menu has a **Filters** panel (strain type including **CBD-rich**, flower size, price band, brand) with a count beside each option and removable chips for active filters, plus sorts for **strongest THC** and **best value** (price per gram). Cards show GrowFlow product photos and descriptions when present, CBD alongside THC, and price per gram for flower sizes.

- Data comes from the same menu query, which now also reads `image`, `description` and package `testResults.cbd`. Check after deploying that the menu still loads (a missing field would log `MENU_REFRESH`).
- **CBD-rich** means tested CBD of at least 1% and at least equal to THC (CBD-dominant or balanced), from percentage lab results on eligible packages.
- Price per gram uses variant weights in grams or ounces. Prices stay GrowFlow's regular `variants.price` (tax included for this store), not `priceMedical`.
- Photos must be `https` URLs; the `/app/*` Content-Security-Policy allows `https:` images for this. Descriptions are shown as plain text (tags stripped, 400 characters).
- **Stock limits:** each size's availability comes from eligible inventory quantities (units for GrowFlow "Each" products, grams for "Grams" products; a 3.5 g size on 10 g of stock allows 2). Sizes stock cannot fill are hidden, cards say "Only N left" at 5 or fewer, and the cart stops at what is available. The server performs an uncached inventory query immediately before submission, counting all sizes of a product together, and refuses anything over stock (`OUT_OF_STOCK`). Customers never see exact inventory: availability is capped at 10 in the app. GrowFlow only deducts stock when staff attach packages, so two customers ordering the last item within the same minute can still both succeed; staff resolve that at fulfillment.
- **Purchase limits (per order):** GrowFlow's API does not expose the store's Medical Purchase Limits, so the app mirrors them: flower 84 g and concentrate 28 g (unit weight), edible 72 oz (net weight; OMMA does not separate liquid edibles), topical 72 oz (unit weight), seed 10 and clone 6. Turn on with `APP_PURCHASE_LIMITS_ENABLED=true`; if GrowFlow's limits change, override any group with `APP_PURCHASE_LIMITS` as JSON, e.g. `{"flower":84,"concentrate":28}`. Products are grouped by their GrowFlow product category **Type** (needs the **Product categories** read scope on `APP_GROWFLOW_TOKEN`; cached an hour) and otherwise by category name keywords (pre-roll, cartridge, gummies…). Items with an unknown weight or group are not counted; the POS still enforces limits, including any over time, at checkout. The cart stops additions over a limit, the order screen shows usage ("7 of 84 g flower"), and the server refuses orders over a limit.
- There are no effect-based filters ("sleepy", "energetic"): GrowFlow has no such data, and Oklahoma rules limit effect and health claims.

## 11. Deals & news (marketing notifications, opt-in)

Account has one **Notifications** card: **Order updates on this phone** (turns this device's notifications on or off; the Order page keeps its "Notify me when it's ready" button) and **Deals & news**. Linked customers can turn on Deals & news there, choosing topics: new arrivals & restocks, rewards & points reminders, events, specials. It is separate from order-ready alerts: turning it off never stops those, and order-ready permission is never used for marketing. The app asks once at a good moment (when an order is ready or picked up, or on My points); "Not now" stops the prompt for 90 days. The customer is promised **no more than 2 a week, never late at night, and discreet lock-screen wording**; the campaign sender must enforce all three.

- Consent is per account. `app_marketing_prefs` holds the chosen topics (`[]` = off), when it was last turned on and when the customer was last asked; `app_marketing_consent_log` records each change of topics with the time and where it was made (`account` or `prompt`). Both are deleted when the customer removes their rewards connection.
- Messages go to the account's devices that are set up for notifications (the same push subscriptions as order-ready alerts). The service worker opens only `/app/` screens and tags news separately (`treehouse-news`) so it never replaces an order alert.
- The CRM sync marks customers who opted in and have a device (`app_marketing`), shown as **Get Deals & news** on the dashboard and as the segment option "gets Deals & news".
- Setup: run `app-migrations/0008_customer_app_marketing.sql` in `APP_DB` and `crm-migrations/0002_crm_marketing.sql` **once** in `CRM_DB`, then set `APP_MARKETING_ENABLED=true` on the Pages project (needs push and preorders on). The privacy section in the app describes it.
- Sending campaigns is the next release; nothing sends Deals & news yet.

## API budget and operational notes

One shared menu read per minute plus at most 30 total GrowFlow queries/minute for this app/token, capped with transactional counters. Each customer's points requests are capped at ten/minute. Responses with 20 or fewer requests remaining or HTTP 429 set shared backoff using the reset/Retry-After headers. There are no automatic upstream retries. Use a separate token so other applications do not consume this app's headroom unnoticed.

Only fixed diagnostic codes such as `TREEHOUSE_APP_FAILURE LOGIN_STATE` reach application logs. GrowFlow's error text is never logged, because it can repeat back customer details; failures are logged as fixed categories such as `PREORDER_SEND_GROWFLOW_QUERY_VALIDATION`. (A temporary `APP_DIAGNOSTIC_ERRORS` switch used during testing has been removed from the code.) Do not enable request-body, Authorization, OAuth-code or raw provider-response logging in additional monitoring. Expired sessions, codes, login transactions and limiter records are pruned during sign-in. Database rows contain expiration times and are unusable after expiration even if cleanup has not yet run.

Rotate `APP_LIMIT_SECRET` to revoke all existing sessions/codes if necessary; the provider-to-customer identity link survives. Preserve database backups and auth tenant identity. Disabling `APP_ENABLED` stops the API. Setting `APP_MENU_ENABLED=false` hides the live app menu. No change to the live points site is required for either action.

Before a public launch: complete actual Auth0/Cloudflare/GrowFlow tests; test iPhone home-screen and Android installation; review privacy/retention and account-deletion handling with the chosen providers; add staff roles; and obtain a separate approval to merge/publish. Existing GrowFlow record deletion is intentionally never performed by this app.

## Later releases

Campaign sending, birthday automation, redemption, delivery and pickup-time slots are not implemented or switched on. Those need verified source fields and redemption rules. The app itself does not read order histories (the separate CRM does, for staff); it reads a linked customer's birth date only at the moment they place a preorder, because GrowFlow requires it, and does not store it.

## Primary references

- GrowFlow token scopes and limits: https://help.growflow.com/en/articles/17155099-retail-api-tokens
- Auth0 Authorization Code flow: https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow/add-login-auth-code-flow
- OAuth/OIDC implementation: https://github.com/panva/oauth4webapi
- Cloudflare transactional batches: https://developers.cloudflare.com/d1/worker-api/d1-database/
- Apple Home Screen web push: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/


## Inventory authority correction (2026-10-07)

Menu package location/sellability can disagree with actual GrowFlow inventory. The app and tablet now join menu package IDs to paginated, store-scoped `findInventory` results and sum eligible quantities. Unknown location/sellability is allowed by owner policy. An API failure is not an unknown status: failed or incomplete inventory reads block new preorders. Previously verified menus may be displayed with a stale warning for up to five minutes, but stale menus cannot be ordered from.

The v8 cache discards older menu-derived availability. The app token needs **Packages & inventory** read access; no database migration is required. Preorder validation does not reserve stock atomically: simultaneous customers can still request the same stock until GrowFlow allocates packages.


## Menu layout (2026-10-07)

The menu key may point at a single-group GrowFlow menu: group names are ignored. Each product is placed by its GrowFlow product category (`server/customer-app/taxonomy.mjs`) into a heading (Flower, Smalls, Shake, Pre-Rolls, Vapes, Concentrates, Edibles, Tinctures & Capsules, Topicals & Patches, CBD & Hemp, Seeds & Clones, Accessories; unknown categories go to More) with sub-filters such as Style, Packaging, Strength, or Type/Format/Pack. Products can be listed under extra tabs (`also`): Treehouse-grown categories under Treehouse, and CBD-rich cannabis (CBD at least 1% and at least THC) under CBD & Hemp. Waste, sample (Sample- Flower, Pre-Pack Flower Samples) and Nicotine Products categories are never shown or orderable (patients may be under 21). A new GrowFlow category needs one line in `CATEGORIES` to get its own place. Cards have a Lab results panel with cannabinoids above zero and the five largest terpenes from in-stock packages. Edible cards show mg per package instead of percentages (a percent of an edible's weight misleads), plus mg per dose when the product's **Servings per container** is filled in at intake (read from `findProducts`, same IDs as the menu; without the Products scope edibles show only the package total). Edibles filter by Per package, and by Per dose once at least half the edibles on the menu have servings; Highest THC sorts edibles by package mg.


## Email verification (optional)

Set Text variable `APP_REQUIRE_VERIFIED_EMAIL=false` to let people in without verifying their email (default: required). The app identifies people by their sign-in account and never uses the email itself; points, orders and notifications only connect to a customer record through a staff code given in person. Also switch off Auth0's verification email (Branding → Email Templates → Verification Email → off) so people aren't sent one. Google sign-ins arrive already verified either way. Trade-off: someone who mistypes their email can't reset their password later and would need a new account and a new staff code.
