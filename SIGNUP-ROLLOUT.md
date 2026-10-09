# App signup and source tracking

Prepared for review on `feature/app-signup-attribution`. The owner authorizes pushes to test branches as work proceeds; pushing or merging to `main` still requires explicit approval. Start on the protected customer-app test project; use its test databases and Auth0 application. This change does not require any new GrowFlow permissions or API pulls.

## What customers and staff see

- A four-step setup page at `/app/#setup`: create an account and verify email, connect rewards, add to Home Screen, then choose optional phone notifications.
- Separate **Create account** and **Already have an account? Sign in** actions. Auth0 continues to own passwords and recovery.
- Unverified sign-ins get inbox/spam instructions and a continue button. An optional, secured resend button is available after the extra Auth0 setup below.
- After entering a valid connection code, the app immediately reloads the linked session and shows points and notification choices.
- Points and ordering do not require marketing consent. On iPhone, install and reopen the Home Screen app before enabling push notifications; the same account keeps its rewards connection across sign-ins.
- Existing linked customers continue to land on their points. Unlinked customers land on the setup page.
- **Install Treehouse** opens the browser's native installation prompt only when a supported browser provides one and the customer taps the button. Dismissal or failure leaves points and ordering available, with manual instructions as a fallback.
- iPhone/iPad show an illustrated Safari guide: Share → Add to Home Screen → enable **Open as Web App** if offered → Add. Website code cannot open this system installation screen on iOS. Customers reopen the Treehouse icon, sign in to the same account if asked, and choose notifications under **Account** (or return to **Open setup guide**).
- The Home Screen step is checked only when the app is running in standalone mode. Clicking instructions, accepting the browser prompt, and the `appinstalled` event alone do not mark it complete. This is local display state, not a new CRM installation metric. Installation never opts someone into push or marketing.

The installation update needs only a test branch deployment; it adds no migration, setting, permission, or secret. References: [browser installation prompts](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable#triggering_the_install_prompt), [Apple's Home Screen instructions](https://support.apple.com/guide/iphone/iphea86e5236/ios).

Keep the in-person identity check. Have the customer create and verify their account first. Once they reach **Connection code**, the budtender verifies the matching GrowFlow record and generates the existing eight-digit, single-use code. It still expires after ten minutes. Staff do not need customer passwords. Already-linked customers should recover their existing account.

## Test configuration

Make these changes only in the protected test environment initially. Keep current Access protection, approved hostnames, Auth0 callback URLs and existing secrets.

The configured `treehouse-app-test` Pages project uses `feature/treehouse-customer-app` as its default deployment branch. Publish the reviewed signup changes to that test branch and use `https://treehouse-app-test.pages.dev/app/#setup`. Cloudflare calls this project's default environment **Production**, even though it is our separate test site. Apply the settings below to that environment in **treehouse-app-test**. This does not mean the live `holy-smokes-website` project or the Git `main` branch.

`feature/app-signup-attribution` is the review branch. Its preview URL is not the end-to-end test target: previews have separate bindings/settings and their hostname needs its own app/Auth0 configuration. Keep the existing test hostname and Access protection instead of copying secrets or changing login hostnames just for this rollout.

| Where | Change |
| --- | --- |
| Test `APP_DB` | Execute `app-migrations/0009_signup.sql` once, after the existing app migrations. |
| Test `CRM_DB` | Execute `crm-migrations/0010_signup_spend.sql` once, after the existing CRM migrations. |
| Test Pages project | Ensure `APP_DB` and `CRM_DB` refer to those test databases. Both bindings are needed for the report. |
| Test Pages project, Text variable | Set `APP_SIGNUP_TRACKING_ENABLED` to `true`. Omitted or `false` disables new tracking. |
| Test Pages build | Use the existing `npm run build` command and `dist` output. Pages bundles `functions/` from the repository. |

The SQL files only add tables and indexes, and are safe to execute again. Do not substitute the public rewards-checker database for `APP_DB`. No notifier or CRM sync Worker deployment is needed for this release; the report reads sales already synced by the existing CRM.

Publish the reviewed commit to a feature branch and deploy it to the protected test project. Check which projects auto-deploy that branch before pushing. A separate branch alone does not guarantee that every Cloudflare preview is protected. Live GrowFlow/Auth0 credentials must not be exposed to unprotected test deployments. Production publication remains subject to the owner's explicit approval.

### Optional email resend

The guided flow works without this. To enable the **Resend verification email** button:

1. In the **same Auth0 tenant** as the customer login application, create a separate Machine-to-Machine application for verification-email requests.
2. Authorize the Auth0 Management API with only `update:users`, the permission Auth0 documents for its verification-email job. This permission is broader than email sending, so keep this M2M client separate and its secret server-side.
3. On the test Pages project, add these settings:

| Name | Type | Value |
| --- | --- | --- |
| `APP_AUTH_RESEND_ENABLED` | Text | `true` |
| `APP_AUTH_RESEND_DOMAIN` | Text | The tenant's canonical hostname, such as `tenant.us.auth0.com`; no `https://`, path or custom login domain. |
| `APP_AUTH_RESEND_CLIENT_ID` | Text | The separate M2M application's client ID. |
| `APP_AUTH_RESEND_CLIENT_SECRET` | Secret | That M2M application's secret. |

Keep `APP_AUTH_CLIENT_ID`, `APP_AUTH_CLIENT_SECRET` and `APP_AUTH_ISSUER` as the existing customer login application's settings. Do not replace them with the M2M credentials. Keep the new secret in the owner's password manager and Cloudflare Secrets, never in Git, the browser or chat.

The resend API accepts no email or user ID from the browser. It requires proof from a fully signature-validated Auth0 sign-in with an unverified email, valid for ten minutes, plus CSRF validation. It supports Auth0 database accounts; social providers handle their own verification. Limits: one request per account per fixed minute, three per UTC day, 30 per IP per 15 minutes, and 100 across the app per hour. No automatic retry. The UI reports that an email was requested; it does not claim delivery.

Auth0 still needs a working email provider and verification-email template. Verify actual delivery to one new consenting test account, including Spam/Junk. If resend configuration fails, customers still have the sign-in-again and shop-help options.

References: [Auth0 email verification](https://auth0.com/docs/manage-users/user-accounts/verify-emails), [resend verification emails and required scope](https://auth0.com/docs/manage-users/user-accounts/resend-verification-emails), [WebKit Home Screen web push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Source links and QR codes

Each placement needs its own link. Existing cards that all point at `/app` cannot be distinguished retroactively. Keep those cards usable, and switch QR codes when replacing or reprinting them.

| Placement | Path on `https://www.treehousepharmacy.com` | Printable SVG |
| --- | --- | --- |
| Register 1 | `/go/register-1` | `assets/signup-qr/register-1.svg` |
| Register 2 | `/go/register-2` | `assets/signup-qr/register-2.svg` |
| Bag insert | `/go/bag-card-v1` | `assets/signup-qr/bag-card-v1.svg` |
| Menu TVs | `/go/menu-tvs` | `assets/signup-qr/menu-tvs.svg` |
| Website app link | `/go/website` | `assets/signup-qr/website.svg` |
| Social media (caption or bio link) | `/go/social` | none: posts carry the link |

The CRM's **App signups → Source links and printable QR codes** provides these links and downloads. The SVGs encode the live `www.treehousepharmacy.com` domain even on test deployments. Do not print/distribute them until the routes are published and physically scan-tested on an iPhone and Android. During testing, open the corresponding `/go/...` path on the protected test hostname manually.

Keep black modules on white with the existing empty border, avoid logos over the code, and print a readable URL below it. For a bag insert, start around 1.25 inches square and test the actual print. Staff may handwrite the temporary connection code on a slip only after verifying the customer; never put it, a patient ID or a customer name into the tracked link.

**App signups → Marketing materials** in the CRM has the social images (1080×1080 feed post, 1080×1920 story), the printable flyer and a suggested caption with the `/go/social` link. The images are rendered from `marketing/app-social.html` with `node scripts/marketing-images.mjs`; they stick to the app itself (no products, prices or discounts) so posts stay within Instagram and Facebook rules for cannabis businesses.

The generator is developer-only: `pip install qrcode==8.2` and `python scripts/signup-qr.py`. Python is not needed by Cloudflare or by staff. Updating the actual framed-sign and bag-card artwork is a separate design step; these files supply the replacement codes.

## Reading the CRM report

Choose first visits in the last 7, 30 or 90 days. Each source shows:

- Estimated browser visitors and how many started sign-in/signup.
- New verified app accounts and completed rewards connections.
- Accounts that completed marketing setup, plus those currently opted in with a saved push subscription. A subscription does not guarantee notification delivery.
- Customers with a subsequent synced purchase/preorder, and synced sales during the first 30 days after connection.
- Optional printing/placement costs, with cost per connected account and per completed subscriber setup.

Counts use a first-party, HttpOnly, 30-day cookie and first-observed-source attribution. Repeated scans on the same browser within that period count once. Other devices, cleared cookies, home-screen browser separation and privacy settings can affect attribution. JavaScript preview bots may count; ordinary QR redirect prefetches do not write events. Browser counts are estimates, not unique people. Returning accounts are not backfilled as new signups. Turning tracking on does not create historical data.

The selected period is a **first-visit cohort**, with progress counted through today. Newer cohorts have had less time to connect or purchase. Sales are associated with new linked accounts; they are not proof that the app caused extra sales. Costs use the date paid in the selected period and are an approximate acquisition measure, especially if one print run spans multiple periods. Gift discounts are not automatically included. Sales need the existing CRM sync to be current. At more than 5,000 linked cohort rows, the bounded report marks sales as not calculated rather than returning partial totals.

No third-party advertising tracker, patient details, raw IP address or usable login/connection code is added to source URLs or report responses. First-party visit tokens are stored as keyed hashes; the record links to the existing internal app user after verified signup. `Sec-GPC: 1` and `DNT: 1` suppress tracking when supplied by the browser. Attribution failure never prevents sign-in, linking or consent changes. Old visit rows are purged after 180 days during later app activity; an idle deployment requires owner cleanup. Removing the app connection deletes its associated row; CRM customer removal also clears that row. Existing cost/audit records contain business spending and approved staff identities, not patient details.

## Validation and rollout

### Approved production release — October 6, 2026

The owner approved publishing the tested signup, source attribution and Home Screen changes to `main` in `nwycoff/holy-smokes-website`, which supplies the live `holy-smokes-website` Pages project. This release applies the three signup commits to the current main branch and excludes the unrelated welcome-log and CRM assistant changes from the test branch. The exact release passed all 174 backend tests and both browser suites.

Production setup is separate from the completed test setup. In **holy-smokes-website**, inspect the **Production** bindings to identify its actual `APP_DB` and `CRM_DB`; do not use the test databases. Execute `app-migrations/0009_signup.sql` in that `APP_DB` and `crm-migrations/0010_signup_spend.sql` in that `CRM_DB`, then set the Production Text variable `APP_SIGNUP_TRACKING_ENABLED=true` and redeploy. The migrations are additive and repeatable. No additional GrowFlow token or Worker deployment is needed.

Production database/configuration changes have not yet been verified: the deployment session could update GitHub, but Cloudflare dashboard sign-in returned a verification error. The new signup and installation UI can run before these settings are applied; optional attribution failures do not block authentication, account linking, or notification preferences. Keep the QR reporting rollout incomplete until the live config reports `signupTrackingEnabled: true` and the CRM report loads against the migrated live databases. Optional verification-email resend remains a separate setup.

### Test evidence

Local, synthetic checks:

Checked on October 6, 2026: 175 backend tests passed; the existing app browser regression suite and new signup/CRM browser suite passed; Cloudflare Pages Functions compiled successfully; all five SVG QR codes rendered and decoded to their intended URLs. Phone email delivery, real iOS/Android installation and notification delivery still require the protected deployment checks below.

The Home Screen update also passed the signup browser suite's iPhone guide, Android prompt acceptance/dismissal/failure, user-click requirement, and standalone completion checks. The existing app browser regression suite passed, and Chromium reported no manifest installability errors on the local build. These synthetic checks do not replace installing from the protected test hostname on actual phones. This UI update adds no backend changes.

```sh
npm ci
npm test
npm run test:signup-browser
npm run test:browser
```

Browser tests need Chromium (`npx playwright install chromium`), or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed binary. Generated screenshots under `docs/signup-*` use synthetic data. They do not establish real Auth0 delivery, phone installation or push delivery.

On the protected test deployment:

1. Follow `/go/register-1`, create a new consenting test account and verify its email. Try delayed verification and, if configured, one resend.
2. Confirm the setup guide resumes. Staff verify the customer and issue a code once the customer is ready. Confirm the linked points against GrowFlow.
3. Confirm notification choices appear immediately. Declining them must still allow points/menu use. On a phone, install/reopen, sign in to the same account if needed, and choose notification settings explicitly.
4. In the protected CRM, check that one new account appears against Register 1. Repeat sign-in and refresh; it must not create another new account. Test a different source with a separate fresh test account/browser.
5. Add a small test cost, verify the calculation, then remove it. Confirm anonymous/unapproved CRM access is rejected.
6. Confirm existing linked-account sign-in, password recovery, points and menu still work. Test with two phones on shop Wi-Fi. No production orders or marketing sends are required for these checks.
7. Review actual iPhone/Android installation and email delivery with the owner. Only after approval apply the same two migrations/settings to the live bindings and publish the approved commit. Then replace the printed QR artwork. Existing website order links include the website source while preserving their order destination; the dedicated My Treehouse link opens the setup guide.

Authentication-start limits are now 8 per browser, 60 per IP and 600 across the app per fixed 15-minute window; callbacks have a separate 120/IP/15-minute limit. Connection redemption retains 5/account/15 minutes, 20/account/UTC day and 100/app/15 minutes, with the shared-IP limit raised to 50 to accommodate multiple shop customers. Existing same-origin, CSRF, verified-email and one-account-per-customer checks remain.

To stop collecting new source data, set `APP_SIGNUP_TRACKING_ENABLED=false` and redeploy. To disable resends, set `APP_AUTH_RESEND_ENABLED=false` and redeploy; revoke the M2M authorization if retiring it. The signup UI itself is rolled back by redeploying the prior approved code version. Keep the additive tables during a rollback; do not delete account, rewards, CRM or order data.
