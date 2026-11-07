// services/ocr.js - Tesseract.js (v7) wrapper. Fully self-hosted: every file comes from /vendor,
// so OCR works offline (the service worker precaches those files).
// Contract: ARCHITECTURE.md section 6 ("services/ocr.js").
//
// - ONE worker is created lazily and reused by all calls (creating it loads ~10 MB of wasm +
//   language data, so it is slow the first time and fast afterwards).
// - Calls are queued: a second recognizeText() waits for the first to finish.
// - Tesseract reports progress per phase; we merge the phases into one monotonic 0..1 value.

import Tesseract from '../../vendor/tesseract/tesseract.esm.min.js';

/** Absolute URL of a file/folder in /vendor (works from a GitHub Pages sub-folder too). */
const vendorUrl = (path) => new URL(path, document.baseURI).href;

/** OEM 1 = LSTM only. Only the *-lstm.wasm.js cores are vendored, so this must stay 1. */
const OEM_LSTM_ONLY = 1;

/**
 * Share of the overall progress bar taken by each phase while the worker is being created.
 * (Order matters: the phases run one after another.)
 */
const PHASES = [
  { key: 'core', match: /core/, weight: 0.10, label: 'Loading text recognition…' },
  { key: 'lang', match: /language|traineddata/, weight: 0.30, label: 'Loading text recognition…' },
  { key: 'init', match: /initializ/, weight: 0.10, label: 'Preparing…' },
  { key: 'read', match: /recogniz/, weight: 0.50, label: 'Reading text…' },
];

let worker = null;            // the shared Tesseract worker (once created)
let workerPromise = null;     // creation in flight (or finished)
let queue = Promise.resolve(); // serialises recognizeText() calls
let report = null;            // progress callback of the call that is running right now

/** Tesseract logger: forwards { status, progress } to the running call's `report`. */
function logger(msg) {
  if (report && msg && typeof msg.status === 'string') report(msg.status, msg.progress || 0);
}

/** Create the worker once. Resets itself on failure so the next call can retry. */
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', OEM_LSTM_ONLY, {
      workerPath: vendorUrl('vendor/tesseract/worker.min.js'),
      corePath: vendorUrl('vendor/tesseract-core/'),   // directory: Tesseract picks the right *-lstm variant
      langPath: vendorUrl('vendor/tessdata/'),         // contains eng.traineddata.gz
      workerBlobURL: false,  // load worker.min.js as a real same-origin file (cacheable by our service worker)
      gzip: true,            // default; our language file is .traineddata.gz
      cacheMethod: 'none',   // don't copy the 10 MB language file into IndexedDB: the service worker
                             // already caches it, and one cache is easier to reason about / clear
      logger,
    }).then((w) => { worker = w; return w; }, (err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

/**
 * Recognize text in an image.
 * @param {Blob} imageBlob
 * @param {{ onProgress?: (fraction: number, status: string) => void, psm?: string }} [opts]
 *        psm: optional Tesseract page-segmentation mode (default: Tesseract's AUTO)
 * @returns {Promise<{ text: string, confidence: number }>} confidence 0..100
 */
export function recognizeText(imageBlob, { onProgress, psm } = {}) {
  const run = queue.then(() => recognizeNow(imageBlob, onProgress, psm));
  queue = run.catch(() => {});   // a failed call must not block the queue
  return run;
}

async function recognizeNow(imageBlob, onProgress, psm) {
  const hadWorker = !!worker;
  let last = 0;
  const emit = (fraction, status) => {
    const f = Math.min(1, Math.max(last, fraction)); // never go backwards
    if (f > last || status !== emit.status) { last = f; emit.status = status; onProgress?.(f, status); }
  };
  emit.status = '';
  // Progress per phase: weights are used only while the worker is still being created; with a
  // warm worker the whole bar belongs to "Reading text…".
  report = (status, progress) => {
    const idx = PHASES.findIndex((p) => p.match.test(status));
    if (idx < 0) return;
    const isReading = idx === PHASES.length - 1;
    if (hadWorker) {
      if (isReading) emit(Math.min(0.999, progress), PHASES[idx].label);
    } else {
      const before = PHASES.slice(0, idx).reduce((s, p) => s + p.weight, 0);
      emit(Math.min(0.999, before + PHASES[idx].weight * progress), PHASES[idx].label);
    }
  };

  try {
    emit(0, PHASES[0].label);
    const w = await getWorker();
    // Mode 3 (AUTO) is Tesseract's default. Callers may ask for another one.
    // user_defined_dpi: camera photos carry no DPI; without it Tesseract prints "Estimating resolution"
    // to the console (an error entry in tests). 300 is the size it is tuned for.
    await w.setParameters({ tessedit_pageseg_mode: psm || Tesseract.PSM.AUTO, user_defined_dpi: '300' });
    const { data } = await w.recognize(imageBlob);
    emit(1, 'Done');
    return { text: data.text || '', confidence: data.confidence || 0 };
  } finally {
    report = null;
  }
}

/** Free the Tesseract worker (call when leaving the scan flow). Safe to call anytime. */
export async function terminateOcr() {
  const pending = workerPromise;
  worker = null;
  workerPromise = null;
  if (!pending) return;
  try {
    const w = await pending;
    await w.terminate();
  } catch {
    // creation had failed - nothing to free
  }
}
