// Copies the runtime library files the app needs from node_modules into /vendor,
// so the app works offline and never loads anything from a CDN.
//
// Run after `npm install` (or after upgrading a library):  npm run vendor
// The /vendor folder IS committed to git, because GitHub Pages serves it as-is.

import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => join(root, 'node_modules', p);
const out = (p) => join(root, 'vendor', p);

// [source in node_modules, destination in vendor]
const FILES = [
  // Tesseract.js: ES module build + its web worker script
  ['tesseract.js/dist/tesseract.esm.min.js', 'tesseract/tesseract.esm.min.js'],
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['tesseract.js/LICENSE.md', 'tesseract/LICENSE.md'],
  // Tesseract wasm core. Tesseract picks one of these at runtime depending on
  // the browser's SIMD support. We only use the LSTM engine (oem = 1), so only
  // the "-lstm" variants are needed. The .wasm.js files embed the wasm binary.
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['tesseract.js-core/LICENSE', 'tesseract-core/LICENSE'],
  // English language data ("best_int": good accuracy, small and fast)
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tessdata/eng.traineddata.gz'],
  // ZXing barcode reader (fallback when the native BarcodeDetector is missing).
  // UMD build, defines window.ZXingBrowser.
  ['@zxing/browser/umd/zxing-browser.min.js', 'zxing/zxing-browser.min.js'],
  ['@zxing/browser/LICENSE', 'zxing/LICENSE'],
  // JsBarcode (1D barcode rendering). UMD build, defines window.JsBarcode.
  ['jsbarcode/dist/JsBarcode.all.min.js', 'jsbarcode/JsBarcode.all.min.js'],
  ['jsbarcode/MIT-LICENSE.txt', 'jsbarcode/LICENSE.txt'],
  // QR code generator, ES module build (default export: qrcode()).
  // (MIT; the license text is in the header comment of the file itself.)
  ['qrcode-generator/dist/qrcode.mjs', 'qrcode/qrcode.mjs'],
];

rmSync(join(root, 'vendor'), { recursive: true, force: true });
let missing = 0;
for (const [src, dest] of FILES) {
  if (!existsSync(nm(src))) {
    // License files have varying names between versions; warn but continue.
    console.warn('MISSING:', src);
    missing++;
    continue;
  }
  mkdirSync(dirname(out(dest)), { recursive: true });
  cpSync(nm(src), out(dest));
  console.log('copied', dest);
}
if (missing) console.warn(`${missing} file(s) missing - check the paths above.`);
