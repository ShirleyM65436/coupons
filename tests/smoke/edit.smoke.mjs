// Smoke test for the Add/Edit view (#/add, #/card/:id/edit). Covers acceptance criteria 1-7.
import { openApp, check, setMerchant } from './helpers.mjs';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export default async function () {
  const app = await openApp();
  const { page } = app;
  const cards = () => page.evaluate(async () => (await import('./js/db.js')).getAllCards());
  const hasError = (name) => page.locator(`[data-field="${name}"].has-error`).count().then((n) => n > 0);
  const errText = (name) => page.locator(`[data-field="${name}"] .error-text`).innerText();
  try {
    await app.seed();
    const before = (await cards()).length;

    // ---- 1. empty submit
    await app.goto('#/add');
    check((await page.locator('#app-title').innerText()) === 'Add card', 'add title');
    await page.click('button[type=submit]');
    check(await hasError('merchant'), 'empty submit: merchant error');
    check(await hasError('originalAmount'), 'empty submit: amount error');
    check(await page.evaluate(() => document.activeElement.id) === 'merchant', 'merchant focused');
    check((await cards()).length === before, 'nothing saved on invalid submit');

    // merchant quick options: a list under the text box; picking one fills the box
    const picks = () => page.locator('.merchant-option-pick').allInnerTexts();
    await page.click('#merchant');
    check(await page.locator('#merchant-options').isVisible(), 'quick options open under the merchant box');
    const initialPicks = await picks();
    check(['BuyMe', 'DreamCard', 'Fox'].every((o) => initialPicks.includes(o)), 'default quick options BuyMe, DreamCard, Fox');
    await page.click('.merchant-option-pick:has-text("DreamCard")');
    check((await page.inputValue('#merchant')) === 'DreamCard', 'picking an option fills the box');
    check(!(await hasError('merchant')), 'picking a merchant clears the error');
    // typing filters; a new name can be added to the list, and removed again
    await page.fill('#merchant', 'Cinema City');
    check((await picks()).some((t) => t.includes('Add "Cinema City"')), '"Add" entry offered for a new name');
    await page.click('.merchant-option-add .merchant-option-pick');
    const stored = await page.evaluate(async () => (await import('./js/db.js')).getMerchantOptions());
    check(stored.includes('Cinema City'), 'new quick option saved in the database');
    await page.fill('#merchant', '');
    await page.click('#merchant');
    check((await picks()).includes('Cinema City'), 'new option listed');
    await page.click('[aria-label="Remove Cinema City from quick options"]');
    const afterRemove = await page.evaluate(async () => (await import('./js/db.js')).getMerchantOptions());
    check(!afterRemove.includes('Cinema City') && afterRemove.length === 3, 'option removed again');
    await setMerchant(page, 'x');

    // ---- 2. amount 0, expiry <= issue
    await page.fill('#originalAmount', '0');
    await page.fill('#issueDate', '2026-05-02');
    await page.fill('#expiryDate', '2026-05-01');
    await page.click('button[type=submit]');
    check(/greater than 0/.test(await errText('originalAmount')), 'amount 0 error');
    check(await hasError('expiryDate'), 'expiry before issue error');
    await page.fill('#expiryDate', '2026-05-02');
    await page.click('button[type=submit]');
    check(await hasError('expiryDate'), 'expiry equal to issue error');
    await page.fill('#originalAmount', 'abc');
    await page.click('button[type=submit]');
    check((await errText('originalAmount')) === 'Enter a valid amount', 'unparsable amount error');

    // ---- 4. link visibility
    check(!(await page.locator('#link').isVisible()), 'link hidden for Physical');
    await page.click('label:has(#type-ELECTRONIC)');
    check(await page.locator('#link').isVisible(), 'link visible for Electronic');
    await page.fill('#link', 'example.com');
    await page.fill('#originalAmount', '5');
    await page.fill('#issueDate', '');
    await page.fill('#expiryDate', '');
    await page.click('button[type=submit]');
    check(await hasError('link'), 'electronic link without http error');
    await page.click('label:has(#type-PHYSICAL)');
    check(!(await page.locator('#link').isVisible()), 'link hidden again');

    // ---- 3. valid save (physical, link typed before switching must be dropped)
    await setMerchant(page, 'Test Shop');
    await page.fill('#originalAmount', '25,50');
    check(await page.locator('#currency').count() === 0, 'no currency picker (shekel only)');
    await page.click('button[type=submit]');
    await page.waitForTimeout(500);
    const all = await cards();
    const saved = all.find((c) => c.merchant === 'Test Shop');
    check(!!saved, 'card saved');
    check(saved.originalAmount === 2550 && saved.currency === 'ILS', 'amount 2550 ILS');
    check(saved.link === '' && saved.type === 'PHYSICAL', 'physical card has empty link');
    for (const k of ['id', 'merchant', 'cardNumber', 'pin', 'originalAmount', 'currency', 'issueDate', 'expiryDate', 'type', 'link', 'barcodeValue', 'barcodeFormat', 'photoId', 'notes', 'createdAt']) {
      check(k in saved, `field ${k} present`);
    }
    check(await page.evaluate(() => location.hash) === `#/card/${saved.id}`, 'navigated to detail');

    // a dropdown merchant saves as-is and is pre-selected when editing
    await app.goto('#/add');
    await setMerchant(page, 'BuyMe');
    await page.fill('#originalAmount', '557');
    await page.click('button[type=submit]');
    await page.waitForTimeout(500);
    const buyme = (await cards()).find((c) => c.merchant === 'BuyMe');
    check(!!buyme, 'dropdown merchant "BuyMe" saved');
    await app.goto(`#/card/${buyme.id}/edit`);
    check((await page.inputValue('#merchant')) === 'BuyMe', 'edit shows the saved merchant in the box');

    // ---- 5. edit BookNook
    const ids = await app.cardIds();
    const bn = (await cards()).find((c) => c.id === ids.BookNook);
    await app.goto(`#/card/${ids.BookNook}/edit`);
    check((await page.locator('#app-title').innerText()) === 'Edit card', 'edit title');
    check((await page.locator('#originalAmount').inputValue()) === '50.00', 'amount prefilled 50.00');
    check((await page.locator('#merchant').inputValue()) === 'BookNook', 'merchant prefilled');
    await page.fill('#originalAmount', '10');
    await page.click('button[type=submit]');
    check(await hasError('originalAmount'), 'amount below spent rejected');
    await page.fill('#originalAmount', '50.00');
    await setMerchant(page, 'BookNook 2');
    await page.click('button[type=submit]');
    await page.waitForTimeout(500);
    const bn2 = (await cards()).find((c) => c.id === ids.BookNook);
    check(bn2.merchant === 'BookNook 2' && bn2.createdAt === bn.createdAt, 'same id and createdAt, merchant changed');
    check(bn2.photoId === bn.photoId && bn2.photoId, 'photo kept');

    // ---- 7b. remove photo on edit
    await app.goto(`#/card/${ids.BookNook}/edit`);
    check(await page.locator('.edit-photo-preview').isVisible(), 'existing photo previewed');
    await page.click('text=Remove photo');
    await page.click('button[type=submit]');
    await page.waitForTimeout(500);
    const bn3 = (await cards()).find((c) => c.id === ids.BookNook);
    check(bn3.photoId === '', 'photoId cleared');
    check(await page.evaluate(async (id) => (await (await import('./js/db.js')).getPhoto(id)) === undefined, bn.photoId), 'old photo deleted');

    // unknown id
    await app.goto('#/card/nope/edit');
    check((await page.locator('#view').innerText()).includes('Card not found'), 'card not found state');

    // ---- 7a. add with photo
    await app.goto('#/add');
    await setMerchant(page, 'Photo Shop');
    await page.fill('#originalAmount', '10');
    await page.setInputFiles('#photo', { name: 'p.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('.edit-photo-preview[src]');
    await page.click('button[type=submit]');
    await page.waitForTimeout(500);
    const ps = (await cards()).find((c) => c.merchant === 'Photo Shop');
    check(ps && ps.photoId, 'card has photoId');
    check(await page.evaluate(async (id) => (await (await import('./js/db.js')).getPhoto(id)) instanceof Blob, ps.photoId), 'getPhoto returns a Blob');

    // ---- 6. draft
    await page.evaluate(async () => {
      const { setDraft } = await import('./js/draft.js');
      setDraft({
        card: { cardNumber: '6035 7712', barcodeValue: '6035771', barcodeFormat: 'ean_8', expiryDate: '2027-12-31', originalAmount: 2500 },
        confidence: { expiryDate: 0.4, originalAmount: 0.9 },
        ocrText: 'VALID THRU 12/27',
      });
    });
    await app.goto('#/add');
    check((await page.locator('#cardNumber').inputValue()) === '6035 7712', 'draft card number');
    check((await page.locator('#originalAmount').inputValue()) === '25.00', 'draft amount 25.00');
    check((await page.locator('#barcodeFormat').inputValue()) === 'ean_8', 'draft barcode format');
    check((await page.locator('#expiryDate').inputValue()) === '2027-12-31', 'draft expiry');
    check(await page.locator('[data-field="expiryDate"].needs-check').count() === 1, 'expiry needs-check');
    check(await page.locator('[data-field="originalAmount"].needs-check').count() === 0, 'amount not needs-check');
    check((await page.locator('.edit-ocr summary').innerText()) === 'Recognized text', 'ocr details shown');
    check((await page.locator('.edit-ocr pre').textContent()).includes('VALID THRU'), 'ocr text present');
    await page.click('text=Cancel');
    await page.waitForTimeout(300);
    check(await page.evaluate(async () => (await import('./js/draft.js')).getDraft() === null), 'cancel clears draft');

    // narrow viewport: no horizontal overflow
    await page.setViewportSize({ width: 360, height: 740 });
    await app.goto('#/add');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'no horizontal overflow at 360px');
  } finally {
    await app.close();
  }
}


