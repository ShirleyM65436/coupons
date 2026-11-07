// Unit tests for js/model.js.  Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmountInput, minorToInputString, formatMoney, minorDigits, computeBalance, cardStatus, STATUS,
  daysUntil, parseIsoDate, isExpiringSoon, validateCard, validateTransaction, normalizeCard, isBackupOverdue,
} from '../js/model.js';

const NOW = new Date(2026, 5, 15); // 15 June 2026, local time

test('parseAmountInput handles common formats', () => {
  assert.equal(parseAmountInput('12', 'EUR'), 1200);
  assert.equal(parseAmountInput('12.5', 'EUR'), 1250);
  assert.equal(parseAmountInput('12,50', 'EUR'), 1250);
  assert.equal(parseAmountInput('€ 12.50', 'EUR'), 1250);
  assert.equal(parseAmountInput('1,234.50', 'USD'), 123450);
  assert.equal(parseAmountInput('1.234,50', 'EUR'), 123450);
  assert.equal(parseAmountInput('1 234,50', 'EUR'), 123450);
  assert.equal(parseAmountInput('1,234', 'USD'), 123400);
  assert.equal(parseAmountInput('0.99', 'USD'), 99);
  assert.equal(parseAmountInput('.5', 'USD'), 50);
  assert.equal(parseAmountInput('500', 'JPY'), 500);
  assert.equal(parseAmountInput('', 'EUR'), null);
  assert.equal(parseAmountInput('abc', 'EUR'), null);
  assert.equal(parseAmountInput('-5', 'EUR'), null);
  assert.equal(parseAmountInput('1.999', 'EUR'), 199900); // 3 digits after a single separator = thousands
  assert.equal(parseAmountInput('1.5', 'JPY'), null);     // JPY has no decimals
});

test('minorToInputString / minorDigits / formatMoney', () => {
  assert.equal(minorToInputString(1250, 'EUR'), '12.50');
  assert.equal(minorToInputString(500, 'JPY'), '500');
  assert.equal(minorDigits('EUR'), 2);
  assert.equal(minorDigits('JPY'), 0);
  assert.match(formatMoney(1250, 'EUR', 'en-US'), /€12\.50/);
});

test('computeBalance subtracts transactions', () => {
  assert.equal(computeBalance({ originalAmount: 5000 }, [{ amount: 1299 }, { amount: 750 }]), 2951);
  assert.equal(computeBalance({ originalAmount: 5000 }, []), 5000);
});

test('dates', () => {
  assert.equal(parseIsoDate('2026-02-31'), null);
  assert.equal(daysUntil('2026-06-15', NOW), 0);
  assert.equal(daysUntil('2026-06-25', NOW), 10);
  assert.equal(daysUntil('2026-06-10', NOW), -5);
  assert.equal(isExpiringSoon({ expiryDate: '2026-07-15' }, NOW), true);  // 30 days
  assert.equal(isExpiringSoon({ expiryDate: '2026-07-16' }, NOW), false); // 31 days
});

test('cardStatus precedence', () => {
  assert.equal(cardStatus({ expiryDate: '2026-06-01' }, 0, NOW), STATUS.USED);
  assert.equal(cardStatus({ expiryDate: '2026-06-01' }, 100, NOW), STATUS.EXPIRED);
  assert.equal(cardStatus({ expiryDate: '2026-06-20' }, 100, NOW), STATUS.EXPIRING);
  assert.equal(cardStatus({ expiryDate: '2027-06-20' }, 100, NOW), STATUS.ACTIVE);
  assert.equal(cardStatus({ expiryDate: '' }, 100, NOW), STATUS.ACTIVE);
});

test('validateCard', () => {
  const ok = { merchant: 'A', originalAmount: 100, currency: 'EUR', type: 'PHYSICAL' };
  assert.equal(validateCard(ok).valid, true);
  assert.ok(validateCard({ ...ok, merchant: ' ' }).errors.merchant);
  assert.ok(validateCard({ ...ok, originalAmount: 0 }).errors.originalAmount);
  assert.ok(validateCard({ ...ok, originalAmount: null }).errors.originalAmount);
  assert.ok(validateCard({ ...ok, issueDate: '2026-01-02', expiryDate: '2026-01-02' }).errors.expiryDate);
  assert.equal(validateCard({ ...ok, issueDate: '2026-01-02', expiryDate: '2026-01-03' }).valid, true);
  assert.ok(validateCard(ok, 200).errors.originalAmount, 'cannot go below spent');
  assert.ok(validateCard({ ...ok, type: 'ELECTRONIC', link: 'example.com' }).errors.link);
});

test('validateTransaction', () => {
  assert.equal(validateTransaction({ date: '2026-06-15', amount: 500 }, 500).valid, true);
  assert.ok(validateTransaction({ date: '2026-06-15', amount: 501 }, 500).errors.amount);
  assert.ok(validateTransaction({ date: '2026-06-15', amount: 0 }, 500).errors.amount);
  assert.ok(validateTransaction({ date: '', amount: 5 }, 500).errors.date);
});

test('normalizeCard fills defaults and drops link for physical cards', () => {
  const c = normalizeCard({ merchant: ' Shop ', originalAmount: 100, type: 'PHYSICAL', link: 'https://x' });
  assert.equal(c.merchant, 'Shop');
  assert.equal(c.link, '');
  assert.ok(c.id && c.createdAt);
  assert.equal(c.barcodeFormat, '');
});

test('isBackupOverdue', () => {
  assert.equal(isBackupOverdue(null, NOW), true);
  assert.equal(isBackupOverdue(new Date(2026, 5, 1).toISOString(), NOW), false);
  assert.equal(isBackupOverdue(new Date(2026, 4, 1).toISOString(), NOW), true);
});
