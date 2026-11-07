# Gift Card Tracker

A personal gift card tracker that runs entirely in your browser. It works offline, can be installed on an Android home screen and needs no account or server. Your cards, transactions and photos are stored **only on this device**, in the browser's IndexedDB.

What it does:
- **Card list:** balance, expiry, an "expiring soon" banner, search, and filters (active / used up / expired / all).
- **Add or edit cards by hand,** including PIN, issue and expiry dates, link (for e-gift cards), barcode, photo and notes.
- **Scan to add:** live camera barcode/QR scanning, or a photo. Text recognition (OCR) pre-fills the card number, expiry date and amount, and you always confirm the details before saving.
- **Card detail:** current balance, transactions (add/delete), copy number/PIN, open the card's link, view the photo.
- **Show barcode:** a large, scannable barcode or QR on a white background, and the screen stays on.
- **Reminders:** an in-app banner, plus a calendar file (.ics) with alerts 30 and 7 days before each expiry date.
- **Backup:** export everything (photos included) to one JSON file, and import it again (merge or replace).

Balances are never stored. They are always calculated as *original amount minus the transactions*. Money is kept in whole cents to avoid rounding errors.

---

## Run it locally

Requirements: [Node.js](https://nodejs.org) 20+ (only for the dev server and tests; the app itself needs no build step).

```bash
npm install
```

```bash
npm start
```

Then open <http://localhost:8080>. `localhost` counts as a secure context, so the camera works there.

Alternatives: `npx serve` or `python -m http.server 8080` in the project folder. Opening `index.html` via `file://` will **not** work, because ES modules and the camera need http(s).

**Demo data:** on localhost, open the browser console and run `await dev.seed()` (adds 6 cards in every state) or `await dev.wipe()` (deletes everything).

**Service worker during development:** it is switched off on localhost so your edits show up immediately. To test offline mode locally, open `http://localhost:8080/?sw=1` once. Use `?sw=0` to switch it off again.

> Testing on your phone over Wi-Fi (`http://192.168.x.x:8080`) won't give you the camera, because that address is not a secure context. Test on the phone through GitHub Pages (HTTPS) instead.

## Tests

```bash
npm test
```
Runs the unit tests (node:test): money/date/status logic, the OCR text parser (20 realistic samples), the .ics generator, backup validation, and a check that the service worker caches every file.

```bash
npm run smoke
```
Runs the headless browser smoke tests (Playwright) for every screen and flow, using the Microsoft Edge already installed on Windows. Run only some with `npm run smoke -- list detail`, or use Chrome with `BROWSER_CHANNEL=chrome`.

## Deploy to GitHub Pages (HTTPS)

GitHub Pages serves the files as they are; there is no build step.

1. Create a GitHub repository and push this folder to it. `node_modules/` is git-ignored. **`vendor/` must be committed**, because it holds the offline copies of the libraries.
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   ```
   ```bash
   git push -u origin main
   ```
2. On GitHub, go to **Settings → Pages**. Set **Source** to "Deploy from a branch", **Branch** to `main`, folder `/ (root)`, and save.
3. After a minute the app is live at `https://<you>.github.io/<repo>/`. All paths in the app are relative, so the sub-folder works.

**Every time you deploy a change:** open `sw.js` and bump `CACHE_VERSION` (e.g. `'v1'` → `'v2'`). Otherwise installed copies keep serving the old cached files. If you add or remove a file, run `npm test`: `tests/sw.test.mjs` tells you exactly which entries of the `PRECACHE` list in `sw.js` need updating (`node scripts/precache-list.mjs` prints the full list).

## Install on Android (as an app)

1. Open the GitHub Pages URL in **Chrome** on the phone.
2. Tap the **Install** button in the app's top bar, or use Chrome's menu ⋮ → **Install app** / **Add to Home screen**.
3. Launch it from the home screen. It opens full-screen and works without internet. The first visit downloads ~15 MB (mostly the text-recognition engine), so do it on Wi-Fi.

## Backups – please read

Your data lives only in this browser on this phone. Uninstalling Chrome, clearing site data, or losing the phone deletes it. The app asks the browser for "persistent storage" to prevent automatic eviction, but that is no substitute for a backup.

- **Export:** open the **Backup** screen (database icon on the list screen) and tap **Export backup**. A file named `giftcards-backup-YYYY-MM-DD.json` is saved to your Downloads folder. Copy it somewhere safe (cloud drive, e-mail it to yourself). The list screen reminds you when your last backup is more than 30 days old.
- **Import:** on the Backup screen tap **Import backup**, choose the file, then pick:
  - **Merge:** keeps your current cards and adds or updates the ones from the file.
  - **Replace:** deletes all current cards and restores the file exactly. This is done as one step, so a failed import never leaves you with nothing.
- **Calendar reminders:** **Export expiry dates (.ics)** creates a calendar file with an event on each expiry date and alerts 30 and 7 days before. Open it with your calendar app. Re-export after adding cards (a web page cannot send background notifications).

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design: file layout, data model, module APIs, routes and the scan flow.

```
index.html, css/, js/       the app (vanilla JS ES modules, no framework, no build)
js/views/                   one file per screen
js/services/                scanner, photo, OCR + parser, backup, .ics, install prompt
vendor/                     self-hosted libraries (Tesseract.js, ZXing, JsBarcode, qrcode-generator)
sw.js, manifest.webmanifest PWA / offline support
tests/                      unit tests + headless browser smoke tests
scripts/                    dev server, vendor copy, icon generator, precache list
```

Updating a library: `npm update <package>`, then `npm run vendor` (copies the files into `vendor/`), then `npm test` and `npm run smoke`, then bump `CACHE_VERSION`.

## Only verifiable on a real phone

These were built to spec and tested in a desktop headless browser where possible, but need a check on your Android phone:

- **Camera:** "Start camera" opens the rear camera, the permission prompt appears, and the preview fits the screen. "Take photo" opens the camera app.
- **Native barcode scanning:** Android Chrome uses the built-in `BarcodeDetector`, which the desktop tests could not exercise (they used the ZXing fallback). Check speed and reliability on real cards, including glossy and curved ones.
- **OCR accuracy on real photos:** lighting, glare, embossed digits and fonts all matter. Recognition takes a few seconds on a phone. Always check the pre-filled fields; low-confidence ones are highlighted.
- **Show barcode at the till:** whether the shop's scanner accepts the on-screen code (turn brightness up). PDF417, Aztec and Data Matrix codes can't be redrawn and are shown as Code 128 with a warning.
- **Screen wake lock:** the screen should stay on while the barcode is shown.
- **Install prompt and standalone launch:** the Install button appears, the icon looks right on the home screen, and the app works in airplane mode.
- **App updates:** after deploying with a bumped `CACHE_VERSION`, reopening the app (sometimes twice) picks up the new version.
- **Downloads:** backup and .ics files land in Downloads, and the .ics opens in your calendar app.
- **Photo orientation:** portrait/landscape photos from the camera are stored the right way up.
