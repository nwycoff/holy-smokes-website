# My Treehouse: first test release

This branch adds `/app/` and a clearly labelled `/app/demo/`. It does not change the existing website navigation, the public `/rewards` checker, or the store's Windows/Raspberry Pi menus. No preorder, loyalty adjustment, marketing subscription or notification is created.

## What is implemented

- Responsive home, searchable menu, budget/category filters, points and account pages.
- Installable web app with a public offline shell. Account and API data are never cached by the service worker.
- Hosted Auth0 Universal Login (verified email, passwords/recovery managed by Auth0), Authorization Code + PKCE + state + nonce, validated RS256 signatures.
- Seven-day, revocable, opaque HttpOnly secure sessions. Provider tokens are discarded after login. Account data is cleared from the page on backgrounding/sign-out.
- Owner-issued, one-use connection codes after an in-person identity check. Codes expire after ten minutes; database stores their HMAC, not the usable code. A customer record can belong to only one app account.
- Points lookup uses only the customer ID attached to that server-side session. Browser callers cannot supply another customer's ID.
- Menu requires **both** the configured GrowFlow front storage location and `isSellable: true`, with positive package stock. Missing/unknown package locations are excluded. METRC room names are not used.
- Brand followed by strain for flower, falling back to product name. Prices are provider variant prices in cents, with the menu's explicit tax flag. THC comes only from eligible front-room packages; conflicting tests appear as a range. Individual terpene enrichment is not included in this first mobile release; the TV application is unchanged.

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
| `APP_GROWFLOW_TOKEN` | Secret | **Separate test token**, with Customers and Menus read scopes only |
| `GROWFLOW_ORG` | Text | `holysmokesdispensary` |
| `GROWFLOW_PATIENT_ID_FIELDS` | Text | `PatientLicenseNumber,MedicalLicenseNumber,CustomerStateLicense` |
| `APP_MENU_ENABLED` | Text | `false` until menu validation is complete |
| `APP_MENU_KEY` | Secret | Published menu's access key |
| `APP_FRONT_LOCATION` | Text | Exact `packages.storageLocation` value verified from the API for the front room |

GrowFlow token and menu key are different credentials. No create/write scope is needed. Store names shown in the dashboard do not prove whether `storageLocation` returns a name or identifier; inspect the selected menu response privately before setting it. A wrong/missing value results in no eligible products, never a fallback to back-room stock.

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
- A front/sellable package appears; a back/non-sellable package does not. Check a product present in both rooms.
- The configured front value is exact. Unknown sellability/location and zero stock stay hidden.
- Price, package size, tax flag and THC match the approved customer menu/POS. This version uses `variants.price`, not an invented medical-price or weight-tier calculation.
- If different strains share a product, fix that source record instead of inventing labels.

Then set `APP_MENU_ENABLED=true` on the test project. The shared backend refreshes at most once per minute. It can show an explicitly marked prior menu for up to five minutes during an outage; after that it hides the menu. No pickup reservation or stock promise is made.

## API budget and operational notes

One shared menu read per minute plus at most 30 total GrowFlow queries/minute for this app/token, capped with transactional counters. Each customer's points requests are capped at ten/minute. Responses with 20 or fewer requests remaining or HTTP 429 set shared backoff using the reset/Retry-After headers. There are no automatic upstream retries. Use a separate token so other applications do not consume this app's headroom unnoticed.

Only fixed diagnostic codes such as `TREEHOUSE_APP_FAILURE LOGIN_STATE` reach application logs. Do not enable request-body, Authorization, OAuth-code or raw provider-response logging in additional monitoring. Expired sessions, codes, login transactions and limiter records are pruned during sign-in. Database rows contain expiration times and are unusable after expiration even if cleanup has not yet run.

Rotate `APP_LIMIT_SECRET` to revoke all existing sessions/codes if necessary; the provider-to-customer identity link survives. Preserve database backups and auth tenant identity. Disabling `APP_ENABLED` stops the API. Setting `APP_MENU_ENABLED=false` hides the live app menu. No change to the live points site is required for either action.

Before a public launch: complete actual Auth0/Cloudflare/GrowFlow tests; test iPhone home-screen and Android installation; review privacy/retention and account-deletion handling with the chosen providers; add staff roles; and obtain a separate approval to merge/publish. Existing GrowFlow record deletion is intentionally never performed by this app.

## Later releases

Offers/push, birthday automation, purchase-history segments, redemption and preorders are not implemented or switched on. A push permission prompt is not shown. Those features need separate consent, verified source fields, redemption rules and preorder testing. The current release does not access order histories or birthdays.

## Primary references

- GrowFlow token scopes and limits: https://help.growflow.com/en/articles/17155099-retail-api-tokens
- Auth0 Authorization Code flow: https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow/add-login-auth-code-flow
- OAuth/OIDC implementation: https://github.com/panva/oauth4webapi
- Cloudflare transactional batches: https://developers.cloudflare.com/d1/worker-api/d1-database/
- Apple Home Screen web push: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
