# Staff account connection page

The new `/staff/` page works in Chrome or Edge on the shop's Windows PC and in Safari/Chrome on Mac. No daily scripts, installations, or shared API secrets are needed. It issues codes for the existing customer account-linking flow; it does not change GrowFlow records.

## What staff do

1. Open the staff page and sign in with their own approved email through Cloudflare Access.
2. Verify the customer in person and enter their exact GrowFlow name and last five patient-ID letters/numbers (the dash is optional).
3. Review the single matching name and check the identity confirmation.
4. Generate a code and print the customer slip, or let the customer enter the code directly from a staff-controlled display. A paper slip includes the customer app URL, code and expiry, never the patient's name or license number.
5. The customer signs into their own Treehouse account and enters the code. Staff never need their password.
6. Click **Clear & next customer** and dispose of unwanted printouts. Sign out of Cloudflare Access at shift change; do not share a staff login.

Codes expire after ten minutes and work once. A replacement code invalidates any earlier unused code for that GrowFlow record. Already-linked customers must use password recovery; this tool cannot transfer a linked account. A lookup confirmation expires after two minutes and is bound to the issuing staff identity. This is exact matching, not a patient directory or broad search.

## Test deployment setup (owner)

Only deploy after approval. Start on the existing protected `treehouse-app-test` project. Preserve its existing customer Access protection and all existing bindings/secrets.

1. Execute `app-migrations/0004_staff_enrollment.sql` in that project's **APP_DB** database. Do not run it in the public rewards database. It adds two tables and does not alter existing tables.
2. Create a **Self-hosted Cloudflare Access application** for staff enrollment with both public hostname/path entries in the **same application**:
   - `treehouse-app-test.pages.dev` path `staff/*`
   - `treehouse-app-test.pages.dev` path `api/staff/*`
   Protect bare `/staff` as well if a separate entry is needed for the redirect. Production/custom-host or alias deployment access must be explicitly configured before use.
3. Add an **Allow** policy listing individual approved staff emails, starting with the owner for testing. Do not use Everyone, Bypass, service-token access, or a shared employee identity. Use staff identity-provider MFA where available. A four-hour application session is a reasonable starting point; this backend rejects tokens older than eight hours.
4. Copy this staff application's **Application Audience (AUD)** tag and your **team domain** (the `https://your-team.cloudflareaccess.com` address). This is the application AUD, not an Access policy ID or an API token.
5. In **treehouse-app-test → Settings → Variables and secrets → Production**, add these Text settings:

| Name | Value |
| --- | --- |
| `APP_STAFF_ENABLED` | `true` after the migration and Access policy are ready; otherwise `false` |
| `APP_STAFF_ACCESS_ISSUER` | Your `https://your-team.cloudflareaccess.com` team domain |
| `APP_STAFF_ACCESS_AUD` | The staff Access application's 64-character AUD tag |
| `APP_STAFF_EMAILS` | Comma-separated exact staff email addresses, initially only the owner's |

The backend uses existing `APP_DB`, `APP_LIMIT_SECRET`, `APP_GROWFLOW_TOKEN`, `GROWFLOW_ORG`, `GROWFLOW_PATIENT_ID_FIELDS`, `APP_ENABLED`, and `APP_ALLOWED_HOSTS`. No new shared secret goes to the staff page. The canonical test hostname must already be in `APP_ALLOWED_HOSTS`.

6. Redeploy the approved feature commit and open `https://treehouse-app-test.pages.dev/staff/`.
7. Test an approved staff sign-in and an unapproved sign-in in separate private-browser sessions. Confirm the backend rejects the latter; possessing a customer-app session must not grant staff access. Verify the API path uses the same staff Access application, not the customer application's AUD.
8. With a consenting **unlinked** test customer, verify the match, print a slip, and connect their account using the customer app. Check expiry/replacement handling. No real codes are generated during automated tests.
9. On Windows, bookmark the page or create a desktop shortcut to its URL. The print button opens the normal browser/Windows printer dialog. Select the actual printer rather than saving patient connection codes to PDF by default. Disable browser-added print headers/footers if desired.

Each staff member must be allowed both in Cloudflare Access and `APP_STAFF_EMAILS`. To remove a staff member, remove them from both, revoke their Access sessions, and redeploy the updated environment. API requests re-check the allowlist each time. Disabling `APP_STAFF_ENABLED` and redeploying stops staff issuance without disabling customer points or accounts.

## Security and audit behavior

- Verifies the Cloudflare Access JWT signature with `jose`, pinned RS256, expected team issuer, exact application audience, expiry, token age, human identity and email allowlist. An email header alone is never trusted.
- Both writes require exact same-origin requests and a CSRF token bound to the verified Access assertion. A fresh assertion requires refreshing the page to obtain a new CSRF token.
- Unknown hosts, incomplete configuration, missing migration, provider redirects, database failures and missing identity confirmation fail closed.
- One narrowly filtered GrowFlow read per search; code issuance itself does not call GrowFlow. Existing global GrowFlow quota/backoff is reused, with additional per-IP and per-staff limits. No automatic retries.
- Browser receives only the matching name, short-lived opaque match ticket, and eventual code. It never receives GrowFlow customer IDs, full patient IDs, balances, API tokens or enrollment secrets. Inputs and codes are not put in URLs, local/session storage or service-worker caches.
- Audit issuance is atomic with code creation. `app_staff_audit` records verified staff email, hashed staff identity, internal GrowFlow customer record ID, action and time. It stores no plaintext connection code, patient name, or patient license number. Access to D1 is restricted to the owner/admin; this is not a public audit endpoint.
- Audit rows older than 180 days and expired match rows are removed during subsequent authorized staff writes. If the tool is idle, they remain until the next write (or owner cleanup). This is an operational retention choice, not a statement of legal requirements.
- The pre-existing owner CLI remains separate and still uses `APP_ENROLLMENT_SECRET`; its issuances do not appear in this staff-page audit. Keep that secret private; retire the CLI by removing that secret after the staff page is validated if desired.
- The staff page is a separate shell outside the customer service-worker scope. Access protects it at the edge; the backend independently validates every staff API request. A static copy of the shell grants no data access.
- Issued slips are temporary account-linking credentials: hand them only to the verified customer. A clear button removes the on-screen code but does not revoke an already-issued code.

References: [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) and [jose JWT verification](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md).
