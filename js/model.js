// model.js - pure data helpers: money, dates, balance, status, validation.
// No DOM and no IndexedDB here, so this file can be unit-tested in Node.
//
// Conventions (see ARCHITECTURE.md):
//  - Money is always an integer in MINOR units (cents). 12.50 EUR -> 1250.
//  - Calendar dates are 'YYYY-MM-DD' strings in local time (no time zone).
//  - Timestamps (createdAt, exportedAt) are full ISO strings.

export const CARD_TYPES = Object.freeze({ PHYSICAL: 'PHYSICAL', ELECTRONIC: 'ELECTRONIC' });

/**
 * What a card is worth:
 *  MONEY   - a stored-value card: originalAmount + transactions -> balance (the default)
 *  VOUCHER - a non-money gift (movie ticket, "coffee + cake", spa treatment...):
 *            no amount; `voucherItem` says what it is for; `usedAt` is set when redeemed.
 */
export const CARD_KINDS = Object.freeze({ MONEY: 'MONEY', VOUCHER: 'VOUCHER' });

/** True for a non-money voucher card. Cards saved before vouchers existed count as MONEY. */
export function isVoucher(card) {
  return card?.kind === CARD_KINDS.VOUCHER;
}

/**
 * The app's only currency: Israeli new shekel (₪). Every card is saved with this currency.
 * (The `currency` field is still stored on each card, so supporting more currencies later
 * only needs a picker in the Add/Edit form again.)
 */
export const DEFAULT_CURRENCY = 'ILS';

/**
 * Starting list of merchant "quick options" shown under the Merchant box in Add/Edit.
 * The user can add/remove options in the app; the edited list is stored in IndexedDB
 * (db.getMerchantOptions / setMerchantOptions), so this is only the default.
 */
export const DEFAULT_MERCHANT_OPTIONS = ['BuyMe', 'DreamCard', 'Fox'];

/** A card counts as "expiring soon" this many days before its expiry date. */
export const EXPIRY_SOON_DAYS = 30;

/** Show the "please back up" reminder when the last export is older than this. */
export const BACKUP_REMINDER_DAYS = 30;

/** Card status values returned by cardStatus(). */
export const STATUS = Object.freeze({
  ACTIVE: 'active',     // has balance, not expiring within EXPIRY_SOON_DAYS
  EXPIRING: 'expiring', // has balance, expires within EXPIRY_SOON_DAYS (today included)
  EXPIRED: 'expired',   // has balance, expiry date is in the past
  USED: 'used',         // balance is 0 (takes precedence over expiry)
});

// ---------------------------------------------------------------- ids

/** Random unique id (UUID v4 when available). */
export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------- money

/** True for a 3-letter ISO 4217 code the browser knows, e.g. 'EUR'. */
export function isValidCurrency(code) {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

/** Number of decimal digits a currency uses (EUR -> 2, JPY -> 0). */
export function minorDigits(currency = DEFAULT_CURRENCY) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2; // unknown currency code
  }
}

/**
 * Format minor units for display, e.g. formatMoney(1250, 'EUR') -> "€12.50"
 * (exact output depends on the browser locale).
 */
export function formatMoney(minor, currency = DEFAULT_CURRENCY, locale = undefined) {
  const digits = minorDigits(currency);
  const value = (Number(minor) || 0) / 10 ** digits;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
  } catch {
    return value.toFixed(digits) + ' ' + currency;
  }
}

/**
 * Parse what a user typed into an amount field into minor units.
 * Accepts "12", "12.5", "12.50", "12,50", "1 234,50", "1,234.50", "€12.50".
 * Returns null if the text is empty or not a valid non-negative number.
 */
export function parseAmountInput(text, currency = DEFAULT_CURRENCY) {
  if (text == null) return null;
  const s = String(text).replace(/[^\d.,-]/g, ''); // drop currency symbols and spaces
  if (!s || s.includes('-')) return null;

  // Decide which character (if any) is the decimal separator.
  let decimalSep = null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // Both used: the one that comes last is the decimal separator ("1.234,50" / "1,234.50").
    decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const parts = s.split(sep);
    // A single separator followed by exactly 3 digits ("1,234") is a thousands
    // separator; so is a separator used more than once ("1.234.567").
    const isGrouping = parts.length > 2 || (parts[1].length === 3 && parts[0] !== '' && parts[0] !== '0');
    if (!isGrouping) decimalSep = sep;
  }

  let intPart = s;
  let fracPart = '';
  if (decimalSep) {
    const i = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, i);
    fracPart = s.slice(i + 1);
  }
  intPart = intPart.replace(/[.,]/g, ''); // remove grouping separators
  if (!/^\d*$/.test(fracPart) || (!intPart && !fracPart)) return null;

  const digits = minorDigits(currency);
  if (fracPart.length > digits) return null; // more decimals than the currency allows
  const n = Number((intPart || '0') + fracPart.padEnd(digits, '0'));
  return Number.isSafeInteger(n) ? n : null;
}

/** Minor units -> plain string for an <input>, e.g. 1250 -> "12.50". */
export function minorToInputString(minor, currency = DEFAULT_CURRENCY) {
  if (minor == null || minor === '') return '';
  const digits = minorDigits(currency);
  return (Number(minor) / 10 ** digits).toFixed(digits);
}

// ---------------------------------------------------------------- dates

/** Today as 'YYYY-MM-DD' in local time. */
export function todayIso(now = new Date()) {
  return toIsoDate(now);
}

/** Date object -> 'YYYY-MM-DD' (local time). */
export function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 'YYYY-MM-DD' -> Date at local midnight, or null if invalid. */
export function parseIsoDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  // Reject things like 2025-02-31 that JS would silently roll over.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

/** True if the string is a real calendar date in 'YYYY-MM-DD' form. */
export function isValidIsoDate(iso) {
  return parseIsoDate(iso) !== null;
}

/** Whole days from today until the given date (negative = in the past, 0 = today). */
export function daysUntil(iso, now = new Date()) {
  const target = parseIsoDate(iso);
  if (!target) return null;
  const today = parseIsoDate(todayIso(now));
  return Math.round((target - today) / 86400000);
}

/** Localized date for display, e.g. '2027-12-31' -> "31 Dec 2027". Empty string for no date. */
export function formatDate(iso, locale = undefined) {
  const date = parseIsoDate(iso);
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

// ---------------------------------------------------------------- balance & status

/** Sum of a card's transaction amounts (minor units). */
export function totalSpent(transactions) {
  return (transactions || []).reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
}

/** Current balance = originalAmount - sum(transactions). Never stored. */
export function computeBalance(card, transactions) {
  return (Number(card.originalAmount) || 0) - totalSpent(transactions);
}

/** True if the card has an expiry date that is before today. */
export function isExpired(card, now = new Date()) {
  const days = daysUntil(card.expiryDate, now);
  return days !== null && days < 0;
}

/** True if the card expires today or within `days` days. */
export function isExpiringSoon(card, now = new Date(), days = EXPIRY_SOON_DAYS) {
  const left = daysUntil(card.expiryDate, now);
  return left !== null && left >= 0 && left <= days;
}

/**
 * True while the card can still be used: money left, or a voucher not yet redeemed.
 * (Ignores expiry - combine with isExpired() if needed.)
 * @param {number} balance  computeBalance(card, transactions); ignored for vouchers
 */
export function hasValueLeft(card, balance) {
  return isVoucher(card) ? !card.usedAt : balance > 0;
}

/** One of STATUS.*. A used-up card / redeemed voucher is USED even if it is also expired. */
export function cardStatus(card, balance, now = new Date()) {
  if (!hasValueLeft(card, balance)) return STATUS.USED;
  if (isExpired(card, now)) return STATUS.EXPIRED;
  if (isExpiringSoon(card, now)) return STATUS.EXPIRING;
  return STATUS.ACTIVE;
}

/** Human label for a status (for badges). Pass the card so a redeemed voucher reads "Used". */
export function statusLabel(status, card = null) {
  if (status === STATUS.USED && isVoucher(card)) return 'Used';
  return { active: 'Active', expiring: 'Expiring soon', expired: 'Expired', used: 'Used up' }[status] || status;
}

/** True if a backup reminder should be shown (never exported, or exported long ago). */
export function isBackupOverdue(lastExportIso, now = new Date(), days = BACKUP_REMINDER_DAYS) {
  if (!lastExportIso) return true;
  const last = new Date(lastExportIso);
  if (isNaN(last)) return true;
  return (now - last) / 86400000 > days;
}

// ---------------------------------------------------------------- validation

/**
 * Validate a card before saving.
 * @param {object} card  GiftCard-shaped object (amounts already in minor units)
 * @param {number} spent optional sum of existing transactions (when editing)
 * @returns {{ valid: boolean, errors: Record<string,string> }} errors keyed by field name
 */
export function validateCard(card, spent = 0) {
  const errors = {};
  if (!card.merchant || !String(card.merchant).trim()) errors.merchant = 'Merchant is required.';
  if (card.kind !== undefined && card.kind !== CARD_KINDS.MONEY && card.kind !== CARD_KINDS.VOUCHER) errors.kind = 'Choose money or voucher.';
  if (isVoucher(card)) {
    // A voucher has no amount; it needs a description instead.
    if (!card.voucherItem || !String(card.voucherItem).trim()) errors.voucherItem = 'Describe what the voucher is for.';
    if (card.usedAt && !isValidIsoDate(card.usedAt)) errors.usedAt = 'Invalid date.';
  } else if (card.originalAmount == null || card.originalAmount === '' || !Number.isInteger(card.originalAmount)) {
    errors.originalAmount = 'Enter the card amount.';
  } else if (card.originalAmount <= 0) {
    errors.originalAmount = 'Amount must be greater than 0.';
  } else if (card.originalAmount < spent) {
    errors.originalAmount = 'Amount cannot be less than what was already spent.';
  }
  if (!isValidCurrency(card.currency)) errors.currency = 'Choose a currency.';
  if (card.issueDate && !isValidIsoDate(card.issueDate)) errors.issueDate = 'Invalid date.';
  if (card.expiryDate && !isValidIsoDate(card.expiryDate)) errors.expiryDate = 'Invalid date.';
  if (!errors.issueDate && !errors.expiryDate && card.issueDate && card.expiryDate && card.expiryDate <= card.issueDate) {
    errors.expiryDate = 'Expiry date must be after the issue date.';
  }
  if (card.type !== CARD_TYPES.PHYSICAL && card.type !== CARD_TYPES.ELECTRONIC) errors.type = 'Choose a card type.';
  if (card.type === CARD_TYPES.ELECTRONIC && card.link && !/^https?:\/\//i.test(card.link)) {
    errors.link = 'Link must start with http:// or https://';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Validate a new transaction against the card's remaining balance.
 * @param {object} tx       { date, amount (minor units) }
 * @param {number} balance  current balance BEFORE this transaction
 */
export function validateTransaction(tx, balance) {
  const errors = {};
  if (!tx.date || !isValidIsoDate(tx.date)) errors.date = 'Choose a date.';
  if (tx.amount == null || !Number.isInteger(tx.amount) || tx.amount <= 0) errors.amount = 'Amount must be greater than 0.';
  else if (tx.amount > balance) errors.amount = 'Amount is more than the remaining balance.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Build a clean GiftCard object with every field present (missing ones get defaults).
 * Use this before saving so stored records always have the same shape.
 */
export function normalizeCard(input) {
  const str = (v) => (v == null ? '' : String(v).trim());
  const voucher = input.kind === CARD_KINDS.VOUCHER;
  return {
    id: input.id || newId(),
    kind: voucher ? CARD_KINDS.VOUCHER : CARD_KINDS.MONEY,
    merchant: str(input.merchant),
    cardNumber: str(input.cardNumber),
    pin: str(input.pin),
    originalAmount: voucher ? 0 : Number(input.originalAmount) || 0,   // vouchers have no amount
    voucherItem: voucher ? str(input.voucherItem) : '',
    usedAt: voucher && input.usedAt ? input.usedAt : '',
    currency: input.currency || DEFAULT_CURRENCY,
    issueDate: input.issueDate || '',
    expiryDate: input.expiryDate || '',
    type: input.type === CARD_TYPES.ELECTRONIC ? CARD_TYPES.ELECTRONIC : CARD_TYPES.PHYSICAL,
    link: input.type === CARD_TYPES.ELECTRONIC ? str(input.link) : '',
    barcodeValue: str(input.barcodeValue),
    barcodeFormat: input.barcodeValue ? (input.barcodeFormat || 'code_128') : '',
    photoId: input.photoId || '',
    notes: str(input.notes),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}
