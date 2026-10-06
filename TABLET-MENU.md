# Counter tablet menu

Test URL: https://treehouse-app-test.pages.dev/tablet/
Production URL after a separate approved merge: https://www.treehousepharmacy.com/tablet/

Same-origin cookies are permitted so existing Cloudflare Access protection continues to work. The standalone page uses the existing public `/api/app/menu` feed and existing sales-floor stock rules. It requests no customer/session data, and offers no sign-in, rewards, ordering, or external navigation.

- Landscape: sidebar categories and filters, with product cards beside them.
- Portrait: categories and filters above the product cards.
- Search, category, type, brand, budget, flower size, and sorting stay selected during rotation. The previously visible product remains in view.
- Size and budget filters must match the same variant; cards show all available sizes and prices.
- Every 60 seconds while visible, refresh the public menu. Retry transient errors once; retain the last loaded menu with a warning on failure. An initial failure offers Try again.
- After two minutes without touch, pointer, key, input, or scroll activity, clear all selections, restore price sorting, dismiss the keyboard, and return to the top. Start over does this immediately.
- Full screen is available where supported. The page requests a screen wake lock and reacquires it when visible. Device power saving or browser restrictions may override it.

## Tablet setup

Open the test URL in the tablet browser. Try filters, rotate both ways, and leave it untouched for two minutes. Keep auto-rotate enabled. Use Full screen for the initial trial.

Full screen is not device lockdown. Before leaving the tablet unattended with customers, configure Android app pinning or a managed kiosk browser on the actual device, protect exit with a staff-only credential, set appropriate screen timeout/charging settings, and verify that system navigation cannot escape the menu. Exact steps depend on the tablet model and management setup. No device policies have been changed by this code.

## Validation

`npm run test:tablet-browser` runs synthetic browser checks. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` may point to a compatible Chromium binary. Covers landscape/portrait/narrow tablet layout, filtering, same-variant price/size matching, automatic reset, failed refresh retention and recovery, rotation position, menu-only requests, and no browser storage. Existing server tests run with `npm test`.
