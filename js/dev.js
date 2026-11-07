// dev.js - demo data for development. Only loaded on localhost (see app.js).
// In the browser console:  await dev.seed()   /   await dev.wipe()

import { putCard, putTransaction, putPhoto, clearAll, getAllCards } from './db.js';
import { toIsoDate } from './model.js';

/** 'YYYY-MM-DD' for today + n days. */
function inDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toIsoDate(d);
}

/** A simple generated "photo" so the photo viewer has something to show. */
async function demoPhoto(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 500;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2b6cb0';
  ctx.fillRect(0, 0, 800, 500);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText(label, 40, 120);
  ctx.font = '40px monospace';
  ctx.fillText('6035 7712 3456 7890', 40, 320);
  ctx.fillText('VALID THRU 12/27', 40, 400);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

/**
 * Add demo cards covering every state: active, expiring soon, expired, used up,
 * electronic with link, barcode (EAN-13 and QR), photo, PIN.
 * Does nothing if cards already exist, unless force = true. Returns the number of cards added.
 */
export async function seedDemoData(force = false) {
  if (!force && (await getAllCards()).length) {
    console.info('dev.seed: cards already exist, skipping (use dev.seed(true) to add anyway)');
    return 0;
  }
  const photoId = await putPhoto(await demoPhoto('BookNook'));

  const cards = [
    { merchant: 'BookNook', cardNumber: '6035771234567890', pin: '4821', originalAmount: 5000, currency: 'ILS',
      issueDate: inDays(-60), expiryDate: inDays(400), type: 'PHYSICAL', barcodeValue: '4006381333931', barcodeFormat: 'ean_13',
      photoId, notes: 'Birthday present from Anna' },
    { merchant: 'Coffee Corner', cardNumber: '7777 1234 5678', originalAmount: 2500, currency: 'ILS',
      expiryDate: inDays(12), type: 'PHYSICAL', barcodeValue: '77771234567812', barcodeFormat: 'code_128' },
    { merchant: 'StreamFlix', cardNumber: 'SFX-9QK2-77LM-0P3A', pin: '0099', originalAmount: 3000, currency: 'ILS',
      issueDate: inDays(-20), expiryDate: inDays(25), type: 'ELECTRONIC', link: 'https://example.com/redeem',
      barcodeValue: 'https://example.com/redeem?code=SFX-9QK2-77LM-0P3A', barcodeFormat: 'qr_code' },
    { merchant: 'Garden World', cardNumber: '1200 3300 4400', originalAmount: 10000, currency: 'ILS',
      issueDate: inDays(-500), expiryDate: inDays(-5), type: 'PHYSICAL', notes: 'Expired last week' },
    { merchant: 'Pizza Palace', cardNumber: '5555666677778888', originalAmount: 2000, currency: 'ILS',
      expiryDate: inDays(200), type: 'PHYSICAL' },
    { merchant: 'Tech Store', originalAmount: 15000, currency: 'ILS', type: 'ELECTRONIC', link: 'https://example.com/tech' },
  ];

  const saved = [];
  for (const c of cards) saved.push(await putCard(c));

  // Transactions: BookNook partly spent, Pizza Palace fully spent (-> "used up").
  await putTransaction({ cardId: saved[0].id, date: inDays(-30), amount: 1299, note: 'Novel' });
  await putTransaction({ cardId: saved[0].id, date: inDays(-3), amount: 750, note: 'Magazine + bookmark' });
  await putTransaction({ cardId: saved[4].id, date: inDays(-10), amount: 2000, note: 'Family dinner' });
  await putTransaction({ cardId: saved[2].id, date: inDays(-1), amount: 999, note: 'Monthly plan' });

  console.info(`dev.seed: added ${saved.length} demo cards`);
  if (window.dev?.rerender) window.dev.rerender();
  return saved.length;
}

/** Delete all cards, transactions and photos. */
export async function wipeAll() {
  await clearAll();
  console.info('dev.wipe: all data deleted');
  if (window.dev?.rerender) window.dev.rerender();
}
