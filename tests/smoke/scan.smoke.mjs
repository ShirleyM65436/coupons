// Smoke test for Task D: scanner.js (scanImage), photo.js (downscaleImage) and the Scan view.
// Images are generated at runtime in the browser (JsBarcode / qrcode.mjs), nothing is stored in fixtures.
// Note: desktop Edge/Chrome on Windows has no BarcodeDetector, so everything here exercises the ZXing path.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApp, check } from './helpers.mjs';

const FAKE_CAM = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

/** Page-side helpers: build test images as PNG data URLs. Evaluated inside the app page. */
const IMAGE_FACTORY = `
window.__makeImages = async () => {
  const { loadScript } = await import('./js/ui.js');
  const JsBarcode = await loadScript('vendor/jsbarcode/JsBarcode.all.min.js', 'JsBarcode');
  const qrcode = (await import('./vendor/qrcode/qrcode.mjs')).default;
  const barcodeCanvas = (text, format, opts = {}) => {
    const c = document.createElement('canvas');
    JsBarcode(c, text, { format, width: 3, height: 120, margin: 24, background: '#fff', ...opts });
    return c;
  };
  const toUrl = (c) => c.toDataURL('image/png');
  const out = {};
  out.ean = toUrl(barcodeCanvas('4006381333931', 'EAN13'));
  out.code128 = toUrl(barcodeCanvas('GIFT-12345', 'CODE128'));
  // QR code via qrcode.mjs (GIF data URL) drawn onto a white canvas
  const qr = qrcode(0, 'M'); qr.addData('https://example.com/redeem?code=ABC'); qr.make();
  const img = new Image(); img.src = qr.createDataURL(8, 32); await img.decode();
  const qc = document.createElement('canvas'); qc.width = img.width; qc.height = img.height;
  qc.getContext('2d').drawImage(img, 0, 0); out.qr = toUrl(qc);
  // Small EAN-13 inside a big 3000x2000 white "photo"
  const small = barcodeCanvas('4006381333931', 'EAN13', { width: 2, height: 90, margin: 10 });
  const big = document.createElement('canvas'); big.width = 3000; big.height = 2000;
  const bctx = big.getContext('2d'); bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, 3000, 2000);
  bctx.fillStyle = '#ccc'; bctx.fillRect(100, 100, 700, 300); // some clutter
  bctx.drawImage(small, 1500, 900); out.photo = toUrl(big);
  // Blank image
  const blank = document.createElement('canvas'); blank.width = 600; blank.height = 400;
  const ctx = blank.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 400); out.blank = toUrl(blank);
  // Big barcode filling a 640x480 camera-like frame (for the Y4M fake camera): returns grayscale bytes
  const frame = document.createElement('canvas'); frame.width = 640; frame.height = 480;
  const fctx = frame.getContext('2d'); fctx.fillStyle = '#fff'; fctx.fillRect(0, 0, 640, 480);
  const bar = barcodeCanvas('4006381333931', 'EAN13', { width: 5, height: 200, margin: 20 });
  fctx.drawImage(bar, (640 - bar.width) / 2, (480 - bar.height) / 2, Math.min(bar.width, 640), bar.height);
  const px = fctx.getImageData(0, 0, 640, 480).data;
  const gray = new Array(640 * 480);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(0.299 * px[i*4] + 0.587 * px[i*4+1] + 0.114 * px[i*4+2]);
  out.frameGray = gray;
  return out;
};
`;

const dataUrlToBuffer = (url) => Buffer.from(url.split(',')[1], 'base64');

/** Build a small Y4M file (4:2:0) from 640x480 grayscale bytes, for Chromium's fake camera. */
function makeY4m(gray) {
  const W = 640, H = 480;
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`);
  const y = Buffer.from(gray);
  const chroma = Buffer.alloc((W / 2) * (H / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma, chroma]);
  return Buffer.concat([header, ...Array(10).fill(frame)]);
}

export default async function () {
  // ------------------------------------------------------------------ 1+2: scanImage and downscaleImage
  let app = await openApp();
  let images;
  try {
    await app.page.evaluate(IMAGE_FACTORY);
    images = await app.page.evaluate(() => window.__makeImages());

    const results = await app.page.evaluate(async (imgs) => {
      const { scanImage } = await import('./js/services/scanner.js');
      const toBlob = async (url) => (await fetch(url)).blob();
      const out = {};
      for (const key of ['ean', 'code128', 'qr', 'photo', 'blank']) out[key] = await scanImage(await toBlob(imgs[key]));
      return out;
    }, images);
    check(results.ean?.value === '4006381333931' && results.ean.format === 'ean_13', 'scanImage: EAN-13 -> ' + JSON.stringify(results.ean));
    check(results.code128?.value === 'GIFT-12345' && results.code128.format === 'code_128', 'scanImage: Code 128 -> ' + JSON.stringify(results.code128));
    check(results.qr?.value === 'https://example.com/redeem?code=ABC' && results.qr.format === 'qr_code', 'scanImage: QR -> ' + JSON.stringify(results.qr));
    check(results.photo?.value === '4006381333931' && results.photo.format === 'ean_13', 'scanImage: small EAN in 3000x2000 photo -> ' + JSON.stringify(results.photo));
    check(results.blank === null, 'scanImage: blank image -> null');

    const dims = await app.page.evaluate(async () => {
      const { downscaleImage } = await import('./js/services/photo.js');
      const mk = async (w, h) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, w, h);
        return new Promise((r) => c.toBlob(r, 'image/png'));
      };
      const measure = async (blob) => { const b = await createImageBitmap(blob); return { type: blob.type, w: b.width, h: b.height }; };
      return { big: await measure(await downscaleImage(await mk(4000, 3000))), small: await measure(await downscaleImage(await mk(800, 600))) };
    });
    check(dims.big.type === 'image/jpeg' && dims.big.w === 1600 && dims.big.h === 1200, 'downscaleImage 4000x3000 -> ' + JSON.stringify(dims.big));
    check(dims.small.type === 'image/jpeg' && dims.small.w === 800 && dims.small.h === 600, 'downscaleImage 800x600 stays -> ' + JSON.stringify(dims.small));
  } finally {
    await app.close();
  }

  // ------------------------------------------------------------------ 4: flow with a still image
  app = await openApp();
  try {
    await app.goto('#/scan');
    check((await app.page.locator('#app-title').innerText()) === 'Scan card', 'scan view header');
    // No camera permission prompt before the user taps Start camera: video stays hidden
    check(await app.page.locator('.view-scan video').isHidden(), 'video hidden before Start camera');
    check(await app.page.locator('input[type=file][capture]').count() === 1, 'Take photo input has capture');

    await app.page.evaluate(IMAGE_FACTORY);
    const imgs = await app.page.evaluate(() => window.__makeImages());
    await app.page.locator('.view-scan input[type=file]:not([capture])').setInputFiles({ name: 'ean.png', mimeType: 'image/png', buffer: dataUrlToBuffer(imgs.ean) });
    await app.page.waitForFunction(() => location.hash === '#/add', null, { timeout: 15000 });
    const draft = await app.page.evaluate(async () => {
      const { getDraft } = await import('./js/draft.js');
      const d = getDraft();
      return { value: d.card.barcodeValue, format: d.card.barcodeFormat, isBlob: d.photoBlob instanceof Blob, type: d.photoBlob?.type };
    });
    check(draft.value === '4006381333931' && draft.format === 'ean_13', 'flow: draft has barcode ' + JSON.stringify(draft));
    check(draft.isBlob && draft.type === 'image/jpeg', 'flow: draft photoBlob is a JPEG Blob');

    // Image without barcode still continues to #/add (OCR may find the number), with no barcode in the draft
    await app.goto('#/scan');
    await app.page.locator('.view-scan input[type=file]:not([capture])').setInputFiles({ name: 'blank.png', mimeType: 'image/png', buffer: dataUrlToBuffer(imgs.blank) });
    await app.page.waitForFunction(() => location.hash === '#/add', null, { timeout: 15000 });
    const blankDraft = await app.page.evaluate(async () => (await import('./js/draft.js')).getDraft());
    check(!blankDraft.card.barcodeValue && blankDraft.photoBlob, 'flow: blank image continues without barcode but with photo');
  } finally {
    await app.close();
  }

  // ------------------------------------------------------------------ 3: fake camera (stream lifecycle)
  app = await openApp({ launchArgs: FAKE_CAM, permissions: ['camera'] });
  try {
    await app.goto('#/scan');
    await app.page.getByRole('button', { name: 'Start camera' }).click();
    await app.page.waitForFunction(() => { const v = document.querySelector('.view-scan video'); return v && !v.paused && v.videoWidth > 0; }, null, { timeout: 15000 });
    await app.page.waitForSelector('.view-scan video', { state: 'visible', timeout: 10000 }); // shown once the scanner is ready
    check(true, 'camera: video visible and playing');
    await app.page.evaluate(() => { window.__tracks = document.querySelector('.view-scan video').srcObject.getTracks(); });

    await app.page.getByRole('button', { name: 'Stop camera' }).click();
    let state = await app.page.evaluate(() => ({ ended: window.__tracks.every((t) => t.readyState === 'ended'), src: document.querySelector('.view-scan video')?.srcObject ?? null }));
    check(state.ended, 'camera: Stop camera ends all tracks');
  } finally {
    await app.close();
  }

  // Second scenario in a FRESH browser: Chromium's fake camera device sometimes disappears
  // (NotFoundError / NotReadableError, for seconds) when it is stopped and re-opened within one
  // browser session. That is a test-environment artifact, so each camera scenario gets its own browser.
  app = await openApp({ launchArgs: FAKE_CAM, permissions: ['camera'] });
  try {
    await app.goto('#/scan');
    await app.page.getByRole('button', { name: 'Start camera' }).click();
    await app.page.waitForFunction(() => { const v = document.querySelector('.view-scan video'); return v && !v.paused && v.videoWidth > 0; }, null, { timeout: 15000 });
    await app.page.waitForSelector('.view-scan video', { state: 'visible', timeout: 10000 });
    await app.page.evaluate(() => { window.__tracks = document.querySelector('.view-scan video').srcObject.getTracks(); });
    await app.goto('#/');
    const state = await app.page.evaluate(() => ({ ended: window.__tracks.every((t) => t.readyState === 'ended') }));
    check(state.ended, 'camera: leaving the view ends all tracks');
  } finally {
    await app.close();
  }

  // ------------------------------------------------------------------ 3b (stretch): live detection from a Y4M fake camera
  const dir = mkdtempSync(join(tmpdir(), 'scan-y4m-'));
  const y4mPath = join(dir, 'ean.y4m');
  writeFileSync(y4mPath, makeY4m(images.frameGray));
  app = await openApp({ launchArgs: [...FAKE_CAM, '--use-file-for-fake-video-capture=' + y4mPath], permissions: ['camera'] });
  try {
    await app.goto('#/scan');
    await app.page.getByRole('button', { name: 'Start camera' }).click();
    await app.page.waitForSelector('[data-role=found-value]', { timeout: 20000 });
    check((await app.page.locator('[data-role=found-value]').innerText()) === '4006381333931', 'live: EAN-13 detected from Y4M fake camera');
    check(await app.page.locator('.view-scan video').count() === 0, 'live: camera view replaced after detection');
    await app.page.getByRole('button', { name: 'Continue without photo' }).click();
    await app.page.waitForFunction(() => location.hash === '#/add', null, { timeout: 5000 });
    const d = await app.page.evaluate(async () => (await import('./js/draft.js')).getDraft());
    check(d.card.barcodeValue === '4006381333931' && d.card.barcodeFormat === 'ean_13' && !d.photoBlob, 'live: continue without photo -> draft');
  } finally {
    await app.close();
  }

  // ------------------------------------------------------------------ 5: camera denied (stubbed getUserMedia)
  app = await openApp();
  try {
    await app.page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await app.goto('#/scan');
    await app.page.getByRole('button', { name: 'Start camera' }).click();
    await app.page.waitForSelector('.view-scan [role=alert]:not([hidden])');
    const msg = await app.page.locator('.view-scan [role=alert]').innerText();
    check(msg.includes('Camera access was blocked'), 'denied: friendly message shown -> ' + msg);
    check(await app.page.getByRole('button', { name: 'Start camera' }).isEnabled(), 'denied: Start camera can be retried');
  } finally {
    await app.close();
  }
}
