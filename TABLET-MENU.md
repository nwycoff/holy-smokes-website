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


## Website Menu pages

`/menu` and one page per heading (`/menu/pre-rolls`, `/menu/edibles`, … from `server/site/menu-page.mjs`, routed by `functions/menu/[[path]].js`) are built on the server from the `menu.html` template: each page gets its own title, description, canonical address, heading, intro, real links to every heading, structured data (breadcrumbs and the store's address), and its current products already in the page, so search engines see them without running scripts. The overview shows the 60 most popular products; each heading page shows all of its own. Old `/menu?category=` links redirect (301) to the heading page; unknown headings return the site's 404 page. The browser then runs the same script as the tablet in website mode (`<body data-menu="website" data-category="…">`): product photos, headings as real links that switch in place (no reload; the address, title, heading and intro follow from the page's `#menu-pages` details, Back/Forward work, the tapped heading stays exactly where it was on screen; titles and intros reserve room for the longest so they never push the headings around; sub-filters as rows of pills above the products on wide screens, with a one-line summary pinned under the site header once they scroll away ("Change filters" leads back up), and below the row of heading chips on narrower ones), no idle reset or keep-awake, filters beside the products on wide screens and behind "Narrow it down" on phones (headings in one swipeable row, sub-filters as pills). Styles: `assets/menu/site.css`, scoped to `.th-menu`. The build also writes `sitemap.xml` (home, every Menu page, the blog) and copies `robots.txt` and `404.html`. `npm run test:site-browser` checks it, including the page with JavaScript off.
