# Customer app — review before test publication

Customers currently re-enter patient details for each points lookup, and the existing TV menus are intended for the store. This change adds a mobile customer area with a remembered login, a verified connection to an existing customer record, and a searchable menu.

## Changes

- `/app/`: home, points, account and menu; installable public shell.
- `/app/demo/`: isolated design preview using clearly labelled fictional data and no API calls.
- `/api/app/*`: disabled by default; separate host allowlist, database and secrets.
- Auth0 hosted login through the maintained `oauth4webapi` library; PKCE, nonce/state, issuer/audience and signature checks; verified email required.
- Server-side sessions, CSRF-protected changes, session revocation and a one-use, ten-minute enrollment workflow after staff checks identity.
- Exact linked-customer points lookup. No arbitrary customer IDs or patient searches accepted by the customer endpoint.
- Shared menu refresh, positive sellable front-room packages only, explicit tax flag and package-derived THC.
- Separate D1 migration, owner enrollment CLI, setup guide and browser regression runner.

The current `/rewards` implementation and main website navigation are unchanged. There are no GrowFlow writes, preorder submissions, point redemptions, marketing subscriptions, push messages or purchase-history reads.

## Verification performed locally

- 65 automated tests pass, including the existing 49 points/access tests.
- Real OIDC response processing exercised with synthetic signed JWTs, including wrong nonce/issuer/audience, unverified email, expiry, signature tampering and replay rejection.
- SQLite-backed transactional tests cover code expiry/reuse, account isolation, logout/revocation, secret rotation, menu eligibility, shared cache/backoff and limiter behavior.
- Chromium checks at 360px, 390px and 1365px: filtering, sorting controls, sample/live separation, no overflow or JavaScript errors in demo, correct POST Origin and CSRF header, sign-out, no account data in browser storage and public-only offline recovery.
- Cloudflare Pages Functions compile successfully with Wrangler 4.143.0.
- Production dependency audit reports no known vulnerabilities. This is not a security certification.

Screenshots in `docs/customer-app-*.png` contain fictional data only.

## Remaining test gates

Auth0 tenant setup, email delivery/recovery, protected Cloudflare test deployment, new D1 binding and separate GrowFlow read token. Confirm the actual API front-room value, package eligibility, prices/tax and a consenting customer's points. Real iPhone/Android installation and complete account recovery/deletion procedures require owner testing before a public launch.

Enrollment currently uses an owner-held secret through a terminal tool. Individual staff roles and a staff-facing enrollment page are a later rollout step; do not distribute that secret to customers or general staff. The setup guide supports Cloudflare Access service credentials for this protected test tool.

## Publication requested

Push **only** local branch `feature/treehouse-customer-app` after explicit approval. No merge to `main` and no live-site deployment are included in that approval. Suggested separate Cloudflare test project: `treehouse-app-test`, with Access protection before enabling live data.

Disable `APP_ENABLED` to stop all customer-app endpoints, or `APP_MENU_ENABLED` to stop only its live menu. The existing points checker is independently configured.
