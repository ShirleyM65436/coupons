// Phase 3 integration test: the whole app used like a real person would, FULLY OFFLINE
// through the service worker. Proves the pieces work together, not just one by one:
//   add manually -> add a transaction -> scan (barcode + OCR, offline) -> confirm -> save
//   -> show barcode -> export backup -> wipe -> import (replace) -> data is back.
import { readFileSync } from 'node:fs';
import { openApp, check } from './helpers.mjs';

export default async function () {
  const app = await openApp();
  const { page } = app;
  const val = (name) => page.inputValue(`input[name="${name}"], select[name="${name}"]`);
  const hashStartsWith = (prefix, timeout = 15000) =>
    page.waitForFunction((p) => location.hash.startsWith(p), prefix, { timeout });

  try {
    // ---------------------------------------------------------------- go offline-capable
    await page.goto(app.url + '?sw=1');
    await page.waitForFunction(() => window.dev);
    await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, { timeout: 60000 });
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
      await page.reload();
      await page.waitForFunction(() => window.dev);
    }
    check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page');
    await app.wipe();

    // The test image (barcode + text) is drawn while still online; drawing needs JsBarcode,
    // which is also precached, but we keep image generation separate from what we test.
    const cardImage = await page.evaluate(async () => {
      const { loadScript } = await import('./js/ui.js');
      const c = document.createElement('canvas');
      c.width = 1600; c.height = 1000;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1600, 1000);
      ctx.fillStyle = '#111';
      ctx.font = 'bold 110px Arial, sans-serif'; ctx.fillText('GIFT CARD', 80, 160);
      ctx.font = '80px Arial, sans-serif';
      ctx.fillText('Card No 6035 7712 3456 7890', 80, 320);
      ctx.fillText('Valid thru 12/2027', 80, 460);
      ctx.fillText('Value €25.00', 80, 600);
      const JsBarcode = await loadScript('vendor/jsbarcode/JsBarcode.all.min.js', 'JsBarcode');
      const bc = document.createElement('canvas');
      JsBarcode(bc, '4006381333931', { format: 'EAN13', width: 4, height: 160, margin: 30, displayValue: false, background: '#fff' });
      ctx.drawImage(bc, 80, 700);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    });

    // ---------------------------------------------------------------- offline from here on
    await page.context().setOffline(true);
    await page.reload(); // fresh page: nothing loaded yet, everything must come from the cache
    await page.waitForFunction(() => window.dev);
    check(true, 'offline reload works');

    // 1. Add a card manually
    await app.goto('#/');
    await page.click('.view-list a[href="#/add"] >> nth=0'); // empty state "Add card" (no FAB without cards)
    await hashStartsWith('#/add');
    await page.fill('input[name="merchant"]', 'Corner Bakery');
    await page.fill('input[name="originalAmount"]', '40');
    await page.fill('input[name="expiryDate"]', '2030-06-30');
    await page.click('button[type=submit]');
    await hashStartsWith('#/card/');
    check((await page.locator('.detail-balance').innerText()).includes('40.00'), 'manual card saved, balance 40.00');

    // 2. Add a transaction
    await page.fill('input[name="amount"]', '12,50');
    await page.click('.detail-tx-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.detail-balance')?.innerText.includes('27.50'));
    check(true, 'transaction added offline, balance 27.50');

    // 3. Scan: still image -> barcode (ZXing) -> OCR (Tesseract, all from cache) -> confirm form
    await app.goto('#/scan');
    await page.setInputFiles('.view-scan input[type=file]:not([capture])', {
      name: 'card.png', mimeType: 'image/png', buffer: Buffer.from(cardImage, 'base64'),
    });
    await page.waitForFunction(() => location.hash === '#/add', null, { timeout: 60000 });
    await page.waitForSelector('input[name="cardNumber"]');
    check((await val('barcodeValue')) === '4006381333931' && (await val('barcodeFormat')) === 'ean_13', 'offline: barcode decoded');
    check((await val('expiryDate')) === '2027-12-31', `offline: OCR expiry (${await val('expiryDate')})`);
    check((await val('originalAmount')) === '25.00', 'offline: OCR amount 25.00');
    await page.fill('input[name="merchant"]', 'Scanned Store');
    await page.click('button[type=submit]');
    await hashStartsWith('#/card/');
    const scannedUrl = await page.evaluate(() => location.hash);
    check(await page.isVisible('.detail-photo'), 'scanned card has its photo');

    // 4. Show barcode
    await page.click('a:has-text("Show barcode")');
    await hashStartsWith('#/card/');
    await page.waitForSelector('.view-barcode svg', { timeout: 10000 });
    check(await page.isVisible('.view-barcode svg'), 'offline: barcode rendered');
    await app.goto(scannedUrl);

    // 5. List shows both cards
    await app.goto('#/');
    const listText = await page.locator('#view').innerText();
    check(listText.includes('Corner Bakery') && listText.includes('Scanned Store'), 'list shows both cards');

    // 6. Backup: export -> wipe -> import (replace)
    await app.goto('#/backup');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('button:has-text("Export backup")'),
    ]);
    const backupText = readFileSync(await download.path(), 'utf8');
    const backup = JSON.parse(backupText);
    check(backup.cards.length === 2 && backup.transactions.length === 1 && backup.photos.length === 1, 'backup has 2 cards, 1 transaction, 1 photo');

    await app.wipe();
    check((await app.cardIds()) && Object.keys(await app.cardIds()).length === 0, 'wiped');

    await app.goto('#/backup');
    await page.setInputFiles('.view-backup input[type=file]', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backupText) });
    await page.click('[data-testid="replace"]');
    await page.click('dialog button[value="ok"]');
    await page.waitForFunction(async () => (await (await import('./js/db.js')).getAllCards()).length === 2, null, { timeout: 10000 });
    const restored = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      const { computeBalance } = await import('./js/model.js');
      const cards = await db.getAllCards();
      const bakery = cards.find((c) => c.merchant === 'Corner Bakery');
      const scanned = cards.find((c) => c.merchant === 'Scanned Store');
      return {
        bakeryBalance: computeBalance(bakery, await db.getTransactions(bakery.id)),
        photo: (await db.getPhoto(scanned.photoId))?.type,
      };
    });
    check(restored.bakeryBalance === 2750 && restored.photo === 'image/jpeg', 'import restored balance 27.50 and the photo');

    check(app.errors.length === 0, 'no console errors or failed requests during the offline journey');
  } finally {
    await page.context().setOffline(false).catch(() => {});
    await app.close();
  }
}
