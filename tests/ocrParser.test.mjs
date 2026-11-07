// Unit tests for js/services/ocrParser.js (run with `npm test`).
// Part 1: realistic, noisy OCR samples - every sample asserts all four fields.
// Part 2: focused edge cases (date order, 2-digit years, impossible dates, amount formats, phones...).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOcrText } from '../js/services/ocrParser.js';

/** Assert the four extracted fields (null = must not be found). */
function expectFields(text, expected, options) {
  const r = parseOcrText(text, options);
  assert.deepStrictEqual(
    { cardNumber: r.cardNumber, expiryDate: r.expiryDate, amount: r.amount, currency: r.currency },
    expected,
    'parsed fields differ for:\n' + text,
  );
  // Confidence is 0 exactly for the null fields and within 0..1 otherwise.
  for (const key of Object.keys(expected)) {
    const c = r.confidence[key];
    if (expected[key] === null) assert.equal(c, 0, `confidence.${key} must be 0 when null`);
    else assert.ok(c > 0 && c <= 1, `confidence.${key} must be in (0,1], got ${c}`);
  }
  return r;
}

// ------------------------------------------------------------------ realistic samples

const SAMPLES = [
  {
    name: '01 clean physical card (EUR, MM/YYYY)',
    text: `GIFT CARD
Card No 6035 7712 3456 7890
Valid thru 12/2027
Value €25.00`,
    expected: { cardNumber: '6035771234567890', expiryDate: '2027-12-31', amount: 2500, currency: 'EUR' },
  },
  {
    name: '02 noisy: O/0 and l/1 confusions, stray characters',
    text: `~~ G1FT  CARD ~~
Card No: 6O35 77l2 3456 789O  |
EXP 12/2O27
Wert: 25,OO EUR
*** thank you ***`,
    expected: { cardNumber: '6035771234567890', expiryDate: '2027-12-31', amount: 2500, currency: 'EUR' },
  },
  {
    name: '03 German card with dashes, DD.MM.YYYY and trailing euro sign',
    text: `Geschenkkarte
Kartennummer: 4012-8888-8888-1881
Gültig bis: 31.12.2027
Guthaben: 50,00 €`,
    expected: { cardNumber: '4012888888881881', expiryDate: '2027-12-31', amount: 5000, currency: 'EUR' },
  },
  {
    name: '04 US receipt with order number, phone, tax and total',
    text: `MEGAMART #0042
Date: 11/05/2026 14:32
Order No. 8841 2290 1137 0051
Gift Card Load
Gift Card No. 6035 7712 3456 7890
Amount $50.00
Tax $0.00
Total $50.00
Card expires 06/28
Customer service +1 800 555 0199`,
    options: { dateOrder: 'MDY' },
    expected: { cardNumber: '6035771234567890', expiryDate: '2028-06-30', amount: 5000, currency: 'USD' },
  },
  {
    name: '05 e-gift card e-mail with code and link',
    text: `Hi Anna, you received a gift!
Your Gift Card from SFX Store
Amount: $100.00 USD
Gift card code: SFX-9QK2-77LM-0P3A
Redeem at https://sfx.example.com/redeem?c=SFX9QK277LM0P3A
Expires: December 31, 2028`,
    expected: { cardNumber: 'SFX9QK277LM0P3A', expiryDate: '2028-12-31', amount: 10000, currency: 'USD' },
  },
  {
    name: '06 card with only a number, no date, no value',
    text: `Gift Card
6035 7712 3456 7890
Thank you for shopping with us`,
    expected: { cardNumber: '6035771234567890', expiryDate: null, amount: null, currency: null },
  },
  {
    name: '07 UK voucher with "Use by" and day-month-name date',
    text: `GIFT VOUCHER £10
Card Number: 8277 0041 5530 9912
Use by 31 Dec 2027`,
    expected: { cardNumber: '8277004155309912', expiryDate: '2027-12-31', amount: 1000, currency: 'GBP' },
  },
  {
    name: '08 issued date must be ignored, expiry used',
    text: `Issued 01/2025
Expires 12/2027
Card 5412345678901234
Balance £75.00`,
    expected: { cardNumber: '5412345678901234', expiryDate: '2027-12-31', amount: 7500, currency: 'GBP' },
  },
  {
    name: '09 German noisy: Ablaufdatum with O, amount with trailing ",-"',
    text: `Gutschein
Nr. 7021 5538 9006 1127
Ablaufdatum 31.12.2O27
Wert 100,- EUR`,
    expected: { cardNumber: '7021553890061127', expiryDate: '2027-12-31', amount: 10000, currency: 'EUR' },
  },
  {
    name: '10 Swiss card: CHF 20.- and month.year',
    text: `Geschenkkarte CHF 20.-
Nr. 7601 2345 6789 0123
Gültig bis 12.2028`,
    expected: { cardNumber: '7601234567890123', expiryDate: '2028-12-31', amount: 2000, currency: 'CHF' },
  },
  {
    name: '11 shekel card with ISO date',
    text: `Gift Card ₪100
Card No: 1234-5678-9012-3456
Expiry: 2027-06-30`,
    expected: { cardNumber: '1234567890123456', expiryDate: '2027-06-30', amount: 10000, currency: 'ILS' },
  },
  {
    name: '12 US ambiguous date resolved with MDY',
    text: `HOLIDAY GIFT CARD
Exp. Date 03/04/2027
Card # 6010 1234 5678 9012
$25`,
    options: { dateOrder: 'MDY' },
    expected: { cardNumber: '6010123456789012', expiryDate: '2027-03-04', amount: 2500, currency: 'USD' },
  },
  {
    name: '13 same text with DMY gives the other reading',
    text: `HOLIDAY GIFT CARD
Exp. Date 03/04/2027
Card # 6010 1234 5678 9012
$25`,
    expected: { cardNumber: '6010123456789012', expiryDate: '2027-04-03', amount: 2500, currency: 'USD' },
  },
  {
    name: '14 label on the line above the value',
    text: `Card number
6035 7712 3456 7890
Expiry date
12/27
Balance
$25.00`,
    expected: { cardNumber: '6035771234567890', expiryDate: '2027-12-31', amount: 2500, currency: 'USD' },
  },
  {
    name: '15 unlabelled dates: pick the latest, ignore receipt timestamp',
    text: `Thanks for your purchase
15.01.2026 10:42
Gift card 6035-7712-3456-7890
valid until
15.01.2028
EUR 30.00`,
    expected: { cardNumber: '6035771234567890', expiryDate: '2028-01-15', amount: 3000, currency: 'EUR' },
  },
  {
    name: '16 broken spacing in the number, amount with space before euro',
    text: `Karte Nr 6035 77 12 3456 7890
gültig bis 06/2026
25 , 00 €`,
    // "25 , 00" is too broken to read; number and date still work, amount stays unknown.
    expected: { cardNumber: '6035771234567890', expiryDate: '2026-06-30', amount: null, currency: 'EUR' },
  },
  {
    name: '17 barcode digits equal to a date must not become the card number',
    text: `GIFT CARD
20271231
Card No 6035 7712 3456 7890
Valid thru 12/27
EUR 15.00`,
    expected: { cardNumber: '6035771234567890', expiryDate: '2027-12-31', amount: 1500, currency: 'EUR' },
  },
  {
    name: '18 PIN and scratch code are not the card number',
    text: `Scratch to reveal PIN
PIN 4821 9937
Card No. 6035 7712 3456 7890
Exp 01/28
Value $75.00`,
    expected: { cardNumber: '6035771234567890', expiryDate: '2028-01-31', amount: 7500, currency: 'USD' },
  },
  {
    name: '19 grocery receipt that sells a gift card (many numbers)',
    text: `SUPERMARKT MUELLER
Tel. 089 123 456 78
04.11.2026 18:07 Bon 0123
Brot 2,49
Milch 1,19
Geschenkkarte 6035 7712 3456 7890
Aufladung 25,00 EUR
Zwischensumme 28,68
Summe 28,68 EUR
Gegeben 30,00 Rückgeld 1,32`,
    expected: { cardNumber: '6035771234567890', expiryDate: null, amount: 2500, currency: 'EUR' },
  },
  {
    name: '20 shouting e-gift code in the middle of a marketing e-mail',
    text: `YOUR 50 CAD GIFT CARD IS HERE!
Claim code: 4PQ7-LM29-XK31
Value: $50.00
Good through March 5, 2029
Questions? Call 1-888-555-0100`,
    expected: { cardNumber: '4PQ7LM29XK31', expiryDate: '2029-03-05', amount: 5000, currency: 'CAD' },
  },
];

for (const s of SAMPLES) {
  test(`sample ${s.name}`, () => {
    expectFields(s.text, s.expected, s.options);
  });
}

test('there are at least 15 realistic samples', () => {
  assert.ok(SAMPLES.length >= 15);
});

// ------------------------------------------------------------------ confidence

test('confidence: labelled clean fields are high, unlabelled lower, ambiguous low', () => {
  const clean = parseOcrText('Card No 6035 7712 3456 7890\nValid thru 12/2027\nValue €25.00');
  assert.ok(clean.confidence.cardNumber >= 0.85);
  assert.ok(clean.confidence.expiryDate >= 0.85);
  assert.ok(clean.confidence.amount >= 0.85);
  assert.ok(clean.confidence.currency >= 0.8);

  const bare = parseOcrText('6035 7712 3456 7890\n12/2027\n€25');
  assert.ok(bare.confidence.cardNumber < clean.confidence.cardNumber);
  assert.ok(bare.confidence.expiryDate <= 0.4);
  assert.ok(bare.confidence.amount < clean.confidence.amount);

  const ambiguous = parseOcrText('Exp 03/04/2027');
  assert.ok(ambiguous.confidence.expiryDate < 0.7);
  const certain = parseOcrText('Exp 13/04/2027');
  assert.ok(certain.confidence.expiryDate >= 0.85);
});

test('empty and junk input return nulls with zero confidence', () => {
  for (const t of ['', '   \n  ', null, undefined, 'hello world', '!!! ??? ---']) {
    const r = parseOcrText(t);
    assert.deepStrictEqual(
      [r.cardNumber, r.expiryDate, r.amount, r.currency],
      [null, null, null, null],
    );
    assert.deepStrictEqual(r.confidence, { cardNumber: 0, expiryDate: 0, amount: 0, currency: 0 });
  }
});

// ------------------------------------------------------------------ dates

test('dates: ambiguous 03/04/2027 follows dateOrder, unambiguous ignores it', () => {
  assert.equal(parseOcrText('Exp 03/04/2027', { dateOrder: 'DMY' }).expiryDate, '2027-04-03');
  assert.equal(parseOcrText('Exp 03/04/2027', { dateOrder: 'MDY' }).expiryDate, '2027-03-04');
  assert.equal(parseOcrText('Exp 13/04/2027', { dateOrder: 'MDY' }).expiryDate, '2027-04-13');
  assert.equal(parseOcrText('Exp 04/13/2027', { dateOrder: 'DMY' }).expiryDate, '2027-04-13');
  assert.equal(parseOcrText('Exp 05/05/2027', { dateOrder: 'MDY' }).expiryDate, '2027-05-05');
  // dots are always day-first
  assert.equal(parseOcrText('Exp 03.04.2027', { dateOrder: 'MDY' }).expiryDate, '2027-04-03');
});

test('dates: two-digit years become 20YY', () => {
  assert.equal(parseOcrText('Valid thru 09/27').expiryDate, '2027-09-30');
  assert.equal(parseOcrText('EXP 31/12/27').expiryDate, '2027-12-31');
  assert.equal(parseOcrText('Exp: 05-29').expiryDate, '2029-05-31');
});

test('dates: month-only means last day of month (leap years included)', () => {
  assert.equal(parseOcrText('Expires 02/2028').expiryDate, '2028-02-29');
  assert.equal(parseOcrText('Expires 02/2027').expiryDate, '2027-02-28');
  assert.equal(parseOcrText('Expires December 2027').expiryDate, '2027-12-31');
  assert.equal(parseOcrText('Gültig bis Februar 2029').expiryDate, '2029-02-28');
  assert.equal(parseOcrText('Expiry Sep 2026').expiryDate, '2026-09-30');
});

test('dates: written month names in English and German', () => {
  assert.equal(parseOcrText('Dec 31, 2027').expiryDate, '2027-12-31');
  assert.equal(parseOcrText('Expires 31 Dec 2027').expiryDate, '2027-12-31');
  assert.equal(parseOcrText('Valid until January 5th, 2028').expiryDate, '2028-01-05');
  assert.equal(parseOcrText('Gültig bis 31. Dezember 2027').expiryDate, '2027-12-31');
  assert.equal(parseOcrText('MHD 15 Okt 2027').expiryDate, '2027-10-15');
  assert.equal(parseOcrText('Ablaufdatum 3. März 2028').expiryDate, '2028-03-03');
});

test('dates: impossible dates are rejected', () => {
  for (const t of ['Exp 31/02/2027', 'Exp 2027-13-40', 'Exp 00/2027', 'Exp 13/2027', 'Exp 45/45/2027', 'Exp 30 Feb 2027']) {
    assert.equal(parseOcrText(t).expiryDate, null, t);
  }
});

test('dates: issue / purchase dates are never used as expiry', () => {
  assert.equal(parseOcrText('Date of issue 01/06/2025').expiryDate, null);
  assert.equal(parseOcrText('Purchased 05.03.2026').expiryDate, null);
  assert.equal(parseOcrText('Valid from 01/01/2026 until 31/12/2027').expiryDate, '2027-12-31');
  assert.equal(parseOcrText('Ausgestellt am 01.02.2026\nGültig bis 01.02.2029').expiryDate, '2029-02-01');
});

test('dates: label beats position, latest wins when unlabelled', () => {
  assert.equal(parseOcrText('Exp 01/2026\n05/05/2029').expiryDate, '2026-01-31');
  assert.equal(parseOcrText('10.01.2026\n10.01.2029\n10.01.2027').expiryDate, '2029-01-10');
});

test('dates: amounts and "24/7" are not dates', () => {
  assert.equal(parseOcrText('Value 12.50 EUR').expiryDate, null);
  assert.equal(parseOcrText('Service 24/7').expiryDate, null);
});

// ------------------------------------------------------------------ card numbers

test('card: phone numbers are never picked', () => {
  assert.equal(parseOcrText('Call us: +1 800 555 0199').cardNumber, null);
  assert.equal(parseOcrText('Hotline 0800 123 456 789').cardNumber, null);
  assert.equal(parseOcrText('Tel: +49 30 1234 5678').cardNumber, null);
  assert.equal(parseOcrText('(555) 123-45678 90').cardNumber, null);
});

test('card: amounts and dates are not card numbers', () => {
  assert.equal(parseOcrText('Total EUR 1 234 567 89').cardNumber, null);
  assert.equal(parseOcrText('Valid 2027-12-31').cardNumber, null);
  assert.equal(parseOcrText('20271231').cardNumber, null);
  assert.equal(parseOcrText('31122027').cardNumber, null);
});

test('card: 8-11 digits accepted with low confidence, 12-19 preferred', () => {
  const short = parseOcrText('12345678901');
  assert.equal(short.cardNumber, '12345678901');
  assert.ok(short.confidence.cardNumber <= 0.4);
  const r = parseOcrText('12345678901\nCard No 6035 7712 3456 7890');
  assert.equal(r.cardNumber, '6035771234567890');
  assert.equal(parseOcrText('1234567').cardNumber, null);       // too short
  // 24 digits: trailing groups are cut off, with lower confidence than a clean 16-digit number
  const long = parseOcrText('1234 5678 9012 3456 7890 1234');
  assert.equal(long.cardNumber, '1234567890123456');
  assert.ok(long.confidence.cardNumber < parseOcrText('1234 5678 9012 3456').confidence.cardNumber);
});

test('card: separators (spaces, dashes) are removed; 15-digit Amex style works', () => {
  assert.equal(parseOcrText('3782 822463 10005').cardNumber, '378282246310005');
  assert.equal(parseOcrText('Card 6035-7712-3456-7890').cardNumber, '6035771234567890');
});

test('card: alphanumeric codes need a label for high confidence', () => {
  const labelled = parseOcrText('Card code: AB12-CD34-EF56');
  assert.equal(labelled.cardNumber, 'AB12CD34EF56');
  const bare = parseOcrText('AB12-CD34-EF56');
  assert.equal(bare.cardNumber, 'AB12CD34EF56');
  assert.ok(bare.confidence.cardNumber < labelled.confidence.cardNumber);
  assert.equal(parseOcrText('Visit https://x.example/AB12-CD34-EF56').cardNumber, null);
});

// ------------------------------------------------------------------ amounts and currency

test('amount: symbol and code formats', () => {
  const cases = [
    ['€25', 2500, 'EUR'],
    ['25,00 €', 2500, 'EUR'],
    ['EUR 25.00', 2500, 'EUR'],
    ['25.00 EUR', 2500, 'EUR'],
    ['$50.00', 5000, 'USD'],
    ['USD 100', 10000, 'USD'],
    ['£10', 1000, 'GBP'],
    ['CHF 20.-', 2000, 'CHF'],
    ['₪100', 10000, 'ILS'],
    ['JPY 5000', 5000, 'JPY'],
    ['€ 12,5', 1250, 'EUR'],
  ];
  for (const [text, amount, currency] of cases) {
    const r = parseOcrText(text);
    assert.equal(r.amount, amount, text);
    assert.equal(r.currency, currency, text);
  }
});

test('amount: thousands and decimal separators follow model.js rules', () => {
  assert.equal(parseOcrText('Wert 1.234,50 €').amount, 123450);
  assert.equal(parseOcrText('Value $1,234.50').amount, 123450);
  assert.equal(parseOcrText('Value 1.234 EUR').amount, 123400);
  assert.equal(parseOcrText("CHF 1'000.00").amount, 100000);
});

test('amount: dollar sign is USD unless another dollar currency is named', () => {
  assert.equal(parseOcrText('$50').currency, 'USD');
  assert.equal(parseOcrText('$50 CAD').currency, 'CAD');
  assert.equal(parseOcrText('AUD 50').currency, 'AUD');
  assert.equal(parseOcrText('A$50').currency, 'AUD');
  assert.equal(parseOcrText('US$50').currency, 'USD');
});

test('amount: labelled amount beats other amounts on the page', () => {
  const t = 'Minimum purchase $100\nValue $25.00\nShipping $5.00';
  assert.equal(parseOcrText(t).amount, 2500);
  assert.equal(parseOcrText('Subtotal €48,00\nGuthaben €20,00').amount, 2000);
});

test('amount: no currency in text -> currency null, defaultCurrency only scales minor units', () => {
  const r = parseOcrText('Value: 25.00');
  assert.equal(r.amount, 2500);
  assert.equal(r.currency, null);
  assert.equal(r.confidence.currency, 0);
  assert.equal(parseOcrText('Value: 2500', { defaultCurrency: 'JPY' }).amount, 2500);
  assert.equal(parseOcrText('Value: 25', { defaultCurrency: 'EUR' }).amount, 2500);
});

test('amount: card numbers, years and implausible values are not amounts', () => {
  assert.equal(parseOcrText('6035 7712 3456 7890').amount, null);
  assert.equal(parseOcrText('Value 2027').amount, null);
  assert.equal(parseOcrText('Valid thru 12/2027').amount, null);
  const big = parseOcrText('€ 50000');
  assert.ok(big.amount === null || big.confidence.amount <= 0.1);
  // a sane amount next to it wins over the implausible one
  assert.equal(parseOcrText('€ 50000\n€ 50').amount, 5000);
});

test('amount: lower-case code and stray spacing', () => {
  assert.equal(parseOcrText('value eur 25.00').amount, 2500);
  assert.equal(parseOcrText('Betrag:  25,00  EUR').amount, 2500);
});
