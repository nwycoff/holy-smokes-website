# Counter tablet menu

Test URL: https://treehouse-app-test.pages.dev/tablet/
Production URL after a separate approved merge: https://www.treehousepharmacy.com/tablet/

Same-origin cookies are permitted so existing Cloudflare Access protection continues to work. The standalone page uses the existing public `/api/app/menu` feed and existing sales-floor stock rules. It requests no customer/session data, and offers no sign-in, rewards, ordering, or external navigation.

- Landscape: sidebar categories and filters, with product cards beside them.
- Portrait: categories and filters above the product cards.
- Search, category, type, brand, budget, flower size, and sorting stay selected during rotation. The previously visible product remains in view.
- Size and budget filters must match the same variant; cards show all available sizes and prices.
- Departments and sub-filters come from the server's shared category rules (`server/customer-app/taxonomy.mjs`), the same as the phone app: Treehouse (house brand), Flower, Smalls, Shake, Pre-Rolls, Vapes, Concentrates, Edibles, Tinctures & Capsules, Topicals & Patches, CBD & Hemp (hemp CBD plus CBD-rich cannabis), Seeds & Clones, Accessories, and More for any new GrowFlow category. Waste, sample and nicotine categories are never shown. Each card has a tap-to-open Lab results panel (cannabinoids, top five terpenes as bars).
- Category sub-filters (e.g. Pre-Rolls: Type, Format, Pack) start with each group's "All" box checked, showing everything. Checking a value narrows (and unchecks "All"); checking "All" clears that group. Checking narrows: any checked value within a group, and every group that has a check. Counts show what each box would add; boxes that would show nothing are disabled. Blunt pack size comes from the product name ("2pk", "2 pk", "(2 Pack)"); otherwise blunts count as singles.
- Every 60 seconds while visible, refresh the public menu. Retry transient errors once; retain the last loaded menu with a warning on failure. An initial failure offers Try again.
- After two minutes without touch, pointer, key, input, or scroll activity, clear all selections, restore price sorting, dismiss the keyboard, and return to the top. Start over does this immediately.
- There is no full screen button: the kiosk app keeps the page full screen. The page requests a screen wake lock and reacquires it when visible. Device power saving or browser restrictions may override it.

## Tablet setup

Open the test URL in the tablet browser. Try filters, rotate both ways, and leave it untouched for two minutes. Keep auto-rotate enabled. Run it in the kiosk app, which keeps it full screen.

Full screen is not device lockdown. Before leaving the tablet unattended with customers, configure Android app pinning or a managed kiosk browser on the actual device, protect exit with a staff-only credential, set appropriate screen timeout/charging settings, and verify that system navigation cannot escape the menu. Exact steps depend on the tablet model and management setup. No device policies have been changed by this code.

## Validation

`npm run test:tablet-browser` runs synthetic browser checks. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` may point to a compatible Chromium binary. Covers landscape/portrait/narrow tablet layout, filtering, same-variant price/size matching, automatic reset, failed refresh retention and recovery, rotation position, menu-only requests, and no browser storage. Existing server tests run with `npm test`.


## Website Menu page

`menu.html` (treehousepharmacy.com/menu) runs the same script in website mode (`<body data-menu="website">`) with its own stylesheet, `assets/menu/site.css`, scoped to `.th-menu` so the site's Tailwind header and footer are untouched. It replaces the GrowFlow embed. Website mode shows product photos, keeps the chosen heading in the address (`/menu?category=Pre-Rolls`, so pages and posts can link straight to a heading), never resets itself and does not hold the screen awake. Filters sit beside the products on wide screens and fold behind "Narrow it down" on phones, where headings are one swipeable row and sub-filters are pills. A banner links to the app for order-ahead. `npm run test:site-browser` checks it.
