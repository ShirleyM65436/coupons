// views/ocrStep.js - last step of the scan flow (not a route; scan.js calls runOcrStep()).
// Contract: ARCHITECTURE.md sections 6 and 7.
//
//   photo?  -> progress screen -> recognizeText -> parseOcrText -> merge with barcode
//           -> setDraft(...) -> navigate('#/add')
//   no photo -> setDraft(barcode only) -> navigate('#/add')
//
// Safety rules:
//  - Every call is a "run". Skip, leaving #/scan, or starting a new run ends the old one; a late
//    OCR result of an ended run is ignored and never navigates.
//  - We only navigate when the user is still on #/scan.
//  - The big Tesseract worker is terminated when the step is over (success, skip or failure).

import { el } from '../ui.js';
import { toast, navigate } from '../ui.js';
import { setDraft } from '../draft.js';
import { recognizeText, terminateOcr } from '../services/ocr.js';
import { parseOcrText } from '../services/ocrParser.js';

let currentRun = null; // the run in progress, so a new run can end it

/** en-US reads 03/04/2027 as March 4th; everyone else as April 3rd. */
function guessDateOrder() {
  return String(navigator.language || '').toLowerCase() === 'en-us' ? 'MDY' : 'DMY';
}

const onScanPage = () => location.hash === '#/scan' || location.hash.startsWith('#/scan?');

/** Draft fields that come from the barcode (they always win over OCR for the card number). */
function barcodeFields(barcode) {
  if (!barcode) return { card: {}, confidence: {} };
  return {
    card: { cardNumber: barcode.value, barcodeValue: barcode.value, barcodeFormat: barcode.format },
    confidence: { cardNumber: 1 },
  };
}

/** Turn the parser result into GiftCard-named fields + confidences (only for fields found). */
function ocrFields(parsed) {
  const card = {};
  const confidence = {};
  const put = (field, value, conf) => {
    if (value === null || value === undefined) return;
    card[field] = value;
    confidence[field] = conf;
  };
  put('cardNumber', parsed.cardNumber, parsed.confidence.cardNumber);
  put('expiryDate', parsed.expiryDate, parsed.confidence.expiryDate);
  put('originalAmount', parsed.amount, parsed.confidence.amount);
  put('currency', parsed.currency, parsed.confidence.currency);
  return { card, confidence };
}

/**
 * Final step of the scan flow: (optionally) OCR the photo, merge with the barcode,
 * store a draft and open the editable Add form (#/add).
 * @param {HTMLElement} container  the scan view's container; this step replaces its content
 * @param {{ barcode: {value:string, format:string}|null, photoBlob: Blob|null }} input
 * @returns {Promise<void>}
 */
export async function runOcrStep(container, { barcode, photoBlob }) {
  currentRun?.end('superseded');

  // Hand the draft to the Add form - only if the user is still in the scan flow.
  const finish = (run, { card = {}, confidence = {}, ocrText = '' } = {}) => {
    if (run.state === 'ended' || !onScanPage()) return;
    run.state = 'ended';
    setDraft({ card, photoBlob: photoBlob || null, confidence, ocrText });
    navigate('#/add');
  };

  const base = barcodeFields(barcode);

  // 1. No photo: nothing to read.
  if (!photoBlob) {
    const run = { state: 'active', end() { this.state = 'ended'; } };
    finish(run, base);
    return;
  }

  // 2. Progress screen.
  const thumbUrl = URL.createObjectURL(photoBlob);
  const bar = el('div', { class: 'progress-bar' });
  bar.style.width = '0%';
  const statusText = el('p', { class: 'muted', role: 'status' }, 'Loading text recognition…');
  const skipBtn = el('button', { class: 'btn btn-block', type: 'button' }, 'Skip text recognition');
  const thumb = el('img', { alt: 'Your card photo', src: thumbUrl });
  thumb.style.cssText = 'max-width:160px;max-height:120px;border-radius:var(--radius);object-fit:cover;';
  container.replaceChildren(el('div', { class: 'empty-state stack' },
    el('h2', {}, 'Reading your card…'),
    thumb,
    el('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Text recognition progress' }, bar),
    statusText,
    skipBtn,
  ));

  // A run can be cancelled by Skip (still goes on to #/add) or ended by leaving/superseding (silent).
  let wake;
  const woken = new Promise((resolve) => { wake = resolve; });
  const run = {
    state: 'active', // 'active' | 'skipped' | 'ended'
    end(reason) { if (this.state === 'active') { this.state = reason === 'skip' ? 'skipped' : 'ended'; wake(); } },
  };
  currentRun = run;
  skipBtn.addEventListener('click', () => { skipBtn.disabled = true; run.end('skip'); });
  const onHashChange = () => { if (!onScanPage()) run.end('left'); };
  window.addEventListener('hashchange', onHashChange);

  try {
    const ocr = recognizeText(photoBlob, {
      onProgress: (fraction, status) => {
        if (run.state !== 'active') return;
        bar.style.width = Math.round(Math.min(1, Math.max(0, fraction)) * 100) + '%';
        if (status) statusText.textContent = status;
      },
    });
    ocr.catch(() => {}); // a result arriving after Skip must not raise "unhandled rejection"

    const outcome = await Promise.race([ocr.then((r) => ({ result: r }), (error) => ({ error })), woken.then(() => ({ cancelled: true }))]);

    if (outcome.cancelled) {
      if (run.state === 'skipped') { run.state = 'active'; finish(run, base); }
      return;
    }
    if (outcome.error) {
      console.warn('Text recognition failed', outcome.error);
      toast('Text recognition failed – please fill in the details', 'error');
      finish(run, base);
      return;
    }

    // 3. Parse and merge. The barcode (confidence 1) wins over an OCR card number.
    const text = outcome.result.text || '';
    const parsed = parseOcrText(text, { dateOrder: guessDateOrder() });
    const fromOcr = ocrFields(parsed);
    finish(run, {
      card: { ...fromOcr.card, ...base.card },
      confidence: { ...fromOcr.confidence, ...base.confidence },
      ocrText: text,
    });
  } finally {
    window.removeEventListener('hashchange', onHashChange);
    URL.revokeObjectURL(thumbUrl);
    if (currentRun === run) currentRun = null;
    run.state = 'ended';
    // Free the big worker; the next scan creates it again.
    terminateOcr().catch(() => {});
  }
}
