# Gift Card Tracker – Architecture

A single-user, offline-first gift card tracker. Static files only (GitHub Pages), no backend,
no login. Mobile-first (Android Chrome). Vanilla JS ES modules, plain HTML/CSS, **no build step**.

## 1. Ground rules (every contributor)

- **No framework, no bundler, no CDN at runtime.** Third-party code lives in `/vendor` (copied from
  `node_modules` by `npm run vendor`). Never import from `node_modules` in app code.
- **Relative paths only** (`vendor/x.js`, `./db.js`) – never a leading `/`. The app must work from a
  GitHub Pages sub-folder like `https://user.github.io/repo/`.
- **Only touch the files you own** (section 9). Shared files (`index.html`, `js/app.js`, `js/ui.js`,
  `js/db.js`, `js/model.js`, `js/draft.js`, `css/base.css`, this file) are owned by the architect.
  Need a change there? Stop and report it – don't edit.
- **No changes to the data model or function signatures** in this document without approval.
- **Money = integer minor units** (cents). Convert only at the edges with `parseAmountInput` /
  `minorToInputString` / `formatMoney` from `model.js`.
- **Balance is never stored.** Always `computeBalance(card, transactions)`.
- **User text is untrusted for HTML.** Build DOM with `el()` (text children are safe). Don't put user
  data into `innerHTML`.
- Mobile-first: touch targets ≥ 48px (`--touch`), inputs 16px font, works at 360px width.
  Use `base.css` components/tokens; per-view CSS only for layout specific to that view.
- Comment the code for a human maintainer. Keep it simple.
- Scope creep is a bug: no accounts, sync, analytics or extra screens.

## 2. File layout

```
index.html                 shell markup, links all CSS, loads js/app.js            (architect)
manifest.webmanifest       PWA manifest                                             (G)
sw.js                      service worker, versioned precache                       (G)
icons/                     icon.svg + PNG icons 192/512/maskable-512               (G; icon.svg placeholder by architect)
css/base.css               tokens, layout, buttons, forms, badges, banner, dialog… (architect)
css/<view>.css             one per view, selectors scoped under .view-<name>       (owning task)
js/app.js                  hash router, SW registration, install button, dev hook  (architect)
js/ui.js                   el(), icon(), setHeader(), navigate(), toast(), dialogs, clipboard, download, loadScript (architect)
js/db.js                   IndexedDB access – the ONLY place that touches IndexedDB (architect)
js/model.js                money, dates, balance, status, validation (pure, node-testable) (architect)
js/draft.js                in-memory hand-off: scan/OCR result -> Add form        (architect)
js/dev.js                  demo seed/wipe, loaded on localhost only                (architect)
js/views/list.js           #/                                                      (A)
js/views/edit.js           #/add, #/card/:id/edit                                  (B)
js/views/detail.js         #/card/:id                                              (C)
js/views/scan.js           #/scan                                                  (D)
js/views/ocrStep.js        last step of the scan flow (not a route)                (E)
js/views/barcode.js        #/card/:id/barcode                                      (F)
js/views/backup.js         #/backup                                                (H)
js/services/scanner.js     live camera + still-image barcode scanning              (D)
js/services/photo.js       image downscaling                                       (D)
js/services/ocr.js         Tesseract wrapper                                       (E)
js/services/ocrParser.js   OCR text -> fields (pure, node-testable)               (E)
js/services/ics.js         .ics calendar export                                    (G)
js/services/install.js     beforeinstallprompt handling                            (G)
js/services/backup.js      JSON export/import                                      (H)
vendor/                    self-hosted libraries (generated, committed)
scripts/vendor.mjs         copies library files node_modules -> vendor
scripts/serve.mjs          zero-dependency static server (npm start, used by tests)
tests/*.test.mjs           node:test unit tests (npm test)
tests/smoke/*.smoke.mjs    Playwright headless browser smoke tests (npm run smoke)
```

### Vendor files (paths relative to index.html)

| File | Loaded how | Global / export |
|---|---|---|
| `vendor/tesseract/tesseract.esm.min.js` | `import Tesseract from '../../vendor/tesseract/tesseract.esm.min.js'` | default export `Tesseract` |
| `vendor/tesseract/worker.min.js` | Tesseract `workerPath` | – |
| `vendor/tesseract-core/` | Tesseract `corePath` (directory; contains the 3 `*-lstm.wasm.js` variants) | – |
| `vendor/tessdata/` | Tesseract `langPath` (contains `eng.traineddata.gz`, best_int) | – |
| `vendor/zxing/zxing-browser.min.js` | `loadScript(src, 'ZXingBrowser')` (UMD) | `window.ZXingBrowser` (`BrowserMultiFormatReader`, `BarcodeFormat`, …) |
| `vendor/jsbarcode/JsBarcode.all.min.js` | `loadScript(src, 'JsBarcode')` (UMD) | `window.JsBarcode` |
| `vendor/qrcode/qrcode.mjs` | `import qrcode from '../../vendor/qrcode/qrcode.mjs'` | default export `qrcode(typeNumber, ecLevel)` |

Tesseract must be created with **OEM 1 (LSTM only)** – only the LSTM core variants are vendored.
Give Tesseract absolute URLs built with `new URL('vendor/…', document.baseURI).href`.

## 3. Data model

All records are plain objects stored in IndexedDB database `giftcards` (version 1).

### GiftCard (store `cards`, keyPath `id`)

| Field | Type | Notes |
|---|---|---|
| `id` | string | UUID (`newId()`) |
| `merchant` | string | required, trimmed |
| `cardNumber` | string | may be `''`; stored as entered (spaces allowed) |
| `pin` | string | optional, `''` if none |
| `originalAmount` | integer | minor units, > 0 |
| `currency` | string | ISO 4217, e.g. `'EUR'` |
| `issueDate` | string | `'YYYY-MM-DD'` or `''` |
| `expiryDate` | string | `'YYYY-MM-DD'` or `''`; must be after `issueDate` when both set |
| `type` | `'PHYSICAL' \| 'ELECTRONIC'` | `CARD_TYPES` |
| `link` | string | only for ELECTRONIC (`''` for PHYSICAL), must start with http(s):// |
| `barcodeValue` | string | raw decoded barcode text, `''` if none |
| `barcodeFormat` | string | one of `BARCODE_FORMATS` (below), `''` if no barcodeValue |
| `photoId` | string | id in store `photos`, `''` if none |
| `notes` | string | free text |
| `createdAt` | string | ISO timestamp |

Always save through `db.putCard()`, which runs `normalizeCard()` so every record has every field.

### Transaction (store `transactions`, keyPath `id`, index `cardId`)

| Field | Type | Notes |
|---|---|---|
| `id` | string | UUID |
| `cardId` | string | GiftCard id |
| `date` | string | `'YYYY-MM-DD'` |
| `amount` | integer | minor units **spent** (> 0), same currency as the card |
| `note` | string | optional |
| `createdAt` | string | ISO timestamp (tie-breaker for sorting) |

### Photo (store `photos`, keyPath `id`)
`{ id: string, blob: Blob }` – a downscaled JPEG (longest side ≤ 1600px, quality ≈ 0.8).

### Meta (store `meta`, keyPath `key`)
`{ key, value }`. Known keys: `META_LAST_EXPORT` = `'lastExportAt'` → ISO timestamp of last JSON export.

### Barcode formats
`BARCODE_FORMATS` (exported by `services/scanner.js`) uses the BarcodeDetector names:
`qr_code, code_128, code_39, code_93, codabar, ean_13, ean_8, upc_a, upc_e, itf, pdf417, aztec, data_matrix`.
ZXing results must be mapped to these names.

### Derived values (model.js, never stored)
- balance = `originalAmount − Σ transaction.amount` (`computeBalance`)
- status (`cardStatus(card, balance, now)`): `used` if balance ≤ 0 → else `expired` if expiry < today →
  else `expiring` if expiry within 30 days (`EXPIRY_SOON_DAYS`, today counts) → else `active`.
  List filters: **Active** = `active` + `expiring`; **Used up** = `used`; **Expired** = `expired`; **All**.

## 4. Routes and view contract

| Hash | View module | params |
|---|---|---|
| `#/` (or empty) | `views/list.js` | `{}` |
| `#/add` | `views/edit.js` | `{}` (reads `getDraft()` for scan pre-fill) |
| `#/card/:id/edit` | `views/edit.js` | `{ id }` |
| `#/card/:id` | `views/detail.js` | `{ id }` |
| `#/scan` | `views/scan.js` | `{}` |
| `#/card/:id/barcode` | `views/barcode.js` | `{ id }` |
| `#/backup` | `views/backup.js` | `{}` |

Every view module exports:

```js
/** Render into `container` (an empty <main class="view view-<name>">). May be async. */
export async function render(container, params) {}
/** Optional. Called before the next route renders: stop camera, release wake lock,
    revoke object URLs, clear timers, remove global listeners. Must be synchronous and never throw. */
export function cleanup() {}
```

Router behaviour (`app.js`): on every `hashchange` it calls the previous view's `cleanup()`, resets the
header (`setHeader({})`), empties `<main id="view">`, sets `container.className = 'view view-<name>'`
and `document.body.dataset.route = '<name>'` (`list|edit|detail|scan|barcode|backup|notfound`), then calls
`render`. Errors thrown by `render` are shown as "Something went wrong". A view must call `setHeader()`
itself. Re-render after a data change by calling `navigate(location.hash)` or by updating its own DOM.
Unknown card id → show an empty state "Card not found" with a link back to `#/` (don't throw).

## 5. Shared modules (implemented by the architect – use, don't modify)

### js/ui.js
```js
el(tag, attrs?, ...children) -> HTMLElement   // attrs: class, on<event>, dataset, html (trusted only), booleans
icon(name, size = 24) -> HTMLElement          // names: back plus camera image edit copy trash external download
                                              //        upload search calendar database barcode alert eye close
escapeHtml(text) -> string
navigate(hash) -> void                        // re-renders even if hash is unchanged
setHeader({ title, back: '#/...'|false, actions: Node[] }) -> void
headerButton(label, iconName, onClick) -> HTMLButtonElement   // round icon button for header actions
toast(message, type: 'info'|'success'|'error' = 'info') -> void
confirmDialog(message, { okLabel, cancelLabel, danger, title }) -> Promise<boolean>
showDialog(contentNode, { closeLabel, class }) -> HTMLDialogElement
copyToClipboard(text) -> Promise<boolean>
downloadFile(filename, stringOrBlob, mimeType) -> void
loadScript(src, globalName) -> Promise<any>   // classic UMD script, loaded once
```

### js/db.js (all async)
```js
openDb() -> Promise<IDBDatabase>
getAllCards() -> Promise<GiftCard[]>          // newest createdAt first
getCard(id) -> Promise<GiftCard|undefined>
putCard(card) -> Promise<GiftCard>            // insert/update; normalizes; assigns id/createdAt if missing
deleteCard(id) -> Promise<void>               // also deletes its transactions and photo
getTransactions(cardId) -> Promise<Transaction[]>   // newest date first
getAllTransactions() -> Promise<Transaction[]>
putTransaction({ id?, cardId, date, amount, note }) -> Promise<Transaction>
deleteTransaction(id) -> Promise<void>
putPhoto(blob, id?) -> Promise<string /*id*/>
getPhoto(id) -> Promise<Blob|undefined>
deletePhoto(id) -> Promise<void>
getAllPhotos() -> Promise<{id, blob}[]>
getMeta(key) -> Promise<any>;  setMeta(key, value) -> Promise<void>
META_LAST_EXPORT = 'lastExportAt'
clearAll() -> Promise<void>                   // cards + transactions + photos (keeps meta)
importRecords({ cards, transactions, photos }) -> Promise<void>   // one atomic transaction, overwrites same ids
requestPersistence() -> Promise<boolean>      // navigator.storage.persist(); called by app.js at startup
```
`putCard`/`putTransaction` do **not** validate – call the `validate*` functions first.

### js/model.js (pure)
```js
CARD_TYPES { PHYSICAL, ELECTRONIC };  STATUS { ACTIVE, EXPIRING, EXPIRED, USED }
DEFAULT_CURRENCY = 'EUR';  COMMON_CURRENCIES: string[];  EXPIRY_SOON_DAYS = 30;  BACKUP_REMINDER_DAYS = 30
newId() -> string
isValidCurrency(code) -> boolean;  minorDigits(currency) -> number
formatMoney(minor, currency, locale?) -> string
parseAmountInput(text, currency) -> number|null       // "12,50" -> 1250; null if invalid/empty
minorToInputString(minor, currency) -> string         // 1250 -> "12.50"
todayIso(now?) -> 'YYYY-MM-DD';  toIsoDate(date) -> string;  parseIsoDate(iso) -> Date|null
isValidIsoDate(iso) -> boolean;  daysUntil(iso, now?) -> number|null;  formatDate(iso, locale?) -> string
totalSpent(transactions) -> number;  computeBalance(card, transactions) -> number
isExpired(card, now?) -> boolean;  isExpiringSoon(card, now?, days?) -> boolean
cardStatus(card, balance, now?) -> STATUS value;  statusLabel(status) -> string
isBackupOverdue(lastExportIso, now?, days?) -> boolean
validateCard(card, spent = 0) -> { valid, errors: { merchant?, originalAmount?, currency?, issueDate?, expiryDate?, type?, link? } }
validateTransaction({ date, amount }, balance) -> { valid, errors: { date?, amount? } }
normalizeCard(input) -> GiftCard
```

### js/draft.js
```js
setDraft({ card: Partial<GiftCard>, photoBlob?: Blob|null, confidence?: {field: 0..1}, ocrText?: string })
getDraft() -> Draft|null        // does not clear
clearDraft()
```

### css/base.css components
Layout: `.stack`, `.stack-small`, `.row`, `.row-wrap`, `.spread`, `.grow`, `.muted`, `.small`, `.mono`, `.center`,
`.visually-hidden`, `.list-plain`. Surfaces: `.card` (also `a.card`). Buttons: `.btn` + `.btn-primary | .btn-danger |
.btn-ghost | .btn-block | .btn-small | .btn-icon`, `.fab`. Forms: `.field` (label + input + `.hint` + `.error-text`),
`.field.has-error`, `.field.needs-check` (OCR "please check"), `.segmented` (radio group), `.choice`.
Other: `.chips` + `.chip[aria-pressed]`, `.badge .badge-active|-expiring|-expired|-used`, `.banner .banner-warn|-danger`,
`.progress > .progress-bar` (set `style.width`), `.empty-state`, `.dialog`, `.toast`.
Tokens: `--color-*`, `--space-1..6`, `--radius`, `--touch`, `--text-*`, `--font-mono`. Dark mode is automatic.

## 6. Service contracts (implemented by tasks)

### services/scanner.js (D)
```js
BARCODE_FORMATS: string[]
hasNativeDetector() -> Promise<boolean>
startLiveScan(videoEl, { onDetected({ value, format }) }) -> Promise<{ stop() }>
    // getUserMedia({ video: { facingMode: 'environment' } }); BarcodeDetector if available, else ZXing.
    // Rejects with err.name 'NotAllowedError' | 'NotFoundError' | 'NotSupportedError' | ...
    // stop() stops all camera tracks and the scan loop; safe to call twice.
scanImage(imageBlob) -> Promise<{ value, format } | null>
```

### services/photo.js (D)
```js
downscaleImage(imageBlob, { maxDimension = 1600, quality = 0.8 }) -> Promise<Blob /*image/jpeg*/>
    // honours EXIF orientation, never upscales
```

### services/ocr.js (E)
```js
recognizeText(imageBlob, { onProgress(fraction 0..1, status) }) -> Promise<{ text, confidence /*0..100*/ }>
terminateOcr() -> Promise<void>
```

### services/ocrParser.js (E) – the OcrParser interface
```js
parseOcrText(text: string, { dateOrder: 'DMY'|'MDY' = 'DMY', defaultCurrency?: string }) -> {
  cardNumber: string|null,   // separators removed, e.g. "6035771234567890"
  expiryDate: string|null,   // 'YYYY-MM-DD'; "12/27" or "12/2027" -> last day of that month
  amount: number|null,       // minor units
  currency: string|null,     // ISO 4217 from a symbol/code in the text
  confidence: { cardNumber, expiryDate, amount, currency }   // 0..1 each; 0 when null
}
```

### views/ocrStep.js (E)
```js
runOcrStep(container, { barcode: {value, format}|null, photoBlob: Blob|null }) -> Promise<void>
    // If photoBlob: show progress (".progress") + "Skip" button in `container`, OCR, parse.
    // Merge: barcode.value -> cardNumber/barcodeValue/barcodeFormat (barcode wins over OCR cardNumber).
    // setDraft({ card, photoBlob, confidence, ocrText }); navigate('#/add') — only if still on #/scan.
```

### services/backup.js (H)
```js
BACKUP_SCHEMA_VERSION = 1
buildBackup() -> Promise<BackupFile>
exportBackup() -> Promise<{ filename, cardCount }>     // downloads + setMeta(META_LAST_EXPORT, now)
parseBackup(jsonText) -> { schemaVersion, exportedAt, cards, transactions, photos: [{id, blob}] }  // throws friendly Error
importBackup(parsed, 'merge'|'replace') -> Promise<{ cards, transactions, photos }>
getLastExportDate() -> Promise<string|null>
```

### Backup file format (schemaVersion 1)
```json
{
  "app": "gift-card-tracker",
  "schemaVersion": 1,
  "exportedAt": "2026-11-07T10:00:00.000Z",
  "cards": [ GiftCard, ... ],
  "transactions": [ Transaction, ... ],
  "photos": [ { "id": "...", "type": "image/jpeg", "data": "<base64, no data: prefix>" } ]
}
```
Import must reject: non-JSON, missing `app`/`schemaVersion`, `schemaVersion` newer than supported,
cards without `id`/`merchant`/integer `originalAmount`. Transactions whose `cardId` is not in the file
(and, for merge, not in the DB) are skipped.

### services/ics.js (G)
```js
buildIcs([{ card, balance }], { now }) -> string     // pure; one all-day VEVENT per card with expiryDate,
                                                     // VALARMs at -P30D and -P7D, CRLF, folded lines, escaped text
downloadExpiryIcs() -> Promise<number>               // cards with balance > 0 and expiry >= today -> gift-card-expiry.ics
```

### services/install.js (G)
```js
initInstallPrompt({ onAvailable(promptInstall), onInstalled() }) -> void
```

## 7. Scan → confirm flow

```
#/scan (D)  live camera ──detected──┐
            "Take photo" / "Choose image" ──> downscaleImage + scanImage (barcode from still)
                                    ▼
            after a barcode: offer "Add a photo for text recognition" or "Continue without photo"
                                    ▼
            runOcrStep(container, { barcode, photoBlob })   (E)
                → progress → parseOcrText → setDraft → navigate('#/add')
#/add (B)   getDraft() → pre-fill form, highlight confidence < 0.6 with .needs-check,
            show photo preview + collapsible raw OCR text; on Save: putPhoto(photoBlob) → photoId,
            putCard, clearDraft, navigate('#/card/<id>'); on Cancel: clearDraft, navigate('#/').
```

## 8. Testing

- `npm test` – node:test unit tests (`tests/*.test.mjs`). Pure modules only (`model.js`, `ocrParser.js`, `ics.js`).
- `npm run smoke [-- name ...]` – headless browser smoke tests in `tests/smoke/<name>.smoke.mjs`, using
  `tests/smoke/helpers.mjs` (`openApp()`, `app.seed()`, `app.goto(hash)`, `app.cardIds()`, `check()`).
  Uses the installed Microsoft Edge (`BROWSER_CHANNEL=chrome` to use Chrome). `app.close()` fails the
  test if any console error, page error or failed request happened.
- Camera tests: launch with `launchArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']`
  and `permissions: ['camera']`. Windows desktop browsers have **no** BarcodeDetector → the ZXing path runs.
- Dev helpers on localhost: `await dev.seed()` (6 demo cards in every state), `await dev.wipe()`.
- Service worker is **disabled on localhost** unless opened once with `?sw=1` (`?sw=0` to disable again).
- Run the server yourself with `npm start` (port 8080) if you need it; smoke tests start their own.

## 9. Task briefs (Phase 1)

**A – Card list (`views/list.js`, `css/list.css`).** Shows all cards with merchant, current balance
(`formatMoney`), expiry date and a status badge; expired/expiring cards are visually distinct. Search box
(filters by merchant, case-insensitive, as you type), filter chips Active (default) / Used up / Expired / All,
an "expiring soon" banner at the top listing cards that expire within 30 days and still have balance
(tap → detail), a gentle backup reminder row when `isBackupOverdue(getMeta(META_LAST_EXPORT))` and at least
one card exists (links to `#/backup`), empty states (no cards at all → call to action; no matches). Header
actions: Backup (`#/backup`). Primary actions: "Scan" (`#/scan`) and "Add" (`#/add`) – e.g. a FAB plus a
secondary button. Sort: expiring/active by soonest expiry (no expiry last), then expired, then used up.

**B – Add/Edit (`views/edit.js`, `css/edit.css`).** One form for `#/add` and `#/card/:id/edit`. All
GiftCard fields: merchant, type (segmented Physical/Electronic), link (shown only for Electronic), amount +
currency (select from `COMMON_CURRENCIES`, default = currency of the most recently created card, else
`DEFAULT_CURRENCY`), card number, PIN, issue date, expiry date, barcode value + format (select from
`BARCODE_FORMATS`), optional photo (file input `accept="image/*"`, downscaled with `downscaleImage`;
show preview; allow removing), notes. Validate with `validateCard` (when editing pass `totalSpent` of the
card's transactions) and show errors inline per field; focus the first invalid field. On `#/add` read
`getDraft()` and pre-fill (amounts are minor units), mark fields with confidence < 0.6 as `.needs-check`
with a hint "Read by text recognition – please check", show the draft photo and the raw OCR text in a
`<details>`. Save → photo handling (new photo: `putPhoto`; replaced/removed photo: `deletePhoto` the old
one) → `putCard` → `clearDraft()` → `navigate('#/card/<id>')`. Cancel → `clearDraft()` and go back.

**C – Card detail (`views/detail.js`, `css/detail.css`).** Header: back to `#/`, action Edit. Shows
merchant, big current balance, original amount, status badge, expiry (with "in N days"/"expired N days ago"),
issue date, type, card number and PIN each with a copy button (PIN masked until tapped "show"), notes.
ELECTRONIC with link → "Open card link" button (`target="_blank" rel="noopener"`). barcodeValue → "Show
barcode" button (`#/card/:id/barcode`). Photo → thumbnail; tap opens it full size (`showDialog`); revoke
object URLs in `cleanup()`. Transactions: list (date, amount, note, delete with `confirmDialog`), add form
(date default `todayIso()`, amount, note) validated with `validateTransaction` against the current balance;
balance updates after add/delete without a page reload. Delete card with `confirmDialog({danger:true})`
→ `deleteCard` → `#/`.

**D – Scanning (`services/scanner.js`, `services/photo.js`, `views/scan.js`, `css/scan.css`).** Implement
the scanner and photo contracts (section 6). BarcodeDetector when available (check `getSupportedFormats()`),
else ZXing (`loadScript('vendor/zxing/zxing-browser.min.js','ZXingBrowser')`), mapping ZXing formats to
`BARCODE_FORMATS`. Scan view: live camera preview with a "Start camera" button (don't auto-prompt
for permission before the user asks), clear messages for denied/no camera/unsupported, "Take photo"
(`<input type=file accept="image/*" capture="environment">`) and "Choose image" (no `capture`), "Enter
manually" link (`#/add`). Flow per section 7, ending with `runOcrStep(container, { barcode, photoBlob })`.
Always stop the camera in `cleanup()` and when leaving the live step. Smoke test using Chrome's fake camera
and a still image of a generated barcode (e.g. render one with JsBarcode to a PNG in the test).

**E – OCR (`services/ocrParser.js`, `services/ocr.js`, `views/ocrStep.js`, `tests/ocrParser.test.mjs`).**
Parser per section 6: dates in several formats (DD/MM/YYYY, DD.MM.YYYY, YYYY-MM-DD, MM/YY, MM/YYYY,
"Dec 31, 2027", "31 Dec 2027", with labels like EXP/Expires/Valid thru/Gültig bis), amounts with currency
symbols or codes (€25, 25,00 €, $50.00, USD 100, £10), long digit strings with spaces or dashes for the
card number (prefer 12–19 digit runs, avoid picking dates/phone numbers/amounts), confidence per field.
At least 15 realistic OCR sample texts (noisy, with O/0 and l/1 confusions where sensible) in node:test.
`ocr.js`: Tesseract v7 ESM, `createWorker('eng', 1, { workerPath, corePath, langPath, logger })` with
self-hosted absolute URLs; map logger progress to `onProgress`. `ocrStep.js` per section 6/7 with
`dateOrder` from `navigator.language` (`en-US` → MDY, else DMY). Smoke test: OCR a generated image with
known text works offline from `/vendor` (no network to other hosts).

**F – Show barcode (`views/barcode.js`, `css/barcode.css`).** Renders `barcodeValue` large on a white
background in its `barcodeFormat`: QR via `vendor/qrcode/qrcode.mjs` (SVG or canvas), 1D formats via
JsBarcode (map code_128→CODE128, ean_13→EAN13, ean_8→EAN8, upc_a→UPC, upc_e→UPCE, code_39→CODE39,
itf→ITF, codabar→codabar, code_93→CODE93 if available); unsupported formats (pdf417, aztec, data_matrix) or
invalid values fall back to CODE128 with a visible note. Show merchant, card number and PIN beneath in
large mono text. Screen Wake Lock (`navigator.wakeLock.request('screen')`), re-acquire on
`visibilitychange`, release in `cleanup()`; show "Screen will stay on" or "Keep-awake not supported" state.
Tell the user to raise brightness manually. Readable in dark mode too (barcode area always white). May
style `body[data-route="barcode"]`.

**G – PWA (`manifest.webmanifest`, `sw.js`, `icons/*`, `services/ics.js`, `services/install.js`,
`tests/ics.test.mjs`, `tests/sw.test.mjs`).** Manifest (name, short_name, start_url `./`, scope `./`,
display standalone, theme/background colors, icons 192, 512, maskable 512). Generate simple placeholder PNG
icons from a script (`scripts/make-icons.mjs`, Node only – e.g. render `icons/icon.svg` with Playwright
or write PNGs with `zlib`). `sw.js`: `CACHE_VERSION` constant, precache list of ALL app files and vendor
files (relative URLs), cache-first for same-origin GETs, navigation fallback to `index.html`, delete old
caches on activate, `skipWaiting`/`clients.claim`. `tests/sw.test.mjs` asserts every deployable file
(everything except node_modules, tests, scripts, *.md, package*.json, .gitignore, .claude) is in the
precache list and every listed file exists. `ics.js` per section 6 with unit tests. `install.js` per section 6.

**H – Backup (`services/backup.js`, `views/backup.js`, `css/backup.css`, `tests/backup.test.mjs` optional).**
Contract and file format per section 6. View: "Export backup" (shows last export date, and a gentle
reminder if > 30 days or never), "Import backup" (file picker `accept="application/json,.json"` → parse →
show counts and exportedAt → choose Merge or Replace → `confirmDialog` (Replace is `danger`) → import →
toast with counts), and "Export expiry dates (.ics)" calling `downloadExpiryIcs()` with a short explanation
that it adds calendar reminders 30 and 7 days before expiry. Also explain that data lives only on this
device. Base64 must handle multi-MB photos without blowing the call stack (use `FileReader` or chunking).
