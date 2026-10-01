# Treehouse CRM

Owner and manager dashboard at `/crm/`: shop KPIs, top categories and brands, ready-made and custom customer segments, saved segments, and an activity log. Built on GrowFlow purchase history, synced into its own database. Messaging (Blackleaf SMS, app push for deals) comes in later phases.

## Data standards

- **Separate database** (`CRM_DB`: `treehouse-crm-test` / `treehouse-crm-live`), never shared with the app or points checker, and a **separate read-only GrowFlow token** (`CRM_GROWFLOW_TOKEN`) with only Customers, Orders, Order items, Product categories and Brands read.
- **Pseudonymous:** customers are known only by their GrowFlow record ID. No names, phone numbers, emails, addresses, license numbers or full birth dates are stored; birthdays are kept as the month only. Names are fetched live from GrowFlow when someone views a customer list and are never saved.
- **Lean purchase facts:** completed orders (date, total, online or not) and purchase lines (date, category group, brand, amount, returned). No product names, packages, payments, staff or notes. Canceled and voided orders are removed.
- **Retention:** order and line detail older than 24 months is deleted automatically; customers with no visit in 36 months are removed; audit entries are kept 36 months.
- **Access:** Cloudflare Access application with the approved individuals only (two-factor recommended), re-verified on every request against `CRM_EMAILS`; all three users have the same permissions. Changes require same-origin requests and a per-session CSRF token. Requests are rate limited per user.
- **Audit:** every customer list viewed, segment saved or deleted, and customer removed is logged with who and when (segment rules and counts only, never customer details).
- **Logs:** only fixed codes such as `TREEHOUSE_CRM_FAILURE CRM_QUERY`; never customer data or GrowFlow responses.
- **Removal requests:** "Remove" on a customer row deletes that customer's CRM data (their GrowFlow record is untouched). Customers deleted or anonymized in GrowFlow are removed on the next sync.
- **Consent:** buying in store is not consent to be messaged. Text messaging will only target Blackleaf's opted-in subscribers; app deal notifications will need their own opt-in.

## How the sync works

`workers/crm-sync` runs every minute. It reads orders, order items and customers changed since the last record it handled (two simple steps per page: finish records at the current updatedAt by objectId, then move past it; 100 per page, retried once at 25; up to 40 pages per run and no new page after 45 seconds, so runs never overlap; well under GrowFlow's per-token limit), keeps the lean facts above, refreshes app adoption flags from the app database, and applies retention (inactive customers are removed only after order history has fully loaded). The first runs backfill 24 months of history, which can take a while; the dashboard shows progress. Money is read as whole cents, like the rest of GrowFlow; set `CRM_MONEY_UNIT=dollars` on the Worker and site only if order totals turn out to be dollar amounts.

## Setup (test project first, then live)

1. **GrowFlow:** create a read-only token named "Treehouse CRM" with **Customers, Orders, Order items, Product categories, Brands** read. Save it in Bitwarden.
2. **Databases:** create `treehouse-crm-test` and `treehouse-crm-live` (D1) and run `crm-migrations/0001_crm.sql` once in each. Put their IDs in `workers/crm-sync/wrangler.toml`.
3. **Sync Worker:** `npx wrangler deploy` (test) and `npx wrangler deploy --env live`, each with `npx wrangler secret put CRM_GROWFLOW_TOKEN [--env live]`.
4. **Cloudflare Access:** a self-hosted application "Treehouse CRM" with paths `crm`, `crm/*`, `api/crm/*` and `assets/crm/*` on the site's hostname, and an Allow policy listing the three approved emails. Copy its AUD tag.
5. **Pages settings** (Production): bind `CRM_DB`; Text `CRM_ENABLED=true`, `CRM_ACCESS_ISSUER` (team domain), `CRM_ACCESS_AUD`, `CRM_EMAILS` (comma-separated, same three emails); Secrets `CRM_GROWFLOW_TOKEN` and `CRM_SECRET` (32+ random characters). Redeploy.
6. Open `/crm/` and sign in. To remove someone's access, take them off both the Access policy and `CRM_EMAILS`, then redeploy.
