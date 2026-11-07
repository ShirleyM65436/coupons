// End-to-end smoke test of the scan flow: #/scan "Choose image" -> barcode decode -> OCR step
// (progress, skip, leaving) -> #/add pre-filled -> Save.
import { openApp, check, setMerchant } from './helpers.mjs';

export default async function () {
  const app = await openApp();
  const { page } = app;
  const hash = () => page.evaluate(() => location.hash);
  const val = (name) => page.inputValue(`input[name="${name}"], select[name="${name}"]`);

  /** Draw the "card photo" in the page and return it as base64 PNG. */
  const makeImage = (withBarcode) => page.evaluate(async (withBarcode) => {
    const { loadScript } = await import('./js/ui.js');
    const c = document.createElement('canvas');
    c.width = 1600; c.height = 1000;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1600, 1000);
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 110px Arial, sans-serif'; ctx.fillText('GIFT CARD', 80, 160);
    ctx.font = '80px Arial, sans-serif';
    ctx.fillText('Card No 6035 7712 3456 7890', 80, 320);
    ctx.fillText('Valid thru 12/2027', 80, 460);
    ctx.fillText('Value €25.00', 80, 600);
    if (withBarcode) {
      const JsBarcode = await loadScript('vendor/jsbarcode/JsBarcode.all.min.js', 'JsBarcode');
      const bc = document.createElement('canvas');
      JsBarcode(bc, '4006381333931', { format: 'EAN13', width: 4, height: 160, margin: 30, displayValue: false, background: '#ffffff' });
      ctx.drawImage(bc, 80, 700);
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, withBarcode);

  /** Open #/scan and feed the image to "Choose image". */
  const chooseImage = async (b64) => {
    await app.goto('#/scan');
    await page.setInputFiles('.view-scan input[type=file]:not([capture])', {
      name: 'card.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64'),
    });
  };
  const progressScreen = () => page.waitForSelector('.view-scan h2:has-text("Reading your card")', { timeout: 15000 });
  const waitAdd = () => page.waitForFunction(() => location.hash === '#/add', null, { timeout: 40000 });

  try {
    const withBarcode = await makeImage(true);
    const textOnly = await makeImage(false);

    // ---- a) barcode + OCR: the barcode wins the card number, OCR fills the rest
    await app.wipe();
    await chooseImage(withBarcode);
    await progressScreen();
    check((await page.locator('.view-scan .progress .progress-bar').count()) === 1 && await page.isVisible('.view-scan .progress'), 'progress bar is shown');
    check(await page.isVisible('text=Skip text recognition'), 'skip button is shown');
    await waitAdd();
    await page.waitForSelector('input[name="cardNumber"]');
    check((await val('cardNumber')) === '4006381333931', `card number comes from the barcode (${await val('cardNumber')})`);
    check((await val('barcodeValue')) === '4006381333931', 'barcode value filled');
    check((await val('barcodeFormat')) === 'ean_13', `barcode format ean_13 (${await val('barcodeFormat')})`);
    check((await val('expiryDate')) === '2027-12-31', `expiry read by OCR (${await val('expiryDate')})`);
    check((await val('originalAmount')) === '25.00', `amount read by OCR (${await val('originalAmount')})`);
    check((await page.locator('#currency').count()) === 0, 'no currency picker (shekel only)');
    check(await page.isVisible('.edit-photo-preview'), 'photo preview visible');
    const ocrText = await page.locator('.edit-ocr').textContent();
    check(ocrText.includes('6035'), 'recognized text contains the OCR card number');

    await setMerchant(page, 'Scan Test Shop');
    await page.click('button[type=submit]');
    await page.waitForFunction(() => location.hash.startsWith('#/card/'), null, { timeout: 10000 });
    const saved = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      const card = (await db.getAllCards())[0];
      const photo = card.photoId ? await db.getPhoto(card.photoId) : null;
      return { card, photoType: photo && photo.type, photoSize: photo && photo.size };
    });
    check(!!saved.card.photoId && saved.photoType === 'image/jpeg' && saved.photoSize > 0, `photo stored as JPEG (${saved.photoType}, ${saved.photoSize} bytes)`);
    check(saved.card.originalAmount === 2500, 'saved amount is 2500');
    check(saved.card.expiryDate === '2027-12-31', 'saved expiry is 2027-12-31');

    // ---- b) no barcode: card number comes from OCR
    await app.wipe();
    await chooseImage(textOnly);
    await waitAdd();
    await page.waitForSelector('input[name="cardNumber"]');
    check((await val('cardNumber')) === '6035771234567890', `card number from OCR (${await val('cardNumber')})`);
    check((await val('barcodeValue')) === '', 'no barcode value');
    check((await val('expiryDate')) === '2027-12-31', 'expiry from OCR');

    // ---- c) Skip: barcode + photo only, and the late OCR result is ignored
    await chooseImage(withBarcode);
    await progressScreen();
    await page.click('text=Skip text recognition');
    await waitAdd();
    await page.waitForSelector('input[name="cardNumber"]');
    check((await val('cardNumber')) === '4006381333931', 'skip: barcode number kept');
    check((await val('expiryDate')) === '' && (await val('originalAmount')) === '', 'skip: no expiry/amount from OCR');
    check(await page.isVisible('.edit-photo-preview'), 'skip: photo kept');
    await page.waitForTimeout(4000);
    check((await hash()) === '#/add', 'skip: still on #/add after OCR would have finished');
    check((await val('expiryDate')) === '' && (await val('originalAmount')) === '', 'skip: fields unchanged afterwards');

    // ---- d) leaving during OCR: the result must not hijack navigation
    await chooseImage(withBarcode);
    await progressScreen();
    await app.goto('#/');
    await page.waitForTimeout(4000);
    check((await hash()) === '#/', `leaving: still on #/ (${await hash()})`);

    check(app.errors.length === 0, 'no console errors so far');
  } finally {
    await app.close();
  }
}
