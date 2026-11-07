// Generates the PNG icons from icons/icon.svg using headless Edge via Playwright.
//   node scripts/make-icons.mjs        (BROWSER_CHANNEL=chrome to use Chrome)
// Output (committed to the repo): icons/icon-192.png, icon-512.png, icon-maskable-512.png
// The maskable icon has a full-bleed background and the artwork scaled to the 80% safe zone.

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'icons', 'icon.svg'), 'utf8');
const svgUri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const BG = '#1f6f5c';

const channel = process.env.BROWSER_CHANNEL || 'msedge';
const browser = await chromium.launch({ headless: true, ...(channel === 'chromium' ? {} : { channel }) });

/** Render a page of size x size px and save a PNG. `inner` = artwork size (smaller for maskable). */
async function render(file, size, { inner = size, fullBleed = false } = {}) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const offset = (size - inner) / 2;
  // Maskable: the square background fills everything; the artwork (which has its own rounded
  // corners) is drawn smaller inside the safe zone, so we use the square background colour behind it.
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:${fullBleed ? BG : 'transparent'}}
    img{position:absolute;left:${offset}px;top:${offset}px;width:${inner}px;height:${inner}px}</style>
    <img src="${svgUri}">`);
  await page.waitForFunction(() => document.images[0].complete);
  await writeFile(join(root, 'icons', file), await page.screenshot({ omitBackground: !fullBleed }));
  await page.close();
  console.log('wrote icons/' + file);
}

await render('icon-192.png', 192);
await render('icon-512.png', 512);
// 80% safe zone: the artwork occupies the centre 80% (a circle of 40% radius must hold the content).
await render('icon-maskable-512.png', 512, { inner: Math.round(512 * 0.8), fullBleed: true });
await browser.close();
