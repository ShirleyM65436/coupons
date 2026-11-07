// Shared helpers for browser smoke tests (Playwright, headless).
// Uses the Microsoft Edge (or Chrome) already installed on the machine, so no
// browser download is needed. Override with BROWSER_CHANNEL=chrome or =chromium.
//
// Usage in a smoke script:
//   import { openApp } from './helpers.mjs';
//   const app = await openApp();               // starts server + browser, opens the app
//   await app.seed();                           // demo data (js/dev.js)
//   await app.goto('#/card/' + id);             // navigate by hash
//   ... use app.page (a Playwright Page) ...
//   await app.close();                          // throws if any console error / page error happened

import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve.mjs';

/**
 * @param {{ port?: number, launchArgs?: string[], viewport?: {width:number,height:number}, permissions?: string[] }} [opts]
 *   launchArgs e.g. ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
 */
export async function openApp({ port = 0, launchArgs = [], viewport = { width: 390, height: 844 }, permissions = [] } = {}) {
  const { server, url } = await startServer(port);
  const channel = process.env.BROWSER_CHANNEL || 'msedge';
  const browser = await chromium.launch({ headless: true, ...(channel === 'chromium' ? {} : { channel }), args: launchArgs });
  const context = await browser.newContext({ viewport, permissions, acceptDownloads: true });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('requestfailed', (req) => errors.push('requestfailed: ' + req.url()));

  await page.goto(url);
  await page.waitForFunction(() => window.dev); // app.js finished starting (dev helpers ready)

  return {
    page,
    url,
    errors,
    /** Wipe the database and add the demo cards. */
    async seed() {
      await page.evaluate(async () => { await window.dev.wipe(); await window.dev.seed(); });
    },
    async wipe() {
      await page.evaluate(() => window.dev.wipe());
    },
    /** Navigate to a hash route and wait for the view to render. */
    async goto(hash) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForTimeout(300);
    },
    /** Ids of all cards, keyed by merchant name. */
    async cardIds() {
      return page.evaluate(async () => {
        const db = await import('./js/db.js');
        return Object.fromEntries((await db.getAllCards()).map((c) => [c.merchant, c.id]));
      });
    },
    /** Close everything. Throws if console errors were collected (pass {allowErrors:true} to skip). */
    async close({ allowErrors = false } = {}) {
      await browser.close();
      server.close();
      if (errors.length && !allowErrors) {
        throw new Error('Browser errors:\n' + errors.join('\n'));
      }
    },
  };
}

/** Type a merchant name into the Add/Edit form's Merchant box (a plain text box). */
export async function setMerchant(page, name) {
  await page.fill('#merchant', name);
}

/** Tiny assertion helper for smoke scripts. */
export function check(condition, message) {
  if (!condition) throw new Error('CHECK FAILED: ' + message);
  console.log('  ok -', message);
}
