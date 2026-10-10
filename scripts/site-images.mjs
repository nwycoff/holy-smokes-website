// Developer-only: node scripts/site-images.mjs makes the website's WebP images from the originals in
// images/ (kept for link previews, the schema and the app), at the sizes the pages show them.
// Uses Playwright's Chrome; PLAYWRIGHT_CHROMIUM_EXECUTABLE may point to a local Chrome.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// [source, output, width (height follows), quality]
const IMAGES = [
  ['img6.png', 'logo-96.webp', 96, 0.9],          // header and footer logo, shown at 40px
  ['img5.png', 'logo-240.webp', 240, 0.9],        // age screen logo, shown at 128–160px
  // Gallery photos: 480px for computers (columns about 400px wide), 800px for phones (full width, sharp screens).
  ['img7.jpeg', 'storefront-800.webp', 800, 0.72], ['img7.jpeg', 'storefront-480.webp', 480, 0.75],
  ['img8.jpeg', 'interior-800.webp', 800, 0.72], ['img8.jpeg', 'interior-480.webp', 480, 0.75],
  ['img9.jpeg', 'est-2022-800.webp', 800, 0.72], ['img9.jpeg', 'est-2022-480.webp', 480, 0.75],
];
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
const page = await browser.newPage();
for (const [source, output, width, quality] of IMAGES) {
  const file = await readFile(path.join(root, 'images', source));
  const type = source.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const result = await page.evaluate(async ({ data, type, width, quality }) => {
    const img = new Image(); img.src = `data:${type};base64,${data}`; await img.decode();
    const w = Math.min(width, img.naturalWidth), h = Math.round(img.naturalHeight * w / img.naturalWidth);
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, w, h);
    const url = canvas.toDataURL('image/webp', quality);
    return { w, h, data: url.slice(url.indexOf(',') + 1) };
  }, { data: file.toString('base64'), type, width, quality });
  const out = Buffer.from(result.data, 'base64');
  await writeFile(path.join(root, 'images', output), out);
  console.log(`${output}: ${result.w}×${result.h}, ${Math.round(file.length / 1024)} KB → ${Math.round(out.length / 1024)} KB`);
}
await browser.close();
