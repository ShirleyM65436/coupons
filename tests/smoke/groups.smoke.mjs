// Smoke test for the "By merchant" view of the card list.
import { openApp, check } from './helpers.mjs';

export default async function () {
  const app = await openApp({ viewport: { width: 360, height: 800 } });
  const page = app.page;
  const chip = (label) => page.locator('.view-list .chip', { hasText: label });
  const groupRows = () => page.locator('.view-list button.list-group');
  const groupText = (name) => groupRows().filter({ hasText: name }).first().innerText();
  const names = () => page.locator('.view-list .list-group .list-card-merchant').allInnerTexts();
  const cardNames = () => page.locator('.view-list a.card .list-card-merchant').allInnerTexts();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mode = (id) => page.locator('#' + id);
  try {
    await app.wipe();
    // Test data (amounts are in agorot). Dates are relative so the test doesn't age.
    await page.evaluate(async () => {
      const db = await import('./js/db.js');
      const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      const add = async (c, spent = 0) => {
        const card = await db.putCard({ kind: 'MONEY', ...c });
        if (spent) await db.putTransaction({ cardId: card.id, date: day(-1), amount: spent });
        return card;
      };
      await add({ merchant: 'DreamCard', originalAmount: 10000 });
      await add({ merchant: 'DreamCard', originalAmount: 10000 });
      await add({ merchant: 'DreamCard', originalAmount: 20000 }, 5000);
      await add({ merchant: 'dreamcard', originalAmount: 10000, expiryDate: day(-10) }); // expired
      await add({ merchant: 'Fox', originalAmount: 20000 });
      await add({ merchant: 'BuyMe', originalAmount: 55700 }, 55700); // used up
      await db.putCard({ kind: 'VOUCHER', merchant: 'Cinema City', voucherItem: 'Movie ticket' });
      await db.putCard({ kind: 'VOUCHER', merchant: 'Cinema City', voucherItem: 'Popcorn', usedAt: day(-3) });
    });
    await app.goto('#/backup'); // leave and re-enter so the list re-renders with the new data
    await app.goto('#/');

    // 1. toggle, default mode
    check(await mode('mode-cards').isChecked(), 'default mode is Cards');
    check(same((await cardNames()).sort(), ['Cinema City', 'DreamCard', 'DreamCard', 'DreamCard', 'Fox']), 'Cards mode lists the 5 active cards: ' + (await cardNames()).join(', '));
    await page.locator('label:has(#mode-merchant)').click();
    check(await mode('mode-merchant').isChecked(), 'By merchant selected');
    check(await page.locator('.view-list a.card').count() === 0, 'card rows gone in merchant mode');

    // 2. groups, totals, order (Active filter)
    check(same(await names(), ['DreamCard', 'Fox', 'Cinema City']), 'groups ordered by total: ' + (await names()).join(', '));
    const dream = await groupText('DreamCard');
    check(dream.includes('₪350.00') && dream.includes('3 cards'), 'DreamCard ₪350.00, 3 cards: ' + dream.replace(/\n/g, ' | '));
    check((await groupText('Fox')).includes('₪200.00'), 'Fox ₪200.00');
    const cinema = await groupText('Cinema City');
    check(cinema.includes('1 voucher') && !cinema.includes('₪'), 'voucher-only group shows voucher count: ' + cinema.replace(/\n/g, ' | '));
    const summary = await page.locator('.view-list .list-summary').innerText();
    check(summary.includes('3 merchants') && summary.includes('₪550.00 available') && summary.includes('1 voucher'), 'summary: ' + summary);

    // 3. filters and search
    await chip('All').click();
    check(same(await names(), ['DreamCard', 'Fox', 'BuyMe', 'Cinema City']), 'All filter: lowercase merged, BuyMe added: ' + (await names()).join(', '));
    const dreamAll = await groupText('DreamCard');
    check(dreamAll.includes('₪350.00') && dreamAll.includes('4 cards'), 'expired card counted as card but not in total: ' + dreamAll.replace(/\n/g, ' | '));
    await chip('Used up').click();
    check(same((await names()).sort(), ['BuyMe', 'Cinema City']), 'Used up shows BuyMe and Cinema City');
    await chip('All').click();
    await page.locator('.view-list input[type=search]').fill('fox');
    check(same(await names(), ['Fox']), 'search filters groups');
    await page.locator('.view-list input[type=search]').fill('');
    await chip('Active').click();

    // 4. drill down
    await groupRows().filter({ hasText: 'DreamCard' }).click();
    check(same(await cardNames(), ['DreamCard', 'DreamCard', 'DreamCard']), 'drill-down lists only DreamCard cards');
    check((await page.locator('.view-list .list-drill').innerText()).includes('₪350.00'), 'drill header shows total');
    const href = await page.locator('.view-list a.card').first().getAttribute('href');
    check(/^#\/card\/.+/.test(href), 'rows link to card details');

    // 5. open a card and come back
    await page.locator('.view-list a.card').first().click();
    await page.waitForTimeout(300);
    check((await page.evaluate(() => location.hash)).startsWith('#/card/'), 'card opened');
    await page.evaluate(() => history.back());
    await page.waitForTimeout(300);
    check(await page.locator('.view-list .list-drill-back').count() === 1, 'back returns to the drilled merchant');
    check(same(await cardNames(), ['DreamCard', 'DreamCard', 'DreamCard']), 'still only DreamCard cards');

    // 6. empty drill-down keeps the back control
    await chip('Used up').click();
    const body = await page.locator('.view-list').innerText();
    check(body.includes('No cards match') && await page.locator('.view-list .list-drill-back').count() === 1,
      'empty state with back control when filter removes all cards');
    await chip('Active').click();

    // 7. back to groups, and Cards toggle clears drill-down
    check(await page.locator('.view-list .list-drill-back').evaluate((e) => e.getBoundingClientRect().height) >= 48, 'back control is >= 48px');
    await page.locator('.view-list .list-drill-back').click();
    check(await groupRows().count() === 3, '"All merchants" returns to group rows');
    await groupRows().filter({ hasText: 'Fox' }).click();
    await page.locator('label:has(#mode-cards)').click();
    check(await page.locator('.view-list .list-drill-back').count() === 0 && await page.locator('.view-list a.card').count() === 5,
      'switching to Cards clears drill-down');
    await page.locator('label:has(#mode-merchant)').click();
    check(await groupRows().count() === 3, 'drill-down was cleared (groups shown again)');

    // 8. persistence + layout
    await page.reload();
    await page.waitForFunction(() => window.dev);
    await page.waitForTimeout(300);
    check(await mode('mode-merchant').isChecked() && await groupRows().count() === 3, 'mode persists after reload');
    check(await page.evaluate(() => document.documentElement.scrollWidth) <= 360, 'no horizontal scroll at 360px');
    const small = await page.evaluate(() => [...document.querySelectorAll('.view-list .list-group, .view-list .segmented label')]
      .filter((e) => e.getBoundingClientRect().height < 48).length);
    check(small === 0, 'group rows and toggle are >= 48px');
    await page.locator('label:has(#mode-cards)').click(); // leave default mode behind
  } finally {
    await app.close();
  }
}
