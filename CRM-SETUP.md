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

## Deals & news campaigns

The **Deals & news** section of the CRM writes campaigns; the order notifier Worker (`workers/order-notifier`, which holds the notification key) sends them within a minute. What customers were promised in the app is enforced in code (`server/crm/campaigns.mjs`), not left to staff:

- Only customers who opted in to the campaign's topic and have a phone set up, narrowed by an optional segment (everyone opted in, a ready-made segment, a saved segment, or the rules in "Find customers"). Consent is checked again just before each send.
- **At most 2 a week per person** (rolling 7 days; test sends don't count). Over the limit is recorded as "skipped for the weekly limit".
- **Only 9 am–8 pm Central.** Anything due outside those hours waits until 9 am, and each notification expires at 8 pm, so a phone that was offline never gets it late at night.
- **Discreet, claim-free wording:** the title is always "Treehouse Pharmacy"; messages are 10–120 characters and refused if they name cannabis products, THC/CBD, strains or weights, or make health claims.
- **Held-back group:** 0, 5, 10 (default) or 20% of each audience is kept back, chosen the same way every time per customer. Results compare visits and spend in the 7 days after sending for the people sent it vs. those held back.
- **Tapping opens** the app home, menu, My points or Order ahead, or the menu opened to one section or filtered to one brand (from today's menu). The section or brand travels separately from the link, so a phone with an older app opens the full menu; if it is no longer on the menu, the customer sees the full menu with a short note.
- **Test sends** go to the phones of the CRM user's own customer record (Show customers → "Use for my tests"), at any hour, prefixed "Test:".
- **Results follow the funnel** for people sent it, next to the held-back group: tapped (a signed code in each notification is reported by the app when tapped, even if that phone isn't signed in), visited, spent, ordered ahead in the app, bought what it featured (the brand or menu section it opened to, or the brands/product groups in its rules), and turned off Deals & news or that topic within 2 days.
- Every send, test, cancel and test-phone choice is in Recent activity. Campaign records and who got them follow the 24-month retention; removing a customer removes their rows.

### Automatic messages

Choose **When → Automatically, whenever someone matches** (or one of the ideas: Points ready, Birthday month, We miss you, Thanks for your first visit) and how often one person may get it (every 7–365 days, or only once). Every day at **11 am Central** the notifier sends it to everyone who matches the rules, opted in to the topic, and hasn't had it within that time; it goes out as one batch that follows all the rules above (weekly limit, quiet hours, consent re-check). Held-back people count as having had it, and an automatic message keeps the same held-back group, so results stay comparable. People skipped for the weekly limit, a failed delivery or no phone are tried again the next day. Automatic messages can be paused and turned back on; their totals and 7-day results are listed under **Automatic messages**, and their daily batches are not listed with one-off campaigns. Daily batches follow the 24-month retention, so an "only once" message could repeat after two years.

Setup: run `crm-migrations/0003_crm_campaigns.sql` and then `0004_crm_automations.sql` in `CRM_DB`; bind `CRM_DB` to the notifier Worker and set `CRM_CAMPAIGNS_ENABLED = "true"` there (see its `wrangler.toml`) and on the Pages project; redeploy both. The notifier already has the notification key and the app database.

## Campaign assistant

An AI assistant (Claude, via the Anthropic API) reviews the CRM and **suggests** campaigns, automatic messages and pauses. It cannot send anything: each suggestion waits in the CRM for someone to **Approve** (creates exactly what it describes, re-checked against today's rules), **Edit** (loads it into the composer) or **Dismiss** (with an optional reason it reads next time). Open suggestions expire after 14 days.

- **When:** a weekly plan on Mondays at 9 am Central (Claude Opus 5.5, up to 3 suggestions and a 6–12 sentence report) and a daily check at 10 am on other days (Claude Sonnet 5.5, only timely ideas such as new arrivals for a brand's fans). Owners can also start either from the CRM. Models are settings on the Worker (`CRM_ASSISTANT_WEEKLY_MODEL`, `CRM_ASSISTANT_DAILY_MODEL`).
- **What it sees:** totals only, through tools: shop overview, segment counts, top brands, today's menu summary (sections, brands, newly added items), campaigns and automatic messages with their held-back results, and its own notes. No customer names, phone numbers or IDs are sent to the API.
- **Rules:** every suggestion goes through the same checks as a campaign (topics, weekly limit, quiet hours, discreet wording, no health claims), so it cannot propose something the CRM would refuse.
- **Cost:** recorded per run. A monthly cap (`CRM_ASSISTANT_BUDGET_CENTS`, default 2500 = $25, set on the Worker and the Pages project) stops runs once reached; each run also has a size limit. Server-side refusal fallbacks (`fallbacks: "default"`) are on.
- **Phone updates:** CRM users who chose their own record ("Use for my tests") can tick **Notify my phone**. Scheduled runs then send an update through the app: the Monday plan always, the daily check only when it has suggestions or flags a problem (`alert_owners`). Runs started from the CRM don't notify. The notifier Worker sends these (it holds the notification key).
- **Learning:** it saves short lessons ("What it has learned") and reads past decisions and dismissal reasons each run.

Setup: run `crm-migrations/0005_crm_assistant.sql` and `0006_crm_measurement.sql` in `CRM_DB`; set `CRM_ASSISTANT_ENABLED=true` and `CRM_ASSISTANT_BUDGET_CENTS` on the Pages project; deploy `workers/crm-assistant` (`npx wrangler deploy [--env live]`) and give it the secret `ANTHROPIC_API_KEY` (`npx wrangler secret put ANTHROPIC_API_KEY [--env live]`). Also set a monthly spend limit on the Anthropic Console as a backstop.

## Welcome gift for new subscribers

In the CRM's Deals & news section, **Welcome gift for new subscribers** sets an offer for turning on Deals & news: on/off, what the gift is (shown inside the app only), the notification text (on the lock screen, so it passes the same discreet-wording and no-health-claims checks; `{code}` becomes the customer's code) and an optional last day.

- When a connected customer has Deals & news on (any topic) and a phone set up, the notifier issues one code (`TH-` plus 4 characters, once per customer record, ever) and sends it within a minute, between 9 am and 8 pm Central. Turning Deals & news off and on again never issues another. These messages don't count toward the weekly limit.
- The code also shows on **My points** in the app until the last day of the offer.
- At checkout, staff check the customer's GrowFlow profile for an earlier gift note, give the gift, and add a note such as "App welcome gift given 10/2 – TH-7Q4K".
- Removing a customer from the CRM deletes their code. Setup: run `crm-migrations/0007_crm_welcome_gifts.sql` in `CRM_DB` and redeploy the notifier.
