// draft.js - hands scan/OCR results to the Add form (#/add).
//
// Flow: Scan view -> OCR step -> setDraft(...) -> navigate('#/add')
//       -> Add view reads getDraft() and pre-fills the form
//       -> Add view calls clearDraft() after Save or Cancel.
//
// Kept in memory only (a page reload loses it, which is fine).

/**
 * @typedef {object} Draft
 * @property {object} card          Partial GiftCard (amounts in minor units), e.g.
 *                                  { cardNumber, barcodeValue, barcodeFormat, expiryDate, originalAmount, currency }
 * @property {Blob|null} [photoBlob] downscaled JPEG to store with the card on save
 * @property {Record<string, number>} [confidence] 0..1 per field name; fields below 0.6
 *                                  are highlighted in the form as "please check"
 * @property {string} [ocrText]     raw OCR text (shown to the user for reference)
 */

let current = null;

/** Store a draft for the Add form. Replaces any previous draft. */
export function setDraft(draft) {
  current = { card: {}, photoBlob: null, confidence: {}, ocrText: '', ...draft };
}

/** The pending draft, or null. Does not clear it. */
export function getDraft() {
  return current;
}

/** Forget the pending draft. */
export function clearDraft() {
  current = null;
}
