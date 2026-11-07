// Smoke test for non-money vouchers: add, detail, list, mark used, edit, backup, ICS.
import { readFileSync } from 'node:fs';
import { openApp, check, setMerchant } from './helpers.mjs';

export default async function () {
  const app = await openApp();
  const { page } = app;
  const text = () => page.locator('#view').innerText();
  const cards = () => page.evaluate(async () => (await import('./js/db.js')).getAllCards());
  const find = async (merchant) => (await cards()).find((c) => c.merchant === merchant);
  const hasError = (name) => page.locator(`[data-field="${name}"].has-error`).count().then((n) => n > 0);
  const isoIn = (days) => page.evaluate(async (d) => {
    const m = await import('./js/model.js');
    const t = new Date(); t.setDate(t.getDate() + d);
    return m.toIsoDate(t);
  }, days);
  const today = () => page.evaluate(async () => (await import('./js/model.js')).todayIso());
  const ITEM = 'Movie ticket + popcorn + drink';
  try {
    await app.wipe();

    // ---- 1. validation on the Add form
    await app.goto('#/add');
    check(await page.locator('#originalAmount').isVisible(), 'Money is the default: Amount visible');
    check(await page.locator('#voucherItem').isHidden(), 'voucher item hidden for Money');
    await page.press('#merchant', 'Escape'); // close the merchant quick-options popup
    await page.click('label:has(#kind-VOUCHER)');
    check(await page.locator('#originalAmount').isHidden(), 'Amount hidden for Voucher');
    check(await page.locator('#voucherItem').isVisible() && await page.locator('#usedAt').isVisible(), 'item + used-on shown for Voucher');
    await setMerchant(page, 'Cinema City');
    await page.click('button[type=submit]');
    check(await hasError('voucherItem'), 'empty item -> inline error');
    check(!(await hasError('originalAmount')), 'no amount error for a voucher');
    check((await cards()).length === 0, 'nothing saved on invalid submit');

    // ---- 2. add the voucher
    const expiry = await isoIn(20);
    await page.fill('#voucherItem', ITEM);
    await page.fill('#expiryDate', expiry);
    await page.click('button[type=submit]');
    await page.waitForFunction(() => location.hash.startsWith('#/card/') && !location.hash.endsWith('/edit'));
    const v = await find('Cinema City');
    check(v.kind === 'VOUCHER' && v.originalAmount === 0 && v.usedAt === '' && v.voucherItem === ITEM, 'saved as VOUCHER, amount 0, not used');

    // ---- 3. detail
    await page.waitForSelector('.detail-voucher-btn');
    let t = await text();
    check(t.includes(ITEM) && t.includes('Not used yet'), 'detail shows item and "Not used yet"');
    check(!t.includes('Transactions'), 'no Transactions section');
    check(await page.locator('.badge-expiring').textContent() === 'Expiring soon', 'Expiring soon badge');
    check(t.includes('Voucher for'), 'Details says "Voucher for"');

    // ---- 4. list
    await app.goto('#/');
    check(await page.locator('.list-card-item').innerText() === ITEM, 'list row shows the item');
    check(await page.locator('.list-voucher-tag').textContent() === 'Voucher', 'list row has the Voucher tag');
    check((await page.locator('.list-banner').innerText()).includes('Cinema City'), 'banner lists the voucher');
    check((await page.locator('.list-summary').innerText()).includes('1 voucher'), 'summary counts vouchers: ' + await page.locator('.list-summary').innerText());

    // ---- 5. mark as used
    await page.click('.list-card');
    await page.waitForSelector('.detail-voucher-btn');
    await page.click('.detail-voucher-btn');
    await page.waitForSelector('.badge-used');
    check(await page.locator('.badge-used').textContent() === 'Used', 'badge reads "Used"');
    check((await find('Cinema City')).usedAt === await today(), 'usedAt = today');
    check((await text()).includes('Used on'), 'detail says "Used on ..."');
    check((await page.locator('.detail-voucher-btn').innerText()) === 'Mark as not used', 'button flips');

    await app.goto('#/');
    check(await page.locator('.list-banner').count() === 0, 'banner no longer lists the used voucher');
    check(await page.locator('.list-card').count() === 0, 'Active filter hides it');
    await page.click('.chip:has-text("Used up")');
    check(await page.locator('.list-card .badge-used').textContent() === 'Used', 'Used up filter shows it with a "Used" badge');

    // ---- 6. mark as not used
    await page.click('.list-card');
    await page.waitForSelector('.detail-voucher-btn');
    await page.click('.detail-voucher-btn');
    await page.waitForSelector('.badge-expiring');
    check((await find('Cinema City')).usedAt === '', 'usedAt cleared');
    check((await text()).includes('Not used yet'), 'back to "Not used yet"');

    // ---- 7. edit form
    await page.click('button[aria-label="Edit card"]');
    await page.waitForSelector('#voucherItem');
    check(await page.locator('#kind-VOUCHER').isChecked(), 'Voucher preselected when editing');
    check(await page.inputValue('#voucherItem') === ITEM, 'item prefilled');
    check(await page.locator('#originalAmount').isHidden(), 'Amount hidden when editing a voucher');
    await page.fill('#usedAt', await isoIn(-1));
    await page.click('button[type=submit]');
    await page.waitForSelector('.badge-used');
    check((await find('Cinema City')).usedAt === await isoIn(-1), 'Used on saved from the form');
    await page.click('.detail-voucher-btn'); // back to not used for the next steps
    await page.waitForSelector('.badge-expiring');

    // ---- 8. a money card with a transaction cannot become a voucher
    const moneyId = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      const c = await db.putCard({ merchant: 'Shop', originalAmount: 5000, currency: 'ILS', type: 'PHYSICAL' });
      await db.putTransaction({ cardId: c.id, date: '2026-01-01', amount: 1000, note: '' });
      return c.id;
    });
    await app.goto(`#/card/${moneyId}/edit`);
    await page.waitForSelector('#kind-VOUCHER');
    check(await page.locator('#kind-VOUCHER').isDisabled(), 'Voucher option disabled for a money card with transactions');
    check((await text()).includes('Delete its transactions first'), 'hint explains why');
    check(await page.locator('#kind-MONEY').isChecked(), 'Money selected');

    // ---- 9. backup round trip keeps the voucher
    const before = await find('Cinema City');
    await page.evaluate(async () => {
      const b = await import('./js/services/backup.js');
      const json = JSON.stringify(await b.buildBackup());
      await window.dev.wipe();
      await b.importBackup(b.parseBackup(json), 'replace');
    });
    const after = await find('Cinema City');
    check(after && after.kind === 'VOUCHER' && after.voucherItem === ITEM && after.usedAt === before.usedAt && after.originalAmount === 0,
      'voucher survives export -> wipe -> import');

    // ---- 10. ICS export includes the unused voucher
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async () => (await import('./js/services/ics.js')).downloadExpiryIcs()),
    ]);
    const ics = readFileSync(await dl.path(), 'utf8');
    check(ics.includes('Voucher expires: Cinema City'), 'ICS contains "Voucher expires: Cinema City"');
  } finally {
    await app.close();
  }
}


