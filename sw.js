// sw.js - service worker: makes the app work fully offline.
//
// =====================================================================================
//  MAINTAINER: BUMP CACHE_VERSION ON EVERY DEPLOY.
//  Browsers only install a new worker (and re-download the files) when sw.js changes
//  byte-for-byte. Changing CACHE_VERSION is what makes users get your new files, and
//  what makes the old cache get deleted.
//  Also: when you ADD or REMOVE a file in the repo, update PRECACHE below. `npm test`
//  (tests/sw.test.mjs) fails and tells you which files are missing/extra.
//  `node scripts/precache-list.mjs` prints the current deployable file list.
// =====================================================================================
const CACHE_VERSION = 'v1';
const CACHE_NAME = `giftcards-${CACHE_VERSION}`;

// Every file the app needs, as URLs relative to this file (works in a GitHub Pages sub-folder).
// Includes all vendored libraries and the OCR language data (~3 MB) so scanning works offline.
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/backup.css',
  'css/barcode.css',
  'css/base.css',
  'css/detail.css',
  'css/edit.css',
  'css/list.css',
  'css/scan.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
  'js/app.js',
  'js/db.js',
  'js/dev.js',
  'js/draft.js',
  'js/model.js',
  'js/services/backup.js',
  'js/services/ics.js',
  'js/services/install.js',
  'js/services/ocr.js',
  'js/services/ocrParser.js',
  'js/services/photo.js',
  'js/services/scanner.js',
  'js/ui.js',
  'js/views/backup.js',
  'js/views/barcode.js',
  'js/views/detail.js',
  'js/views/edit.js',
  'js/views/list.js',
  'js/views/ocrStep.js',
  'js/views/scan.js',
  'vendor/jsbarcode/JsBarcode.all.min.js',
  'vendor/qrcode/qrcode.mjs',
  'vendor/tessdata/eng.traineddata.gz',
  'vendor/tesseract-core/tesseract-core-lstm.wasm.js',
  'vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js',
  'vendor/tesseract/tesseract.esm.min.js',
  'vendor/tesseract/worker.min.js',
  'vendor/zxing/zxing-browser.min.js',
];

// ---------------------------------------------------------------- install
// Download everything into the new cache. If any file fails, installation fails and the
// previous worker keeps running (so a broken deploy never leaves a half-cached app).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // cache: 'reload' bypasses the browser HTTP cache so we never precache stale files
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// ---------------------------------------------------------------- activate
// Remove caches from older versions, then take control of open pages right away.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('giftcards-') && key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------- fetch
// Offline-first: answer from the cache, fall back to the network.
// Responses are passed through untouched (important for eng.traineddata.gz, which must be
// served byte-for-byte).
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;                       // never touch POST etc.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;            // never cache cross-origin

  if (request.mode === 'navigate') {
    // Single-page app: every navigation gets the cached shell (the route is in the #hash).
    event.respondWith(
      caches.match(new URL('index.html', self.registration.scope).href, { ignoreSearch: true })
        .then((cached) => cached || fetch(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Runtime caching for anything we forgot in PRECACHE.
        if (response.ok && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
    })
  );
});