// Unit tests for parseBackup validation (pure, runs in Node).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBackup, base64ToBlob } from '../js/services/backup.js';

const card = { id: 'c1', merchant: 'Shop', originalAmount: 1000 };
const file = (over = {}) => JSON.stringify({ app: 'gift-card-tracker', schemaVersion: 1, exportedAt: '2026-11-07T10:00:00.000Z', cards: [card], transactions: [], photos: [], ...over });

test('accepts a valid file and ignores unknown fields', () => {
  const p = parseBackup(file({ extra: 1, cards: [{ ...card, whatever: true }] }));
  assert.equal(p.cards.length, 1);
  assert.equal(p.schemaVersion, 1);
});

test('decodes photos to blobs', async () => {
  const p = parseBackup(file({ photos: [{ id: 'p1', type: 'image/jpeg', data: Buffer.from([1, 2, 3, 4]).toString('base64') }] }));
  assert.equal(p.photos[0].blob.size, 4);
  assert.equal(p.photos[0].blob.type, 'image/jpeg');
  assert.equal(base64ToBlob('AQID').size, 3);
});

test('rejects non-JSON and foreign JSON', () => {
  assert.throws(() => parseBackup('nope'), /not a gift card backup/);
  assert.throws(() => parseBackup('{}'), /not a gift card backup/);
  assert.throws(() => parseBackup('[]'), /not a gift card backup/);
  assert.throws(() => parseBackup('{"app":"other","schemaVersion":1}'), /not a gift card backup/);
});

test('rejects newer schema', () => {
  assert.throws(() => parseBackup(file({ schemaVersion: 2 })), /newer version of the app \(schema 2\)/);
});

test('rejects bad cards', () => {
  assert.throws(() => parseBackup(file({ cards: [card, { id: 'c2', originalAmount: 5 }] })), /card #2 has no merchant/);
  assert.throws(() => parseBackup(file({ cards: [{ ...card, id: '' }] })), /card #1 has no id/);
  assert.throws(() => parseBackup(file({ cards: [{ ...card, originalAmount: 10.5 }] })), /card #1/);
  assert.throws(() => parseBackup(file({ cards: [{ ...card, originalAmount: 0 }] })), /card #1/);
});

test('rejects bad transactions and photos', () => {
  const tx = { id: 't1', cardId: 'c1', date: '2026-01-01', amount: 5 };
  assert.throws(() => parseBackup(file({ transactions: [{ ...tx, amount: 1.5 }] })), /transaction #1/);
  assert.throws(() => parseBackup(file({ transactions: [{ ...tx, date: '' }] })), /transaction #1/);
  assert.throws(() => parseBackup(file({ photos: [{ id: 'p' }] })), /photo #1/);
  assert.throws(() => parseBackup(file({ photos: [{ id: 'p', data: '%%%' }] })), /photo #1/);
});
