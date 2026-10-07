import { handleMenuPage } from '../../server/site/menu-page.mjs';
// /menu and one page per heading (/menu/pre-rolls), built with current products for search engines.
export const onRequest = context => handleMenuPage(context);
