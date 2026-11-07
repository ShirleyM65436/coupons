// Smoke test for the Backup view: export, round trip, merge/replace, invalid files, big photo, ICS.
import fs from 'node:fs';
import { openApp, check } from './helpers.mjs';

export default async function () {
  const app = await openApp();
  const { page } = app;
  try {
    await app.seed();

    // Snapshot of the DB: counts, BookNook balance, photo size/type.
    const snap = () => page.evaluate(async () => {
      const db = await import('./js/db.js');
      const model = await import('./js/model.js');
      const cards = await db.getAllCards();
      const txs = await db.getAllTransactions();
      const photos = await db.getAllPhotos();
      const book = cards.find((c) => c.merchant === 'BookNook');
      return {
        cards: cards.length, txs: txs.length, photos: photos.length,
        photoSizes: photos.map((p) => p.blob.size).sort(),
        photoTypes: photos.map((p) => p.blob.type),
        bookBalance: book ? model.computeBalance(book, txs.filter((t) => t.cardId === book.id)) : null,
        lastExport: await db.getMeta('lastExportAt'),
      };
    });
    const bodyText = () => page.locator('#view').innerText();
    const toastText = () => page.locator('#toast').innerText();

    /** Choose a file and return after the parse step (summary or error). */
    const chooseFile = async (path) => {
      await page.setInputFiles('[data-testid=import-input]', path);
      await page.waitForTimeout(400);
    };
    /** Run import in a mode; confirm = true clicks OK, false clicks Cancel. */
    const runMode = async (mode, confirm = true) => {
      await page.click(`[data-testid=${mode}]`);
      await page.click(`dialog button[value=${confirm ? 'ok' : 'cancel'}]`);
      await page.waitForTimeout(500);
    };

    await app.goto('#/backup');
    const before = await snap();
    check(before.cards === 6 && before.txs === 4 && before.photos === 1, 'seed state 6/4/1');
    check(before.bookBalance === 2951, 'BookNook balance 2951');
    check((await bodyText()).includes('Last export: Never'), 'Last export: Never initially');
    check((await bodyText()).includes('not made a backup'), 'reminder banner shown');

    // ---- 1. export
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=Export backup')]);
    const exportPath = await download.path();
    check(/^giftcards-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), 'filename pattern ' + download.suggestedFilename());
    const json = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    check(json.app === 'gift-card-tracker' && json.schemaVersion === 1, 'app + schemaVersion');
    check(json.cards.length === 6 && json.transactions.length === 4 && json.photos.length === 1, 'file has 6/4/1');
    check(json.photos[0].data.length > 100 && json.photos[0].type === 'image/jpeg', 'photo base64 present');
    await page.waitForTimeout(500);
    const t = await bodyText();
    check(/Last export: .*\(today\)/.test(t), 'Last export text updated');
    check(!t.includes('not made a backup') && !t.includes('been a while'), 'reminder gone');
    check(!!(await snap()).lastExport, 'meta lastExportAt set');
    // keep a stable copy of the file (Playwright deletes temp downloads on close)
    const keep = exportPath + '.keep.json';
    fs.copyFileSync(exportPath, keep);

    // ---- 2. round trip: wipe -> import replace
    await app.wipe();
    check((await snap()).cards === 0, 'wiped');
    await app.goto('#/backup');
    await chooseFile(keep);
    check((await bodyText()).includes('6 cards, 4 transactions, 1 photo'), 'summary shows counts');
    await runMode('replace');
    check((await toastText()).includes('Imported 6 cards'), 'toast Imported 6 cards');
    let s = await snap();
    check(s.cards === 6 && s.txs === 4 && s.photos === 1, 'restored 6/4/1');
    check(s.photoSizes[0] === before.photoSizes[0] && s.photoTypes[0] === 'image/jpeg', 'photo identical size + type');
    check(s.bookBalance === 2951, 'BookNook balance still 2951');

    // ---- 3. merge: same file -> no duplicates; added card -> 7; replace -> 6
    await chooseFile(keep);
    await runMode('merge');
    check((await snap()).cards === 6, 'merge same file keeps 6 cards');
    await page.evaluate(async () => {
      const db = await import('./js/db.js');
      await db.putCard({ merchant: 'Extra', originalAmount: 1000, currency: 'EUR' });
    });
    check((await snap()).cards === 7, 'added a card -> 7');
    await chooseFile(keep);
    await runMode('merge');
    check((await snap()).cards === 7, 'merge keeps the extra card (7)');
    await chooseFile(keep);
    await runMode('replace');
    check((await snap()).cards === 6, 'replace -> 6');

    // ---- 5. cancel in confirm dialog
    await page.evaluate(async () => {
      const db = await import('./js/db.js');
      await db.putCard({ merchant: 'Extra2', originalAmount: 1000, currency: 'EUR' });
    });
    await chooseFile(keep);
    await runMode('replace', false);
    check((await snap()).cards === 7, 'cancelled replace changed nothing');
    await page.evaluate(async () => { const db = await import('./js/db.js'); const c = (await db.getAllCards()).find((x) => x.merchant === 'Extra2'); await db.deleteCard(c.id); });

    // ---- 4. invalid files never change data
    const dir = fs.mkdtempSync(exportPath.replace(/[^\\/]+$/, 'bad-'));
    const bad = {
      'notjson.json': 'hello, this is not json',
      'empty.json': '{}',
      'newer.json': JSON.stringify({ app: 'gift-card-tracker', schemaVersion: 99, cards: [] }),
      'nomerchant.json': JSON.stringify({ app: 'gift-card-tracker', schemaVersion: 1, cards: [{ id: 'x', originalAmount: 100 }], transactions: [], photos: [] }),
      'badphoto.json': JSON.stringify({ app: 'gift-card-tracker', schemaVersion: 1, cards: [{ id: 'x', merchant: 'M', originalAmount: 100 }], transactions: [], photos: [{ id: 'p', data: '***not base64***' }] }),
    };
    const expectMsg = { 'notjson.json': 'not a gift card backup', 'empty.json': 'not a gift card backup', 'newer.json': 'newer version', 'nomerchant.json': 'card #1 has no merchant', 'badphoto.json': 'photo #1' };
    const baseline = await snap();
    for (const [name, content] of Object.entries(bad)) {
      const p = dir + '\\' + name;
      fs.writeFileSync(p, content);
      await chooseFile(p);
      const txt = await bodyText();
      check(txt.includes(expectMsg[name]), `${name}: friendly error shown`);
      check(await page.locator('[data-testid=replace]').count() === 0, `${name}: no import buttons`);
      const after = await snap();
      check(after.cards === baseline.cards && after.txs === baseline.txs && after.photos === baseline.photos, `${name}: data unchanged`);
    }

    // ---- 6. large photo survives round trip
    const bigSize = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      const bytes = new Uint8Array(3 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
      const id = await db.putPhoto(new Blob([bytes], { type: 'image/jpeg' }));
      await db.putCard({ merchant: 'BigPhoto', originalAmount: 500, currency: 'EUR', photoId: id });
      return bytes.length;
    });
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('text=Export backup')]);
    const keep2 = (await dl2.path()) + '.keep.json';
    fs.copyFileSync(await dl2.path(), keep2);
    await app.wipe();
    await app.goto('#/backup');
    await chooseFile(keep2);
    await runMode('replace');
    const big = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      const c = (await db.getAllCards()).find((x) => x.merchant === 'BigPhoto');
      return (await db.getPhoto(c.photoId))?.size;
    });
    check(big === bigSize, `3 MB photo identical after round trip (${big})`);

    // ---- 7. ICS button
    await page.click('text=Export expiry dates');
    await page.waitForTimeout(500);
    const ics = await toastText();
    check(/No cards with an upcoming expiry date|Calendar file with \d+ reminders? downloaded/.test(ics), 'ICS toast: ' + ics);
  } finally {
    await app.close();
  }
}
