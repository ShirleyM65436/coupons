// Smoke test for the card list view (#/).
import { openApp, check } from './helpers.mjs';

export default async function () {
  const app = await openApp({ viewport: { width: 360, height: 800 } });
  const page = app.page;
  const names = () => page.locator('.view-list a.card .list-card-merchant').allInnerTexts();
  const chip = (label) => page.locator('.view-list .chip', { hasText: label });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  try {
    await app.seed();
    const ids = await app.cardIds();
    await app.goto('#/');

    // 1. default filter + order
    let list = await names();
    check(same(list, ['Coffee Corner', 'StreamFlix', 'BookNook', 'Tech Store']),
      'Active filter shows 4 cards in expiry order: ' + list.join(', '));

    // 2. balances
    const rowText = (m) => page.locator('.view-list a.card', { hasText: m }).innerText();
    check((await rowText('BookNook')).includes('€29.51'), 'BookNook balance is €29.51');
    check((await rowText('StreamFlix')).includes('$20.01'), 'StreamFlix balance is $20.01');
    check((await rowText('Tech Store')).includes('No expiry'), 'Tech Store shows "No expiry"');

    // 3. banner
    const banner = page.locator('.view-list .banner-warn');
    const bannerText = await banner.innerText();
    check(bannerText.includes('Coffee Corner') && bannerText.includes('12 days left')
      && bannerText.includes('StreamFlix') && bannerText.includes('25 days left') && !bannerText.includes('BookNook'),
      'banner lists Coffee Corner and StreamFlix with days left');
    await banner.locator('a', { hasText: 'StreamFlix' }).click();
    await page.waitForTimeout(300);
    check(await page.evaluate(() => location.hash) === '#/card/' + ids.StreamFlix, 'banner link opens the card');

    // 4. filters
    await app.goto('#/');
    await chip('Used up').click();
    check(same(await names(), ['Pizza Palace']), 'Used up shows only Pizza Palace');
    await chip('Expired').click();
    check(same(await names(), ['Garden World']), 'Expired shows only Garden World');
    check(await page.locator('.view-list .banner-warn').count() === 1, 'banner stays visible with other filters');
    await chip('All').click();
    list = await names();
    check(list.length === 6 && list[4] === 'Garden World' && list[5] === 'Pizza Palace', 'All shows 6, expired then used last');

    // 5. search + persistence
    await page.locator('.view-list input[type=search]').fill('PIZZA');
    check(same(await names(), ['Pizza Palace']), 'search "PIZZA" with All shows only Pizza Palace');
    await page.locator('.view-list a.card').first().click();
    await page.waitForTimeout(300);
    check(await page.evaluate(() => location.hash) === '#/card/' + ids['Pizza Palace'], 'card row opens detail');
    await page.evaluate(() => { location.hash = '#/'; });
    await page.waitForTimeout(300);
    check(await page.locator('.view-list input[type=search]').inputValue() === 'PIZZA', 'search text persists');
    check(same(await names(), ['Pizza Palace']), 'filtered list persists');
    await page.locator('.view-list input[type=search]').fill('zzz');
    check((await page.locator('.view-list').innerText()).includes('No cards match'), '"No cards match" empty state');
    await page.locator('.view-list input[type=search]').fill('');
    check(await page.locator('.view-list a.card').count() === 6, 'clearing search restores All');

    // 8. layout
    check(await page.evaluate(() => document.documentElement.scrollWidth) <= 360, 'no horizontal scroll at 360px');
    const small = await page.evaluate(() => [...document.querySelectorAll('.view-list .btn, .view-list .chip, .view-list a.card, .fab, .view-list input')]
      .filter((e) => e.getBoundingClientRect().height < 40).length);
    check(small === 0, 'buttons, chips, rows and input are big enough to tap');
    await page.screenshot({ path: process.env.TEMP + '\\list-smoke.png' });

    // 6. backup reminder
    await chip('Active').click();
    check(await page.locator('.view-list a.list-backup').count() === 1, 'backup reminder shown (never exported)');
    await page.evaluate(async () => {
      const db = await import('./js/db.js');
      await db.setMeta('lastExportAt', new Date().toISOString());
    });
    await app.goto('#/backup');
    await app.goto('#/');
    check(await page.locator('.view-list a.list-backup').count() === 0, 'backup reminder hidden after export');

    // 7. empty state
    await app.wipe();
    await app.goto('#/backup');
    await app.goto('#/');
    const empty = page.locator('.view-list .empty-state');
    check((await empty.innerText()).includes('No gift cards yet'), 'empty state shown after wipe');
    check(await empty.locator('a[href="#/scan"]').count() === 1 && await empty.locator('a[href="#/add"]').count() === 1,
      'empty state has Scan and Add actions');
  } finally {
    await app.close();
  }
}
