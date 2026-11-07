// services/ocrParser.js - turns raw OCR text of a gift card (or e-gift e-mail / receipt)
// into card fields. PURE: no DOM, no IndexedDB, so it runs in node:test.
// Contract: ARCHITECTURE.md section 6 ("OcrParser interface").
//
// How it works (read top to bottom, each step is a small named function):
//   1. normalizeLines   - clean whitespace/dashes, split into lines, repair O/0 l/1 S/5 B/8
//                         confusions inside digit runs ("fixDigitConfusions").
//   2. findDateCandidates -> pickExpiry      (dates are found FIRST and masked out of the lines,
//                         so later steps never mistake a date for a card number or an amount)
//   3. findCardCandidates / findCodeCandidates -> pickCardNumber
//   4. findAmountCandidates -> pickAmount, then pickCurrency
//
// CONFIDENCE RULES (0..1, 0 when the field is null). Rounded to 2 decimals.
//   cardNumber   digits only: 12-19 digits start at 0.60 (16 digits 0.65), 8-11 digits at 0.35.
//                +0.30 when a label ("Card No", "Nr.", "Kartennummer", "Number"...) sits right before it,
//                +0.05 for 4-digit grouping, +0.05 for a valid Luhn checksum, -0.10 if trailing groups
//                had to be cut off, -0.40 after "order/invoice/tel..." style words. Capped at 0.95.
//                alphanumeric e-gift codes: 0.80 when labelled "Code", 0.50 unlabelled (SFX-9QK2-77LM-0P3A).
//   expiryDate   labelled expiry + clean date 0.92 (-0.25 if day/month order was ambiguous,
//                -0.05 for month-only or 2-digit year, -0.05 when several labelled dates exist).
//                unlabelled: single date 0.62, ambiguous 0.35, MM/YY style 0.35, several dates 0.40
//                (we then pick the LATEST one - expiry is normally the last date on a card).
//                Dates labelled Issued/Purchase/Date/Valid from are ignored completely.
//   amount       currency attached 0.60, bare number after an amount label 0.50, +0.30 for a label
//                ("Value", "Balance", "Guthaben"...), -0.30 for "Total/Tax/Change/Minimum..." words,
//                -0.15 when other, different amounts are almost as likely. > 10000 major units -> 0.10.
//   currency     ISO code written out 0.92, symbol 0.85, plain "$" 0.65 (assumed USD), a code merely
//                found elsewhere in the text 0.50, a lone symbol with no amount 0.40.

import { parseAmountInput } from '../model.js';

// =============================================================== 1. normalisation

/** Clean the raw OCR text: unify whitespace and dashes, split lines, repair digit confusions. */
function normalizeLines(text) {
  const s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[  -​ \t]/g, ' ')   // odd spaces and tabs -> space
    .replace(/[‐-―−]/g, '-');           // hyphen/en/em dash/minus -> '-'
  return s
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Inside a run of digit-like characters (digits plus O o I l | S B) replace the look-alike letters
 * with digits, but only when the run has at least as many real digits as letters.
 * "6O35" -> "6035", "77l2" -> "7712", "12/2O27" -> "12/2027"; ordinary words are untouched.
 */
function fixDigitConfusions(line) {
  return line.replace(/[0-9OoIl|SB](?:[0-9OoIl|SB.,/]*[0-9OoIl|SB])/g, (run) => {
    const digits = (run.match(/\d/g) || []).length;
    const letters = run.length - digits;
    if (digits < 1 || letters > digits) return run;
    return run.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  });
}

/** Up to `n` characters of context in front of position `start` on line `idx`.
 *  If the text directly in front is empty/punctuation (label on the previous line), the end of
 *  the previous line is used instead. */
function contextBefore(lines, idx, start, n = 32) {
  const prefix = lines[idx].slice(Math.max(0, start - n), start);
  if (/^[\s:.#=\-,]*$/.test(prefix) && idx > 0) {
    return lines[idx - 1].slice(-n) + ' ' + prefix;
  }
  return prefix;
}

/** Last regex match (global regex) in `str`, or null. */
function lastMatch(rx, str) {
  let last = null;
  for (const m of str.matchAll(rx)) last = m;
  return last;
}

/** True if the last match of `rx` in `ctx` is directly followed by (at most) separators. */
function labelAdjacent(rx, ctx) {
  const m = lastMatch(rx, ctx);
  if (!m) return null;
  const rest = ctx.slice(m.index + m[0].length);
  return /^[\s:.#=\-]{0,6}$/.test(rest) ? m : null;
}

const pad = (s) => Math.round(s * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// =============================================================== 2. dates

const MONTHS = {
  jan: 1, january: 1, januar: 1, jänner: 1,
  feb: 2, february: 2, februar: 2,
  mar: 3, march: 3, märz: 3, marz: 3, maerz: 3, mär: 3,
  apr: 4, april: 4,
  may: 5, mai: 5,
  jun: 6, june: 6, juni: 6,
  jul: 7, july: 7, juli: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, okt: 10, oktober: 10,
  nov: 11, november: 11,
  dec: 12, december: 12, dez: 12, dezember: 12,
};
const monthNumber = (word) => MONTHS[word.toLowerCase()] || null;

// Labels in front of a date. The label closest to the date wins (compared by end position).
const EXPIRY_LABEL = /(?<![a-z])(?:exp(?:ir\w*|\.)?(?:\s*date)?|valid\s*(?:thru|through|until|till|to)|valid(?!\s*from)|good\s*(?:thru|through|until)|use\s*by|best\s*before|g[uü]ltig\s*(?:bis|until)|g[uü]ltig(?!\s*ab)|ablauf\w*|verfall\w*|g[uü]ltigkeit\w*|mhd|until|thru|through|till|bis)(?![a-z])/gi;
const ISSUE_LABEL = /(?<![a-z])(?:issued?(?:\s*(?:on|date))?|date\s+of\s+(?:issue|purchase)|purchase[ds]?(?:\s*date)?|bought|activated|activation|valid\s*from|g[uü]ltig\s*ab|kaufdatum|ausgestellt\w*|ausstellung\w*|order(?:ed)?(?:\s*(?:date|on))?|datum|date|time|zeit)(?![a-z])/gi;

/** 'expiry' | 'issue' | null for the text in front of a date. */
function dateLabelOf(ctx) {
  // A digit between the label and the date means the label belongs to another number.
  const e = lastMatch(EXPIRY_LABEL, ctx);
  const i = lastMatch(ISSUE_LABEL, ctx);
  const clean = (m) => (m && !/\d/.test(ctx.slice(m.index + m[0].length)) ? m : null);
  return labelKind(clean(e), clean(i));
}

function labelKind(e, i) {
  const eEnd = e ? e.index + e[0].length : -1;
  const iEnd = i ? i.index + i[0].length : -1;
  if (eEnd < 0 && iEnd < 0) return null;
  return eEnd >= iEnd ? 'expiry' : 'issue';
}

const MW = '([A-Za-zÄÖÜäöü]{3,9})';
const DATE_PATTERNS = [
  // 2027-12-31, 2027/12/31, 2027.12.31
  { name: 'ymd', rx: /(?<![\d./])(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)/g,
    parse: (m) => ({ y: +m[1], m: +m[3], d: +m[4], sep: m[2] }) },
  // 31/12/2027, 31.12.2027, 31-12-2027, 12/31/2027, also 31.12.27
  { name: 'dmy', rx: /(?<![\d./])(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})(?!\d|[-/.]\d)/g,
    parse: (m) => ({ a: +m[1], b: +m[3], y: m[4].length === 2 ? 2000 + +m[4] : +m[4], twoDigitYear: m[4].length === 2, sep: m[2] }) },
  // 31 Dec 2027, 31. Dezember 2027, 1st Jan 2028
  { name: 'dMy', maskInvalid: true, rx: new RegExp(`(?<![\\w])(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s*${MW}\\.?,?\\s*['’]?(\\d{4})(?!\\d)`, 'gi'),
    parse: (m) => (monthNumber(m[2]) ? { y: +m[3], m: monthNumber(m[2]), d: +m[1] } : null) },
  // Dec 31, 2027 / December 31st 2027
  { name: 'Mdy', maskInvalid: true, rx: new RegExp(`(?<![\\w])${MW}\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})(?!\\d)`, 'gi'),
    parse: (m) => (monthNumber(m[1]) ? { y: +m[3], m: monthNumber(m[1]), d: +m[2] } : null) },
  // December 2027 / Dec 2027 (month only)
  { name: 'My', rx: new RegExp(`(?<![\\w])${MW}\\.?,?\\s*(\\d{4})(?!\\d)`, 'gi'),
    parse: (m) => (monthNumber(m[1]) ? { y: +m[2], m: monthNumber(m[1]), monthOnly: true } : null) },
  // 12/27, 12/2027, 12-27, 12 / 2027 (month only)
  { name: 'numMy', rx: /(?<![\d./])(\d{1,2})\s?([/.-])\s?(\d{4}|\d{2})(?!\d|[-/.]\d)/g,
    parse: (m) => ({ m: +m[1], y: m[3].length === 2 ? 2000 + +m[3] : +m[3], monthOnly: true, twoDigitYear: m[3].length === 2, sep: m[2], weak: true }) },
];

const pad2 = (n) => String(n).padStart(2, '0');

/** Decide day and month from two numbers "a/b". Returns null if neither can be a month. */
function resolveDayMonth(a, b, sep, dateOrder) {
  if (a > 12 && b <= 12) return { d: a, m: b, ambiguous: false };
  if (b > 12 && a <= 12) return { d: b, m: a, ambiguous: false };
  if (a > 12 && b > 12) return null;
  if (a === b) return { d: a, m: b, ambiguous: false };
  if (sep === '.') return { d: a, m: b, ambiguous: false };   // 03.04.2027 is always day-first
  return dateOrder === 'MDY' ? { m: a, d: b, ambiguous: true } : { d: a, m: b, ambiguous: true };
}

/** y/m/d -> 'YYYY-MM-DD' or null when it is not a real calendar date (or an odd year). */
function toIso(y, m, d) {
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Turn a pattern match into { iso, ambiguous, ... } or null. */
function buildDate(p, dateOrder) {
  let { y, m, d } = p;
  let ambiguous = false;
  if (p.a !== undefined) {
    const r = resolveDayMonth(p.a, p.b, p.sep, dateOrder);
    if (!r) return null;
    ({ d, m, ambiguous } = r);
  }
  if (p.monthOnly) {
    if (m < 1 || m > 12 || y < 2000 || y > 2099) return null;
    d = new Date(y, m, 0).getDate();              // last day of that month
  }
  const iso = toIso(y, m, d);
  if (!iso) return null;
  return { iso, ambiguous, monthOnly: !!p.monthOnly, twoDigitYear: !!p.twoDigitYear, weak: !!p.weak, sep: p.sep };
}

/**
 * Find every plausible date. Returns { candidates, masked } where `masked` is the line list with
 * the date text replaced by '~' so later steps ignore it.
 */
function findDateCandidates(lines, dateOrder) {
  const candidates = [];
  const masked = [];
  lines.forEach((line, idx) => {
    let work = line;
    const found = [];
    for (const pat of DATE_PATTERNS) {
      const round = [];
      for (const m of work.matchAll(pat.rx)) {
        const parsed = pat.parse(m);
        const date = parsed && buildDate(parsed, dateOrder);
        if (date) round.push({ ...date, index: m.index, end: m.index + m[0].length });
        else if (parsed && pat.maskInvalid) round.push({ invalid: true, index: m.index, end: m.index + m[0].length }); // e.g. 30 Feb: still mask it
      }
      for (const f of round) work = work.slice(0, f.index) + '~'.repeat(f.end - f.index) + work.slice(f.end);
      found.push(...round.filter((f) => !f.invalid));
    }
    found.sort((a, b) => a.index - b.index);
    found.forEach((f, k) => {
      // Context = text since the previous date on this line (so "from X until Y" labels work).
      const from = k > 0 ? found[k - 1].end : 0;
      const ctxStart = Math.max(from, f.index - 40);
      const ctx = k === 0 ? contextBefore(lines, idx, f.index, 40) : line.slice(ctxStart, f.index);
      f.label = dateLabelOf(ctx);
      f.timestamp = /^\s*(?:[,@-]\s*)?\d{1,2}:\d{2}/.test(line.slice(f.end));
      f.line = idx;
      candidates.push(f);
    });
    masked.push(work);
  });
  return { candidates, masked };
}

/** Choose the expiry date among the candidates. */
function pickExpiry(candidates) {
  const usable = candidates.filter((c) => {
    if (c.label === 'issue') return false;
    if (c.timestamp && c.label !== 'expiry') return false;                  // receipt time stamp
    if (c.twoDigitYear && !c.monthOnly && c.label !== 'expiry') return false; // "03.04.27" only when labelled
    if (c.weak && c.sep !== '/' && c.label !== 'expiry') return false;      // "12.50" is an amount, not a date
    return true;
  });
  if (!usable.length) return { value: null, confidence: 0 };

  const labelled = usable.filter((c) => c.label === 'expiry');
  const pool = labelled.length ? labelled : usable;
  const best = pool.reduce((a, b) => (b.iso > a.iso ? b : a));              // latest date wins
  const distinct = new Set(pool.map((c) => c.iso)).size;

  let conf;
  if (labelled.length) {
    conf = 0.92;
    if (best.ambiguous) conf -= 0.25;
    if (best.monthOnly || best.twoDigitYear) conf -= 0.05;
    if (distinct > 1) conf -= 0.05;
  } else {
    conf = best.ambiguous || best.weak ? 0.35 : 0.62;
    if (distinct > 1) conf = Math.min(conf, 0.4);
  }
  return { value: best.iso, confidence: pad(clamp(conf, 0.05, 0.95)) };
}

// =============================================================== 3. card number

const CURRENCY_NEARBY_BEFORE = /(?:[€$£₪¥]|\b(?:EUR|USD|GBP|CHF|CAD|AUD|NZD|ILS|NIS|PLN|SEK|NOK|DKK|CZK|JPY))\s*$/i;
const CURRENCY_NEARBY_AFTER = /^\s*(?:[€$£₪¥]|(?:EUR|USD|GBP|CHF|CAD|AUD|NZD|ILS|NIS|PLN|SEK|NOK|DKK|CZK|JPY)\b)/i;

// Labels in front of a card number. STRONG ones are unmistakable; WEAK ones ("No", "Nr") also appear
// in "Order No." so a "NEGATIVE" word before them cancels the label.
const CARD_LABEL_STRONG = /(?<![a-z])(?:(?:gift\s*)?card\s*(?:no|nr|num\w*|number|#|id)?|karten\s*(?:nr|nummer)?|kartennummer|karte|gutschein\w*|serial\s*(?:no|nr|number)?|seriennummer)\.?/gi;
const CARD_LABEL_WEAK = /(?<![a-z])(?:number|nummer|num|nr|no|code)\.?|#/gi;
// Not a card number: PINs, security codes, phone numbers, order/receipt references, tax ids, banking.
const CARD_HARD_NEGATIVE = /(?<![a-z])(?:pin|cvv2?|cvc|security|sicherheit\w*|scratch|rubbel\w*|access)(?![a-z])/gi;
const CARD_NEGATIVE = /(?<![a-z])(?:order|invoice|receipt|ref(?:erence)?|transaction|trans|bon|beleg|rechnung|auftrag|bestell\w*|ticket|terminal|auth\w*|approval|ean|sku|vat|ust|tax|iban|konto|account|customer|kunden\w*|tel\w*|phone|fon|fax|mobile|hotline|call|whatsapp)(?![a-z])/gi;
const PHONE_LINE = /(?<![a-z])(?:tel\w*|phone|fon|fax|mobile|hotline|call|whatsapp|support|service)(?![a-z])/i;

// A run of 8-23 digits, optionally separated by single spaces or dashes.
const DIGIT_RUN = /(?<![\w])\d(?:[ -]?\d){7,22}(?![\w])/g;

/** Luhn checksum - many (not all) real card numbers satisfy it. */
function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = +digits[digits.length - 1 - i];
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/** 8 digits that are really a date (barcode text like 20271231 or 31122027). */
function looksLikeCompactDate(d) {
  if (d.length !== 8) return false;
  return !!(toIso(+d.slice(0, 4), +d.slice(4, 6), +d.slice(6)) ||
    toIso(+d.slice(4), +d.slice(2, 4), +d.slice(0, 2)) ||
    toIso(+d.slice(4), +d.slice(0, 2), +d.slice(2, 4)));
}

/** Purely numeric card numbers, scored. `lines` = date-masked lines. */
function findCardCandidates(lines) {
  const out = [];
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(DIGIT_RUN)) {
      // Cut trailing digit groups until at most 19 digits remain ("... 7890 25" -> "... 7890").
      const groups = [...m[0].matchAll(/\d+/g)].map((g) => ({ text: g[0], end: g.index + g[0].length }));
      let cut = false;
      while (groups.length > 1 && groups.reduce((n, g) => n + g.text.length, 0) > 19) { groups.pop(); cut = true; }
      const digits = groups.map((g) => g.text).join('');
      if (digits.length < 8 || digits.length > 19) continue;
      if (/^(\d)\1+$/.test(digits) || /^0+$/.test(digits)) continue;
      const start = m.index;
      const end = start + groups[groups.length - 1].end;

      const before = line.slice(0, start);
      const after = line.slice(end);
      if (/[+(]\s*$|\(\d{2,4}\)\s*$/.test(before)) continue;                  // +1 800 ..., (555) 123 ...
      if (CURRENCY_NEARBY_BEFORE.test(before) || CURRENCY_NEARBY_AFTER.test(after)) continue; // amount
      if (/^[.,]\d/.test(after)) continue;                                    // 1 234 567,89
      if (looksLikeCompactDate(digits)) continue;

      const ctx = contextBefore(lines, idx, start);
      const strong = labelAdjacent(CARD_LABEL_STRONG, ctx);
      const weak = labelAdjacent(CARD_LABEL_WEAK, ctx);
      const hard = lastMatch(CARD_HARD_NEGATIVE, ctx);
      const neg = lastMatch(CARD_NEGATIVE, ctx);
      const strongIdx = strong ? strong.index : -1;
      if (hard && hard.index > strongIdx) continue;                           // PIN / CVV / scratch code
      const negated = !!neg && neg.index > strongIdx;
      if (!strong && PHONE_LINE.test(line)) continue;                        // phone number line

      let score = digits.length >= 12 ? (digits.length === 16 ? 0.65 : 0.6) : 0.35;
      if (digits.length === 12) score = 0.55;
      if (strong || (weak && !negated)) score += 0.3;
      if (negated) score -= 0.4;
      if (groups.length >= 3 && groups.slice(0, -1).every((g) => g.text.length === 4)) score += 0.05;
      if (digits.length >= 13 && luhnValid(digits)) score += 0.05;
      if (cut) score -= 0.1;
      out.push({ value: digits, score: clamp(score, 0.1, 0.95), line: idx, start, end });
    }
  });
  return out;
}

// E-gift codes: "Code: SFX-9QK2-77LM-0P3A" (labelled) or a bare hyphenated code (unlabelled).
const CODE_LABEL = /(?<![a-z])(?:(?:gift\s*card|card|redemption|redeem|voucher|gutschein|claim|activation|promo)\s*)?(?:code|nummer|number|no|nr|#)\s*[:#=]?\s*/gi;
const CODE_SHAPES = [
  /^[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){1,6}/,          // SFX-9QK2-77LM-0P3A
  /^[A-Z0-9]{4}(?: [A-Z0-9]{4}){2,5}(?![A-Z0-9])/, // 9QK2 77LM 0P3A 1234
  /^[A-Z0-9]{8,24}(?![A-Z0-9])/,                   // 9QK277LM0P3A
];
const CODE_UNLABELLED = /(?<![\w-])[A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6}){2,5}(?![\w-])/;

/** Accept a code only if it has a letter and (a digit or at least 3 hyphen groups). */
function plausibleCode(code) {
  const flat = code.replace(/[- ]/g, '');
  if (flat.length < 8 || flat.length > 32) return false;
  if (!/[A-Z]/.test(flat)) return false;           // pure digits are handled by the digit path
  return /\d/.test(flat) || code.split('-').length >= 3;
}

/** Alphanumeric card/voucher codes from the (un-repaired) lines. */
function findCodeCandidates(rawLines) {
  const out = [];
  rawLines.forEach((line, idx) => {
    if (/https?:|www\./i.test(line)) return;       // links contain token-like strings
    let labelled = false;
    for (const lm of line.matchAll(CODE_LABEL)) {
      const before = line.slice(Math.max(0, lm.index - 12), lm.index);
      if (/(?:pin|cvv|security|access)\s*$/i.test(before)) continue;
      const rest = line.slice(lm.index + lm[0].length);
      for (const shape of CODE_SHAPES) {
        const cm = rest.match(shape);
        if (cm && plausibleCode(cm[0])) {
          out.push({ value: cm[0].replace(/[- ]/g, ''), score: 0.8, line: idx });
          labelled = true;
          break;
        }
      }
      if (labelled) break;
    }
    if (!labelled) {
      const um = line.match(CODE_UNLABELLED);
      if (um && plausibleCode(um[0])) out.push({ value: um[0].replace(/-/g, ''), score: 0.5, line: idx });
    }
  });
  return out;
}

/** Best of digit and alphanumeric candidates (digits win ties). */
function pickCardNumber(digitCands, codeCands) {
  const all = [...digitCands, ...codeCands];
  if (!all.length) return { value: null, confidence: 0, pick: null };
  const best = all.reduce((a, b) => (b.score > a.score ? b : a)); // first wins ties; digits come first
  return { value: best.value, confidence: pad(best.score), pick: best };
}

// =============================================================== 4. amount + currency

// Currency tokens: longer symbols first so "US$" is not read as "$".
const CUR_TOKEN = String.raw`(?:US\$|CA\$|AU\$|NZ\$|C\$|A\$|€|\$|£|₪|¥|\b(?:EUR|USD|GBP|CHF|CAD|AUD|NZD|ILS|NIS|PLN|SEK|NOK|DKK|CZK|JPY)\b|\bEuros?\b)`;
// A number: 1.234,50 | 1,234.50 | 1'234.50 | 25 | 25.5 | 25,00 | optionally "20.-" style suffix.
const NUM = String.raw`(\d{1,3}(?:[.,']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:[.,]-)?`;
const AMOUNT_BEFORE_CUR = new RegExp(`(${CUR_TOKEN})\\s?${NUM}(?!\\d|[.,]\\d)`, 'gi');          // €25  EUR 25.00
const AMOUNT_AFTER_CUR = new RegExp(`(?<![\\d.,])${NUM}\\s?(${CUR_TOKEN})`, 'gi');               // 25,00 €  25 EUR
const BARE_NUMBER = new RegExp(`^[\\s:.=#-]{0,6}${NUM}(?!\\d|[.,]\\d)`);

const AMOUNT_LABEL = /(?<![a-z])(?:value|amount|balance|credit|worth|loaded|load|wert|betrag|guthaben|saldo|aufladung|geschenkwert|gutscheinwert)(?![a-z])/gi;
const AMOUNT_NEGATIVE = /(?<![a-z])(?:total|subtotal|sub-total|tax|vat|mwst|ust|change|cash|tender\w*|paid|payment|pay|r[uü]ckgeld|zwischensumme|summe|discount|rabatt|fee|shipping|versand|min(?:imum)?|ab\s+einem|spend|over)(?![a-z])/gi;

function currencyFromToken(token, fullText) {
  const t = token.toUpperCase().replace(/\s/g, '');
  const table = { '€': 'EUR', EURO: 'EUR', EUROS: 'EUR', '£': 'GBP', '₪': 'ILS', NIS: 'ILS', '¥': 'JPY',
    'US$': 'USD', 'CA$': 'CAD', 'C$': 'CAD', 'AU$': 'AUD', 'A$': 'AUD', 'NZ$': 'NZD' };
  if (table[t]) return table[t];
  if (t === '$') {
    // "$" alone is USD unless the text names another dollar currency.
    const other = fullText.match(/\b(CAD|AUD|NZD)\b/i);
    return other ? other[1].toUpperCase() : 'USD';
  }
  return t;                                         // already an ISO code
}

/** How sure are we about a currency token? */
function tokenConfidence(token, fullText) {
  const t = token.trim();
  if (/^[A-Za-z]{3}$/.test(t)) return 0.92;
  if (t === '$') return /\b(CAD|AUD|NZD)\b/i.test(fullText) ? 0.8 : 0.65;
  return 0.85;
}

/** All amounts found in the (date/card-masked) lines. */
function findAmountCandidates(lines, fullText, defaultCurrency) {
  const out = [];
  lines.forEach((line, idx) => {
    const taken = [];                                         // number spans already used on this line
    const overlaps = (a, b) => taken.some(([s, e]) => a < e && b > s);
    const add = (numText, token, start, end) => {
      if (overlaps(start, end)) return;
      const currency = token ? currencyFromToken(token, fullText) : null;
      const minor = parseAmountInput(numText, currency || defaultCurrency || 'EUR');
      if (minor == null || minor <= 0) return;
      taken.push([start, end]);
      const ctx = contextBefore(lines, idx, start, 28);
      const labelled = !!labelAdjacentOrNear(AMOUNT_LABEL, ctx);
      const negated = !!lastMatch(AMOUNT_NEGATIVE, ctx);
      out.push({ minor, currency, token, labelled, negated, line: idx, start, bare: !token });
    };

    for (const m of line.matchAll(AMOUNT_BEFORE_CUR)) add(m[2], m[1], m.index, m.index + m[0].length);
    for (const m of line.matchAll(AMOUNT_AFTER_CUR)) add(m[1], m[2], m.index, m.index + m[0].length);

    // Bare numbers right after an amount label: "Value: 25.00", "Guthaben 25,00".
    for (const lm of line.matchAll(AMOUNT_LABEL)) {
      const at = lm.index + lm[0].length;
      const bm = line.slice(at).match(BARE_NUMBER);
      if (bm) {
        const numStart = at + bm[0].indexOf(bm[1]);
        if (!isYearLike(bm[1])) add(bm[1], null, numStart, at + bm[0].length);
      }
    }
    // Label alone on the line, number on the next line.
    if (/(?<![a-z])(?:value|amount|balance|credit|wert|betrag|guthaben|saldo)\s*:?$/i.test(line) && lines[idx + 1]) {
      const nm = lines[idx + 1].match(BARE_NUMBER);
      if (nm && !isYearLike(nm[1]) && !out.some((c) => c.line === idx + 1)) {
        out.push({ minor: parseAmountInput(nm[1], defaultCurrency || 'EUR'), currency: null, token: null,
          labelled: true, negated: false, line: idx + 1, start: 0, bare: true });
      }
    }
  });
  return out.filter((c) => c.minor != null && c.minor > 0);
}

/** A label directly in front of the number (allowing a currency word or short filler between). */
function labelAdjacentOrNear(rx, ctx) {
  const m = lastMatch(rx, ctx);
  if (!m) return null;
  const rest = ctx.slice(m.index + m[0].length);
  return rest.length <= 14 ? m : null;
}

/** "2027" - integers that look like years are not amounts when they have no currency. */
function isYearLike(numText) {
  return /^(19|20)\d{2}$/.test(numText);
}

function pickAmount(cands, defaultCurrency) {
  if (!cands.length) return { value: null, confidence: 0, pick: null };
  for (const c of cands) {
    let score = c.bare ? 0.5 : 0.6;
    if (c.labelled) score += 0.3;
    if (c.negated && !c.labelled) score -= 0.3;
    const major = c.minor / 10 ** (c.currency ? decimalsOf(c.currency) : decimalsOf(defaultCurrency || 'EUR'));
    if (major > 10000) score = 0.1;
    c.score = clamp(score, 0.05, 0.92);
  }
  const best = cands.reduce((a, b) => (b.score > a.score ? b : a)); // earliest wins ties
  let conf = best.score;
  const rivals = cands.filter((c) => c !== best && c.minor !== best.minor && c.score >= best.score - 0.15);
  if (rivals.length) conf -= 0.15;
  return { value: best.minor, confidence: pad(clamp(conf, 0.05, 0.92)), pick: best };
}

function decimalsOf(currency) {
  // parseAmountInput already scaled by the right number of digits; mirror it via Intl.
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

/** Currency: from the chosen amount, else a unique currency token elsewhere in the text. */
function pickCurrency(amountPick, text) {
  if (amountPick && amountPick.currency) {
    return { value: amountPick.currency, confidence: pad(tokenConfidence(amountPick.token, text)) };
  }
  const tokens = new Map();
  for (const m of text.matchAll(new RegExp(CUR_TOKEN, 'gi'))) {
    const code = currencyFromToken(m[0], text);
    if (!tokens.has(code)) tokens.set(code, tokenConfidence(m[0], text));
  }
  if (tokens.size === 1) {
    const [code, conf] = [...tokens][0];
    return { value: code, confidence: pad(amountPick ? Math.min(0.5, conf) : Math.min(0.4, conf)) };
  }
  return { value: null, confidence: 0 };
}

// =============================================================== public API

/**
 * Extract gift card fields from raw OCR text.
 * @param {string} text
 * @param {{ dateOrder?: 'DMY'|'MDY', defaultCurrency?: string }} [options]
 * @returns {{cardNumber:string|null, expiryDate:string|null, amount:number|null, currency:string|null,
 *            confidence:{cardNumber:number, expiryDate:number, amount:number, currency:number}}}
 */
export function parseOcrText(text, { dateOrder = 'DMY', defaultCurrency } = {}) {
  const rawLines = normalizeLines(text);
  const lines = rawLines.map(fixDigitConfusions);
  const fullText = lines.join('\n');

  // Dates first; their text is masked out of the lines used by the other steps.
  const { candidates: dateCands, masked: dateMasked } = findDateCandidates(lines, dateOrder);
  const expiry = pickExpiry(dateCands);

  const card = pickCardNumber(findCardCandidates(dateMasked), findCodeCandidates(rawLines));

  // Mask the chosen card number so its digits are not read as an amount.
  const amountLines = dateMasked.slice();
  if (card.pick && card.pick.start !== undefined) {
    const { line, start, end } = card.pick;
    amountLines[line] = amountLines[line].slice(0, start) + '~'.repeat(end - start) + amountLines[line].slice(end);
  }
  const amount = pickAmount(findAmountCandidates(amountLines, fullText, defaultCurrency), defaultCurrency);
  const currency = pickCurrency(amount.pick, fullText);

  return {
    cardNumber: card.value,
    expiryDate: expiry.value,
    amount: amount.value,
    currency: currency.value,
    confidence: {
      cardNumber: card.value ? card.confidence : 0,
      expiryDate: expiry.value ? expiry.confidence : 0,
      amount: amount.value != null ? amount.confidence : 0,
      currency: currency.value ? currency.confidence : 0,
    },
  };
}
