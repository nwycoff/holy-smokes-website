# Treehouse points page setup

This branch adds a read-only points lookup to the existing static website. The customer supplies a full name and the last five patient-ID letters or numbers. The only successful response is a points balance. No account enrollment, purchase history, reward redemption, birthday automation, or push notifications are included in this first release.

## Current state

- Local code and automated tests are ready for review.
- Nothing has been uploaded to GitHub or deployed by this work.
- The lookup remains disabled until all configuration and database bindings are present.
- On September 28, 2026, the owner's local Mac check using a self-service API token returned one unique customer and a numeric points balance that matched the balance entered privately. It succeeded on the original combined name/ID query; the fallback diagnostic was not needed. This establishes sampled customer-points access, not correct matching for every customer or which individual ID field matched.
- That customer's phone field was empty or missing. An earlier selected-receipt check succeeded, but phone availability, marketing consent, order items and full history remain unverified. The website endpoint requests only points.
- A Cloudflare preview and real iPhone/Android testing are still required before production.

## Keep the live website working

The existing Pages project deploys `main` automatically and currently has no build command. Do not upload these changes directly to `main`.

Before the first approved push of `feature/treehouse-points`, exclude that branch from automatic **preview** deployments in the existing live Pages project. Otherwise the live project's current output settings could publish the test branch's repository files on a preview URL. If preview deployment currently includes all branches, choose custom preview branches, include `*`, and exclude `feature/treehouse-points`. Preserve any existing custom rules. Keep production branch `main` and its automatic production deployment setting unchanged. See [Cloudflare branch deployment controls](https://developers.cloudflare.com/pages/configuration/branch-build-controls/).

Use branch `feature/treehouse-points`. For the first review, create a separate **Cloudflare Pages test project** connected to the same repository, using this feature branch as that test project's production branch. This avoids changing the current project's global build settings while `main` still has the old static-only layout.

For the test project set:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Production branch | feature/treehouse-points |
| Build command | npm run build |
| Build output directory | dist |
| Root directory | Repository root / leave blank |
| NODE_VERSION | 22 |

There are no runtime npm dependencies. The build copies only public HTML, images, blog files, rewards assets, and headers into `dist/`. Cloudflare separately bundles the root `functions/` directory. Do not publish the repository root as the output directory for this branch; it contains server code, setup instructions and tests.

The first deploy can run with no GrowFlow secrets. It displays the page in an unavailable state and cannot perform lookups.

## GrowFlow token and customer matching

Use a dedicated self-service token created in GrowFlow's API Tokens dashboard with **Read Customers** (`read:customers`) permission. Orders, menus and Create permissions are not needed for the points page. Customer records are organization-wide under the new API guide, even when a token has selected stores. Keep the complete `gfr_...` token in the password manager and enter it only into the test project's Cloudflare secret setting. Do not put it in GitHub, a URL, chat, or a browser-facing file.

The server sends this token directly as a Bearer credential to the organization's GraphQL endpoint. The application client ID, application client secret and menu access key are not used. The earlier PowerShell client-credentials checks were standalone historical diagnostics; use the Mac self-service-token checker in `scripts/mac-token-checker/` for further access checks.

The public endpoint now reproduces the successful check's identity restrictions: exact full `Name` (case-insensitive), plus the ID suffix in any of `PatientLicenseNumber`, `MedicalLicenseNumber`, or `CustomerStateLicense`, while excluding deleted, anonymous, disabled or explicitly inactive records. It asks for at most two results and returns points only when exactly one complete match exists with no further page. Multiple matching fields on the same customer do not constitute multiple customers; multiple customer records are rejected.

Set `GROWFLOW_PATIENT_ID_FIELDS` to the three-field list below to use that combined lookup. This is one query, not three. If a single field is verified separately later, configure just that field. The old singular `GROWFLOW_PATIENT_ID_FIELD` setting remains supported only when the plural setting is absent. No field is selected by default, and invalid or duplicate field names disable the endpoint. There is no public name-only, PatientName, or relaxed-status fallback.

Before launch, test at least a second known consenting customer, one leading-zero suffix if applicable, and an incorrect name and suffix. If correct details do not match, investigate privately rather than broadening the public lookup. The first zero-match run's cause has not been established.

The lookup accepts five ASCII letters or numbers, with an optional dash after the third character (ABC-12 or ABC12). Matching is case-insensitive and anchored to the end of the stored ID, allowing that same optional dash. Other punctuation, spaces, and dash positions are rejected. Confirm this matches the actual stored IDs before launch.

## Set up the test project's Cloudflare services

1. Create a dedicated D1 database for the points lookup. Apply `migrations/0001_rewards_limits.sql` in its console. Bind it to the Pages test project as **REWARDS_DB**. Use a separate database from production for tests.
2. Create a Turnstile managed widget with the test project's exact hostname in its allowed-hostname list. Keep the secret key private. The public site key is safe to return to the browser.
3. In the test project's Variables and secrets, add the values below. Because the feature branch is the test project's production branch, select that project's **Production** environment. Do not accidentally add them to the live site's environment.
4. Redeploy the test project after changing bindings or variables.

| Variable | Type | Value |
| --- | --- | --- |
| REWARDS_ENABLED | Plain text | Start with `false`; set `true` only for the access test |
| REWARDS_ALLOWED_HOSTS | Plain text | Exact test hostname, e.g. your-test-project.pages.dev; no scheme or path |
| GROWFLOW_ORG | Plain text | holysmokesdispensary |
| GROWFLOW_PATIENT_ID_FIELDS | Plain text | `PatientLicenseNumber,MedicalLicenseNumber,CustomerStateLicense` |
| GROWFLOW_API_TOKEN | Secret | Complete self-service `gfr_...` token with Read Customers permission |
| REWARDS_RATE_SECRET | Secret | At least 32 random characters, e.g. `openssl rand -hex 32` |
| TURNSTILE_SITE_KEY | Plain text | Public key for the test widget |
| TURNSTILE_SECRET_KEY | Secret | Secret key for that widget |

All origins/hostnames are matched exactly. A newly generated preview hostname won't gain access until explicitly allowed. Do not use wildcard hostnames. Protect the test project's actual hostname with Cloudflare Access before enabling real lookups; verify access is denied in a signed-out browser. A test URL is not private just because it is separate from the live website.

Cloudflare reference: [Pages bindings and secrets](https://developers.cloudflare.com/pages/functions/bindings/) and [build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/). Use the Secret type for the GrowFlow token and other private values, not plaintext variables. Secret and binding changes require a new deployment to take effect.

## Security and limitations

The owner explicitly accepted name-plus-five-characters for a points-only lookup. This is weak identity checking, not account authentication. Someone who knows those details can still view a balance. Never reuse this endpoint as proof for account ownership, patient profile changes, or reward redemption.

- HTTPS and same-origin POST only; no sensitive data in query strings.
- Turnstile checked server-side with exact hostname and action checks.
- IP attempts: 10 per fixed 15-minute window; total traffic: 60 per minute.
- Name attempts across IPs: 5 per fixed 15-minute window and 20 per day. Common names share counters. Limits can inconvenience legitimate customers; staff lookup remains available.
- At most 15 points GraphQL queries per fixed minute across this deployment. Window boundaries may allow a short burst; this isn't a rolling-window limiter.
- GrowFlow's new API Developer Guide documents **120 HTTP requests/minute per token**, with a maximum/default page size of 100. This endpoint requests only two records, caps its own GrowFlow reads at 15/minute per deployment, backs off when observed remaining quota reaches 20 or less or on 429/errors, and makes no automatic retries. Honor any stricter limits GrowFlow assigns in future. Sharing a token with other integrations shares its rate budget; a dedicated points token separates that budget.
- API requests are metered organization-wide under the GrowFlow plan, including failed and rate-limited requests. Separate tokens do not avoid this usage. Confirm the plan's allowance and pricing before launch; the supplied guide does not establish those amounts. Maintain one production points deployment and keep preview use small.
- The self-service token is read from the server's secret binding. There is no OAuth exchange, token cache, or automatic token refresh. Expiration follows the choice made when creating the token. The old OAuth weekly token-request guidance is not applied to this token type, and no periodic keepalive is scheduled.
- For rotation, create a replacement Read Customers token, update the Cloudflare secret, redeploy and verify one known balance before revoking the old dedicated points token. Track the configured expiry in the password manager. Do not revoke or change any credential used by the shop menus as part of this setup.
- Counters contain keyed hashes, counts, and expiry times only. Raw names, suffixes, IPs, and balances are not stored in D1. Expired rows are deleted in bounded batches on requests; database backups have their own retention.
- Customer data is sent only to GrowFlow; Turnstile receives its token and the edge IP, not the patient name or ID suffix.
- No raw request/response logging. Do not add session replay, third-party analytics, request-body logging, or dashboard debug logging to the rewards page/API.
- All API responses are private/no-store, with no CDN cache. Never add an offline/service-worker cache for patient inputs or `/api/rewards/*`.
- Missing/null points do not become a zero balance. Duplicate matches, pagination, invalid configuration, and database failures fail closed.
- On success, form inputs clear immediately. The balance clears after two minutes, on Done, or when leaving the page. Nothing is saved in localStorage/cookies.

## Test before launch

Run `npm test` and `npm run build` locally with Node 22.13+ (the tests use Node's SQLite module). Tests use synthetic data, never the live API.

On the Cloudflare test project verify:

1. At least two known consenting customers -> correct points only, including zero and leading-zero suffixes if applicable. Repeat the read check if a new dedicated token was created after the diagnostic.
2. Wrong name or suffix -> the same generic failure; no partial suggestions.
3. Ambiguous records -> no balance. Do not modify real customer records just to create a test duplicate; use sandbox fixtures or the automated tests.
4. Repeated attempts -> limited. Cloudflare outage, GrowFlow denial, and disabled flag -> no balance.
5. DevTools network responses contain no customer metadata or application tokens. Patient inputs appear only in the outgoing HTTPS POST body, as expected.
6. The layout, keyboard, Turnstile, clearing behavior, and back navigation work on an actual iPhone and Android phone.
7. The rest of the website and live menu embed still work. No login/notification permission is requested in this release.

## Production rollout and rollback

After the preview passes, review the PR. Coordinate the merge with updating the live project's build command to `npm run build`, output directory to `dist`, and Node version to 22. Until both code and settings agree, a build may fail; Cloudflare should retain the previous successful deployment, but do not use that as the rollout plan. Keep the last good deployment identified for rollback.

Create production D1 and Turnstile resources separately. Allow only the intended production hostname(s), and add production secrets as secret variables. Start with `REWARDS_ENABLED=false`. Confirm the disabled page, then enable and redeploy after the known-customer checks pass. Review rate-limit usage alongside the menu host.

For an urgent disable, set `REWARDS_ENABLED=false` and redeploy. For a complete rollback, restore the last good Cloudflare deployment and revert this branch's changes along with the corresponding build settings. Keep menu credentials separate.

The owner's standing instruction requires explicit approval before pushing or merging. All changes described here are local; these steps are a review plan, not a record of deployment.
