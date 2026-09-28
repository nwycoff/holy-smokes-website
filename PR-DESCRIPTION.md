Customers currently have to ask a budtender for their loyalty balance. This adds a Treehouse-branded points page using the owner's approved full-name and last-five-patient-ID-characters lookup. Navigation links make it accessible from the existing website.

The server uses GrowFlow's new self-service token and requests only CurrentPoints. It matches the full name and suffix across the three supported ID fields, excludes ineligible record statuses, and returns a balance only for one complete, unambiguous result. The owner verified one real customer's balance with the separate local diagnostic; additional customer and deployed-site checks remain outstanding.

Turnstile validation, persistent D1 attempt limits, a 15/minute deployment-wide GrowFlow query budget, upstream backoff and no automatic retries limit access and API usage. The credential stays in a server secret binding. Responses are not cached, errors contain no upstream details, and patient input and balances are not logged or stored in the browser. The balance clears after two minutes or when leaving the page. Lookup is disabled unless explicitly enabled with all required configuration.

A build step exports only public files to dist. Cloudflare bundles the Pages Functions separately; source code, tests, setup documents and local diagnostics are excluded from the public build. The Mac token checker is included for owner-run, read-only access diagnostics; it is not called by the website.

Validation:

- 41 automated tests passed with synthetic fixtures: 21 website endpoint tests and 20 Mac diagnostic tests.
- Static production build passed; checked public output excludes backend, diagnostic files and credential configuration.
- Points query and combined ID variables validate offline against the supplied example schema.
- Cloudflare D1/Turnstile integration and actual iPhone/Android testing remain required on the test deployment.

Rollout:

- Upload only feature/treehouse-points after the owner's explicit push approval. Keep main unchanged.
- The owner reported saving this branch's exclusion from the live Pages project's previews on September 28, 2026. Production stays on main with automatic deployments enabled.
- Configure a separate Pages test project with npm run build, output dist and Node 22. Keep real lookups disabled until its access protection, D1, Turnstile and secrets are ready.
- Verify another consenting customer's known balance, incorrect details and clearing behavior before requesting approval for production.
- Name plus five ID characters is limited identity checking accepted for points-only viewing; it must not authorize account ownership or redemption.

No GitHub push, merge or Cloudflare deployment has been performed as part of preparing this change. No API credentials or customer records are included.
