// Smoke test for the barcode view (#/card/:id/barcode).
import { openApp, check } from './helpers.mjs';

const NOTE_RE = /Shown as Code 128 .* can't be drawn here/;

export default async function () {
  const app = await openApp();
  const { page } = app;
  try {
    // Spy on wake lock releases (must be installed before the app code runs -> reload after).
    await page.addInitScript(() => {
      window.__released = 0;
      if (window.WakeLockSentinel) {
        const orig = WakeLockSentinel.prototype.release;
        WakeLockSentinel.prototype.release = function () { window.__released++; return orig.apply(this, arguments); };
      }
    });
    await page.reload();
    await page.waitForFunction(() => window.dev);
    await app.seed();
    const ids = await app.cardIds();
    const status = () => page.locator('.view-barcode .barcode-status').innerText();

    // --- 1. EAN-13 (BookNook) in dark mode
    await page.emulateMedia({ colorScheme: 'dark' });
    await app.goto(`#/card/${ids.BookNook}/barcode`);
    const svg = page.locator('.view-barcode .barcode-panel svg.barcode-svg');
    await svg.waitFor();
    const box = await svg.boundingBox();
    check(box && box.width >= 300, `EAN-13 svg is wide (${Math.round(box.width)}px)`);
    check(box.x >= 0 && box.x + box.width <= 390, 'barcode inside viewport');
    const bg = await page.locator('.view-barcode .barcode-panel').evaluate((n) => getComputedStyle(n).backgroundColor);
    check(bg === 'rgb(255, 255, 255)', `panel is white in dark mode (${bg})`);
    check(await page.locator('.barcode-note').count() === 0, 'no fallback note for EAN-13');
    check((await page.locator('#view').innerText()).includes('6035771234567890'), 'card number shown');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');

    // --- 8. Decode the rendered EAN-13 with ZXing
    const png = await svg.screenshot();
    const decoded = await page.evaluate(async (b64) => {
      const { loadScript } = await import('./js/ui.js');
      const Z = await loadScript('vendor/zxing/zxing-browser.min.js', 'ZXingBrowser');
      const reader = new Z.BrowserMultiFormatReader();
      const result = await reader.decodeFromImageUrl('data:image/png;base64,' + b64);
      return result.getText();
    }, png.toString('base64'));
    check(decoded === '4006381333931', `ZXing decodes rendered EAN-13 (${decoded})`);

    // --- 6. wake lock status + release on leave
    const hasWake = await page.evaluate(() => 'wakeLock' in navigator);
    const st = await status();
    check(/stay on|can't keep the screen on/.test(st), `wake lock status shown: "${st}"`);
    if (hasWake && st.includes('stay on')) {
      await app.goto('#/');
      check((await page.evaluate(() => window.__released)) >= 1, 'wake lock sentinel released on leave');
    } else {
      console.log('  (wake lock unavailable/denied in this browser; release not testable)');
      await app.goto('#/');
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // Headless often denies the real wake lock, so also test with a stub that grants it.
    await page.evaluate(() => {
      window.__stubReleased = 0;
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
        request: async () => {
          const s = new EventTarget();
          s.release = async () => { window.__stubReleased++; };
          return s;
        },
      } });
    });
    await app.goto(`#/card/${ids.BookNook}/barcode`);
    await page.locator('.view-barcode svg.barcode-svg').waitFor();
    check((await status()).includes('stay on'), 'stubbed wake lock granted -> "stay on" status');
    await app.goto('#/');
    check((await page.evaluate(() => window.__stubReleased)) === 1, 'stubbed sentinel released on leave');

    // --- 2. QR
    await app.goto(`#/card/${ids.StreamFlix}/barcode`);
    const qr = page.locator('.view-barcode .barcode-qr svg');
    await qr.waitFor();
    const qb = await qr.boundingBox();
    check(Math.abs(qb.width - qb.height) < 2, `QR is square (${Math.round(qb.width)}x${Math.round(qb.height)})`);
    check(qb.width > 250, 'QR is large');
    const text = await page.locator('#view').innerText();
    check(text.includes('SFX-9QK2-77LM-0P3A') && text.includes('0099'), 'QR card shows number and PIN');
    const qpng = await qr.screenshot();
    const qdec = await page.evaluate(async (b64) => {
      const { loadScript } = await import('./js/ui.js');
      const Z = await loadScript('vendor/zxing/zxing-browser.min.js', 'ZXingBrowser');
      return (await new Z.BrowserMultiFormatReader().decodeFromImageUrl('data:image/png;base64,' + b64)).getText();
    }, qpng.toString('base64'));
    check(qdec === 'https://example.com/redeem?code=SFX-9QK2-77LM-0P3A', 'ZXing decodes rendered QR');

    // --- 3. Code 128
    await app.goto(`#/card/${ids['Coffee Corner']}/barcode`);
    await page.locator('.view-barcode svg.barcode-svg').waitFor();
    check(await page.locator('.barcode-note').count() === 0, 'Code 128 renders without note');

    // --- 4. fallbacks
    const mk = (barcodeFormat, barcodeValue, merchant) => page.evaluate(async (c) => {
      const db = await import('./js/db.js');
      return (await db.putCard({ originalAmount: 1000, currency: 'EUR', type: 'PHYSICAL', ...c })).id;
    }, { barcodeFormat, barcodeValue, merchant });
    for (const [fmt, val, name] of [['pdf417', 'ABC123456', 'PdfShop'], ['ean_13', '123', 'BadEan'], ['aztec', 'HELLO-42', 'AztecShop']]) {
      const id = await mk(fmt, val, name);
      await app.goto(`#/card/${id}/barcode`);
      await page.locator('.view-barcode svg.barcode-svg').waitFor();
      const note = await page.locator('.barcode-note').innerText();
      check(NOTE_RE.test(note), `${fmt}/${val}: Code 128 fallback with note`);
    }
    const longId = await mk('code_128', 'X'.repeat(60), 'LongShop');
    await app.goto(`#/card/${longId}/barcode`);
    await page.locator('.view-barcode .barcode-qr svg').waitFor();
    check(/QR code/.test(await page.locator('.barcode-note').innerText()), 'long value falls back to QR with note');
    for (const [fmt, val] of [['ean_8', '96385074'], ['upc_a', '036000291452'], ['upc_e', '04252614'], ['code_39', 'ABC-123'], ['itf', '12345670'], ['codabar', 'A123456A'], ['code_93', 'TEST93']]) {
      const id = await mk(fmt, val, 'F-' + fmt);
      await app.goto(`#/card/${id}/barcode`);
      await page.locator('.view-barcode svg.barcode-svg').waitFor();
      check(await page.locator('.barcode-note').count() === 0, `${fmt} renders natively`);
    }

    // --- 5. no barcode + unknown card
    await app.goto(`#/card/${ids['Tech Store']}/barcode`);
    check((await page.locator('#view').innerText()).includes('This card has no barcode saved'), 'no-barcode message');
    check((await page.locator('#view a[href$="/edit"]').getAttribute('href')) === `#/card/${ids['Tech Store']}/edit`, 'edit link present');
    await app.goto('#/card/does-not-exist/barcode');
    check((await page.locator('#view').innerText()).includes('Card not found'), 'unknown card empty state');

    // --- 360px width
    await page.setViewportSize({ width: 360, height: 740 });
    await app.goto(`#/card/${ids.BookNook}/barcode`);
    await page.locator('.view-barcode svg.barcode-svg').waitFor();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll at 360px');
  } finally {
    await app.close();
  }
}
