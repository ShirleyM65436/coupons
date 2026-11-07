import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs } from '../js/services/ics.js';

const NOW = new Date('2026-11-07T10:30:00Z');
const card = (over = {}) => ({
  id: 'abc-123', merchant: 'BookNook', cardNumber: '6035 7712 3456 7890', currency: 'EUR',
  originalAmount: 5000, expiryDate: '2027-03-15', notes: '', ...over,
});
const build = (entries) => buildIcs(entries, { now: NOW });
/** Undo line folding: CRLF followed by a space is removed. */
const unfold = (text) => text.replace(/\r\n /g, '');
const logicalLines = (text) => unfold(text).split('\r\n').filter(Boolean);

test('valid calendar with CRLF line endings everywhere', () => {
  const ics = build([{ card: card(), balance: 4250 }]);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(ics), 'bare LF found');
  const lines = logicalLines(ics);
  for (const l of ['VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']) assert.ok(lines.includes(l), l);
  assert.ok(lines.some((l) => l.startsWith('PRODID:')));
});

test('event fields', () => {
  const lines = logicalLines(build([{ card: card(), balance: 4250 }]));
  assert.ok(lines.includes('UID:abc-123@gift-card-tracker'));
  assert.ok(lines.includes('DTSTAMP:20261107T103000Z'));
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20270315'));
  assert.ok(lines.includes('DTEND;VALUE=DATE:20270316'));
  assert.ok(lines.includes('SUMMARY:Gift card expires: BookNook (€42.50)'));
  const desc = lines.find((l) => l.startsWith('DESCRIPTION:Card ending'));
  assert.ok(desc.includes('Card ending 7890'));
  assert.ok(!desc.includes('6035'), 'only last 4 digits may appear');
  assert.ok(desc.includes('€42.50'));
});

test('two display alarms per event (-P30D and -P7D)', () => {
  const ics = build([{ card: card(), balance: 100 }, { card: card({ id: 'x2' }), balance: 100 }]);
  const lines = logicalLines(ics);
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 2);
  assert.equal(lines.filter((l) => l === 'BEGIN:VALARM').length, 4);
  assert.equal(lines.filter((l) => l === 'TRIGGER:-P30D').length, 2);
  assert.equal(lines.filter((l) => l === 'TRIGGER:-P7D').length, 2);
  assert.equal(lines.filter((l) => l === 'ACTION:DISPLAY').length, 4);
  assert.equal(lines.filter((l) => l.startsWith('DESCRIPTION:')).length, 2 + 4);
});

test('DTEND rolls over month and year boundaries', () => {
  const end = (expiryDate) => logicalLines(build([{ card: card({ expiryDate }), balance: 1 }]))
    .find((l) => l.startsWith('DTEND')).split(':')[1];
  assert.equal(end('2027-12-31'), '20280101');
  assert.equal(end('2027-01-31'), '20270201');
  assert.equal(end('2028-02-28'), '20280229'); // leap year
  assert.equal(end('2028-02-29'), '20280301');
  assert.equal(end('2027-02-28'), '20270301');
});

test('escapes backslash, semicolon, comma and newlines in text', () => {
  const ics = build([{ card: card({ merchant: 'A,B;C\\D', notes: 'line1\nline2\r\nline3, ok;' }), balance: 100 }]);
  const lines = logicalLines(ics);
  assert.ok(lines.some((l) => l.startsWith('SUMMARY:Gift card expires: A\\,B\\;C\\\\D (')));
  const desc = lines.find((l) => l.startsWith('DESCRIPTION:Card ending'));
  assert.ok(desc.includes('Notes: line1\\nline2\\nline3\\, ok\\;'));
  assert.ok(!ics.includes('line1\nline2'), 'raw newline leaked');
});

test('folds long lines at 75 octets and unfolding restores the text (multibyte safe)', () => {
  const merchant = 'Café Müller ☕ '.repeat(20) + '😀'.repeat(10);
  const ics = build([{ card: card({ merchant }), balance: 100 }]);
  const encoder = new TextEncoder();
  for (const physical of ics.split('\r\n')) {
    assert.ok(encoder.encode(physical).length <= 75, `line too long (${encoder.encode(physical).length}): ${physical}`);
  }
  assert.ok(ics.split('\r\n').some((l) => l.startsWith(' ')), 'expected continuation lines');
  const summary = unfold(ics).split('\r\n').find((l) => l.startsWith('SUMMARY:'));
  assert.ok(summary.includes(merchant), 'unfolded SUMMARY must contain the full merchant');
  assert.ok(!unfold(ics).includes('�'), 'a multibyte character was split');
});

test('cards without expiry are skipped', () => {
  const ics = build([
    { card: card({ id: 'a', expiryDate: '' }), balance: 100 },
    { card: card({ id: 'b', expiryDate: undefined }), balance: 100 },
    { card: card({ id: 'c' }), balance: 100 },
  ]);
  const lines = logicalLines(ics);
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 1);
  assert.ok(lines.includes('UID:c@gift-card-tracker'));
});

test('empty input still yields a valid calendar', () => {
  for (const input of [[], undefined]) {
    const ics = buildIcs(input, { now: NOW });
    assert.equal(ics, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gift Card Tracker//Expiry Reminders//EN',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'END:VCALENDAR', ''].join('\r\n'));
  }
});
