// services/ics.js - iCalendar (.ics) export of gift card expiry dates.
// buildIcs is pure (no DOM, no IndexedDB) so it can be tested with node:test.
// downloadExpiryIcs loads the data lazily so importing this file in node works.

import { formatMoney } from '../model.js';

const CRLF = '\r\n';
const PRODID = '-//Gift Card Tracker//Expiry Reminders//EN';

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newlines. */
function escapeText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold one logical line to physical lines of at most 75 octets (UTF-8 aware).
 * Continuation lines start with a single space (which counts towards the 75).
 * Characters are never split in the middle of a multibyte sequence.
 */
function foldLine(line) {
  const encoder = new TextEncoder();
  const lines = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) { // iterates by code point, so surrogate pairs stay together
    const size = encoder.encode(ch).length;
    const limit = lines.length === 0 ? 75 : 74; // continuation lines lose 1 octet to the leading space
    if (currentBytes + size > limit) {
      lines.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += size;
  }
  lines.push(current);
  return lines.map((l, i) => (i === 0 ? l : ' ' + l)).join(CRLF);
}

/** Date -> 'YYYYMMDDTHHMMSSZ' in UTC. */
function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** 'YYYY-MM-DD' -> 'YYYYMMDD' (null if not a plain ISO date). */
function compactDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.replace(/-/g, '') : null;
}

/** 'YYYY-MM-DD' -> 'YYYYMMDD' of the following day (calendar maths done in UTC, no DST issues). */
function nextDayCompact(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Build an iCalendar (.ics) file with one all-day event per card on its expiry date,
 * each with alarms 30 days and 7 days before.
 * @param {{ card: object, balance: number }[]} entries  only cards with an expiryDate are included
 * @param {{ now?: Date }} [opts]  for DTSTAMP (tests pass a fixed date)
 * @returns {string} ICS text with CRLF line endings
 */
export function buildIcs(entries, { now = new Date() } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  const stamp = utcStamp(now);

  for (const { card, balance } of entries || []) {
    const start = compactDate(card?.expiryDate);
    if (!start) continue; // no (valid) expiry date -> nothing to remind about
    const voucher = card.kind === 'VOUCHER';
    const money = voucher ? '' : formatMoney(balance, card.currency, 'en');
    const merchant = card.merchant || 'Gift card';
    const digits = String(card.cardNumber || '').replace(/\D/g, '');

    const description = [];
    if (card.owner) description.push(`Owner: ${card.owner}`);
    if (digits) description.push(`Card ending ${digits.slice(-4)}`);
    if (voucher) {
      // Vouchers have no money: describe the item instead.
      description.push(`Voucher for: ${card.voucherItem || ''}`);
      description.push('Use this voucher before it expires.');
    } else {
      description.push(`Remaining balance: ${money}`);
      description.push('Use this gift card before it expires.');
    }
    if (card.notes) description.push(`Notes: ${card.notes}`);
    const summary = voucher
      ? `Voucher expires: ${merchant} (${card.voucherItem || 'voucher'})`
      : `Gift card expires: ${merchant} (${money})`;
    const alarmText = (days) => voucher
      ? `${merchant} voucher expires in ${days} days (${card.voucherItem || 'voucher'})`
      : `${merchant} gift card expires in ${days} days (${money} left)`;
    const descriptionText = description.join('\n'); // escapeText turns these into \n

    const alarm = (trigger, text) => [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `TRIGGER:${trigger}`,
      `DESCRIPTION:${escapeText(text)}`,
      'END:VALARM',
    ];

    lines.push(
      'BEGIN:VEVENT',
      `UID:${card.id}@gift-card-tracker`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${nextDayCompact(card.expiryDate)}`,
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${escapeText(descriptionText)}`,
      'TRANSP:TRANSPARENT',
      ...alarm('-P30D', alarmText(30)),
      ...alarm('-P7D', alarmText(7)),
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/**
 * Load all cards, keep those with remaining balance and an expiry date today or later,
 * and download them as gift-card-expiry.ics.
 * @returns {Promise<number>} number of events exported (0 -> nothing downloaded)
 */
export async function downloadExpiryIcs() {
  const [{ getAllCards, getAllTransactions }, { computeBalance, todayIso, hasValueLeft }, { downloadFile }] = await Promise.all([
    import('../db.js'),
    import('../model.js'),
    import('../ui.js'),
  ]);
  const [cards, transactions] = await Promise.all([getAllCards(), getAllTransactions()]);
  const today = todayIso();

  const entries = [];
  for (const card of cards) {
    if (!card.expiryDate || card.expiryDate < today) continue;
    const own = transactions.filter((t) => t.cardId === card.id);
    const balance = computeBalance(card, own);
    if (hasValueLeft(card, balance)) entries.push({ card, balance });
  }
  if (!entries.length) return 0;

  downloadFile('gift-card-expiry.ics', buildIcs(entries), 'text/calendar');
  return entries.length;
}
