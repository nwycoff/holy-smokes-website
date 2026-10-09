// Developer-only: node scripts/marketing-images.mjs renders marketing/app-social.html into the social
// images under assets/marketing/ (PLAYWRIGHT_CHROMIUM_EXECUTABLE may point to a local Chrome).
import { chromium } from 'playwright';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(root, 'marketing/app-social.html')).href);
await page.evaluate(() => document.fonts.ready);
for (const id of ['square', 'story']) await page.locator(`#${id}`).screenshot({ path: path.join(root, `assets/marketing/treehouse-app-${id}.png`) });
await browser.close();
// The print flyer, served next to them for the CRM's Marketing materials.
await copyFile(path.join(root, 'marketing/Treehouse-App-Flyer.pdf'), path.join(root, 'assets/marketing/treehouse-app-flyer.pdf'));
