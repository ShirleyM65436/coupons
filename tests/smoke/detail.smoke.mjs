// Smoke test for the card detail view (#/card/:id).
import { openApp, check } from './helpers.mjs';

export default async function () {
  const app = await openApp({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = app.page;
  const text = () => page.locator('#view').innerText();
  const txs = (id) => page.evaluate(async (i) => (await import('./js/db.js')).getTransactions(i), id);
  try {
    await app.seed();
    const ids = await app.cardIds();

    // ---- 1. BookNook summary
    await app.goto(`#/card/${ids.BookNook}`);
    let t = await text();
    check(/29[.,]51/.test(t) && t.includes('₪'), 'BookNook balance ₪29.51');
    check(/of\s+₪\s?50[.,]00/.test(t), 'shows original amount');
    check(await page.locator('.badge-active').count() === 1, 'Active badge');
    check(/in \d+ days/.test(t), 'expiry shows "in N days"');
    check(await page.getByText('Show barcode').count() === 1, 'Show barcode button');
    check(await page.getByText('Open card link').count() === 0, 'no Open link button');
    const rows = await page.locator('.detail-tx').allInnerTexts();
    check(rows.length === 2, '2 transactions');
    check(rows[0].includes('Magazine') && rows[1].includes('Novel'), 'newest first');

    // photo dialog
    await page.locator('.detail-photo').click();
    check(await page.locator('dialog[open] img').count() === 1, 'photo opens in a dialog');
    await page.waitForFunction(() => document.querySelector('dialog[open] img')?.naturalWidth > 0);
    await page.locator('dialog[open] button:has-text("Close")').click();

    // ---- 2. PIN and copy
    check(!(await text()).includes('4821'), 'PIN hidden by default');
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    check((await text()).includes('4821'), 'PIN shown after Show');
    await page.getByRole('button', { name: 'Hide', exact: true }).click();
    check(!(await text()).includes('4821'), 'PIN hidden again');
    await page.getByRole('button', { name: 'Copy PIN' }).click();
    check((await page.evaluate(() => navigator.clipboard.readText())) === '4821', 'copy PIN copies real PIN');
    await page.getByRole('button', { name: 'Copy card number' }).click();
    check((await page.evaluate(() => navigator.clipboard.readText())) === '6035771234567890', 'card number copied');

    // ---- 3. add transactions
    await page.fill('[name="amount"]', '100');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    check(await page.locator('.field.has-error .error-text').count() === 1, 'too-large amount shows error');
    check((await txs(ids.BookNook)).length === 2, 'nothing saved for invalid amount');
    await page.fill('[name="amount"]', '');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    check(await page.locator('.field.has-error .error-text').count() === 1, 'empty amount shows error');
    check((await txs(ids.BookNook)).length === 2, 'nothing saved for empty amount');

    await page.fill('[name="amount"]', '1,51');
    await page.fill('[name="note"]', 'Pen');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.detail-tx').length === 3);
    t = await text();
    check(/28[.,]00/.test(t), 'balance updated to 28.00');
    const saved = await txs(ids.BookNook);
    const today = await page.evaluate(async () => (await import('./js/model.js')).todayIso());
    const pen = saved.find((x) => x.note === 'Pen');
    check(pen && pen.amount === 151 && pen.date === today, 'transaction saved with cents and today date');

    // ---- 4. delete a transaction
    await page.getByRole('button', { name: 'Delete transaction' }).first().click();
    await page.locator('dialog[open] button:has-text("Delete")').click();
    await page.waitForFunction(() => document.querySelectorAll('.detail-tx').length === 2);
    check(/29[.,]51/.test(await text()), 'balance restored after delete');

    // ---- 5. StreamFlix
    await app.goto(`#/card/${ids.StreamFlix}`);
    const link = page.locator('a:has-text("Open card link")');
    check((await link.getAttribute('href')) === 'https://example.com/redeem', 'link href');
    check((await link.getAttribute('target')) === '_blank', 'link target');
    check((await link.getAttribute('rel')).includes('noopener'), 'link rel noopener');
    check(await page.locator('.badge-expiring').count() === 1, 'StreamFlix expiring badge');

    // ---- 6. other states
    await app.goto(`#/card/${ids['Garden World']}`);
    check(await page.locator('.badge-expired').count() === 1 && (await text()).includes('Expired 5 days ago'), 'Garden World expired 5 days ago');
    await app.goto(`#/card/${ids['Pizza Palace']}`);
    t = await text();
    check(await page.locator('.badge-used').count() === 1, 'Pizza Palace used up badge');
    check(t.includes('No balance left') && await page.locator('[name="amount"]').isDisabled(), 'form disabled with note');
    await app.goto(`#/card/${ids['Tech Store']}`);
    check((await text()).includes('No expiry date') && await page.getByText('Show barcode').count() === 0, 'Tech Store: no expiry, no barcode button');

    // ---- 7. delete card (cancel, then confirm)
    const id = ids.BookNook;
    await app.goto(`#/card/${id}`);
    await page.getByRole('button', { name: 'Delete card' }).click();
    await page.locator('dialog[open] button:has-text("Cancel")').click();
    check(await page.evaluate(async (i) => !!(await (await import('./js/db.js')).getCard(i)), id), 'cancel keeps the card');
    await page.getByRole('button', { name: 'Delete card' }).click();
    await page.locator('dialog[open] button:has-text("Delete")').click();
    await page.waitForFunction(() => location.hash === '#/');
    const gone = await page.evaluate(async (i) => {
      const db = await import('./js/db.js');
      return { card: await db.getCard(i), tx: (await db.getTransactions(i)).length, photos: (await db.getAllPhotos()).length };
    }, id);
    check(!gone.card && gone.tx === 0 && gone.photos === 0, 'card, transactions and photo deleted');

    // ---- 8. unknown id
    await app.goto('#/card/does-not-exist');
    check((await text()).includes('Card not found'), 'unknown id shows Card not found');
  } finally {
    await app.close();
  }
}
