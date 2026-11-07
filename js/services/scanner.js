// services/scanner.js - barcode / QR scanning: live camera and still images.
// Contract: see ARCHITECTURE.md "services/scanner.js".
//
// Two engines:
//   * the browser's native BarcodeDetector (Android Chrome) - fast, used when available;
//   * ZXing (vendor/zxing, loaded lazily) - used everywhere else (desktop, iOS, Firefox).
// Both are hidden behind the same small API, results use the BARCODE_FORMATS names.

import { loadScript } from '../ui.js';

/** @typedef {{ value: string, format: string }} BarcodeResult  format: see BARCODE_FORMATS */

/** Normalized format names used everywhere in the app (BarcodeDetector naming). */
export const BARCODE_FORMATS = ['qr_code', 'code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8',
  'upc_a', 'upc_e', 'itf', 'pdf417', 'aztec', 'data_matrix'];

const SCAN_INTERVAL_MS = 150;      // pause between live decode attempts (saves battery)
const ZXING_TRY_HARDER = 3;        // value of ZXing's DecodeHintType.TRY_HARDER (enum is not exported by the UMD build)

// ---------------------------------------------------------------- engine detection

let nativeSupport = null; // cached promise
/** True if the native BarcodeDetector exists and supports at least one format. */
export function hasNativeDetector() {
  if (!nativeSupport) {
    nativeSupport = (async () => {
      try {
        if (!('BarcodeDetector' in window)) return false;
        const formats = await window.BarcodeDetector.getSupportedFormats();
        return Array.isArray(formats) && formats.length > 0;
      } catch {
        return false;
      }
    })();
  }
  return nativeSupport;
}

let nativeDetector = null;
/** One shared BarcodeDetector limited to the formats we know. */
async function getNativeDetector() {
  if (!nativeDetector) {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    nativeDetector = new window.BarcodeDetector({ formats: BARCODE_FORMATS.filter((f) => supported.includes(f)) });
  }
  return nativeDetector;
}

// ---------------------------------------------------------------- ZXing helpers

/** Load ZXing and build a reader. tryHarder = slower but also finds rotated / small 1D codes. */
async function makeZxingReader(tryHarder) {
  const Z = await loadScript('vendor/zxing/zxing-browser.min.js', 'ZXingBrowser');
  const hints = tryHarder ? new Map([[ZXING_TRY_HARDER, true]]) : undefined;
  return { Z, reader: new Z.BrowserMultiFormatReader(hints) };
}

/** Map a ZXing BarcodeFormat enum value to one of BARCODE_FORMATS (or null, e.g. RSS/MaxiCode). */
function mapZxingFormat(Z, formatEnum) {
  let name = String(Z.BarcodeFormat[formatEnum] || '').toLowerCase(); // enum has reverse mapping: 7 -> 'EAN_13'
  if (name === 'pdf_417') name = 'pdf417';
  return BARCODE_FORMATS.includes(name) ? name : null;
}

/** Decode one canvas with ZXing. Returns a result or null (ZXing throws NotFoundException when nothing is there). */
function zxingDecodeCanvas(Z, reader, canvas) {
  try {
    const result = reader.decodeFromCanvas(canvas);
    const format = mapZxingFormat(Z, result.getBarcodeFormat());
    const value = result.getText();
    return format && value ? { value, format } : null;
  } catch {
    return null;
  }
}

/** Convert a native BarcodeDetector hit into our result shape. */
function nativeResult(codes) {
  const hit = (codes || []).find((c) => c.rawValue && BARCODE_FORMATS.includes(c.format));
  return hit ? { value: hit.rawValue, format: hit.format } : null;
}

// ---------------------------------------------------------------- live scanning

/**
 * Start the rear camera in `videoEl` and scan continuously.
 * Calls onDetected once per distinct code. Resolves with a controller once the camera runs.
 * Rejects with an Error whose .name is 'NotAllowedError' | 'NotFoundError' | 'NotSupportedError' | other.
 * @param {HTMLVideoElement} videoEl
 * @param {{ onDetected: (r: BarcodeResult) => void }} handlers
 * @returns {Promise<{ stop: () => void }>}
 */
export async function startLiveScan(videoEl, { onDetected }) {
  if (!navigator.mediaDevices?.getUserMedia) {
    // Typically an insecure context (http:// on a phone) or a very old browser.
    const err = new Error('Camera access is not supported here');
    err.name = 'NotSupportedError';
    throw err;
  }

  // Throws NotAllowedError / NotFoundError / ... straight to the caller (names preserved).
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });

  let stopped = false;
  let timer = null;
  /** Stops every camera track and the scan loop. Safe to call twice. */
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    // Detach the stream from the <video> first, then stop the tracks (releases the device cleanly).
    videoEl.pause();
    videoEl.srcObject = null;
    stream.getTracks().forEach((t) => t.stop());
  };

  try {
    videoEl.setAttribute('playsinline', '');
    videoEl.muted = true;
    videoEl.srcObject = stream;
    await videoEl.play();

    // Pick the engine. ZXing is only downloaded when the native detector is missing.
    const native = await hasNativeDetector();
    let decodeFrame;
    if (native) {
      const detector = await getNativeDetector();
      decodeFrame = async () => nativeResult(await detector.detect(videoEl));
    } else {
      const { Z, reader } = await makeZxingReader(false);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      decodeFrame = async () => {
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        return zxingDecodeCanvas(Z, reader, canvas);
      };
    }
    if (stopped) return { stop }; // user left while ZXing was loading

    // Scan loop: one attempt every SCAN_INTERVAL_MS, never overlapping.
    let lastValue = null;
    const tick = async () => {
      if (stopped) return;
      try {
        if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
          const found = await decodeFrame();
          if (stopped) return;
          if (found && found.value !== lastValue) {
            lastValue = found.value; // once per distinct value
            onDetected(found);
          }
        }
      } catch {
        // A failed frame is not fatal - just try again on the next tick.
      }
      if (!stopped) timer = setTimeout(tick, SCAN_INTERVAL_MS);
    };
    timer = setTimeout(tick, 0);
  } catch (err) {
    stop(); // never leave the camera running after a failure
    throw err;
  }

  return { stop };
}

// ---------------------------------------------------------------- still images

/** Decode an image Blob into an ImageBitmap (EXIF orientation applied when supported). */
async function loadBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(blob);
  }
}

/** Draw a bitmap/canvas onto a new canvas scaled so its longest side is `maxSide` (never upscaled), optionally rotated 90 degrees. */
function drawScaled(src, maxSide, rotate90 = false) {
  const w = src.width, h = src.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = rotate90 ? dh : dw;
  canvas.height = rotate90 ? dw : dh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; // transparent PNGs would otherwise decode as black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (rotate90) {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.drawImage(src, 0, 0, dw, dh);
  return canvas;
}

/**
 * Find a barcode/QR code in a still image (File/Blob).
 * Tries the full-size image first, then smaller copies (big phone photos often fail at full
 * resolution) and a rotated copy. Never throws for "not found".
 * @param {Blob} imageBlob
 * @returns {Promise<BarcodeResult|null>} null if nothing found
 */
export async function scanImage(imageBlob) {
  let bitmap;
  try {
    bitmap = await loadBitmap(imageBlob);
  } catch {
    return null; // not a decodable image
  }
  try {
    const native = await hasNativeDetector();
    const detector = native ? await getNativeDetector() : null;
    let zxing = null; // loaded lazily, only when needed

    // Attempts in order: [max side, rotated?]. Larger sides are capped to keep memory sane.
    const longest = Math.max(bitmap.width, bitmap.height);
    const attempts = [[4096, false]];
    for (const side of [1600, 1000, 640]) if (side < longest) attempts.push([side, false]); // only real shrinks
    attempts.push([1600, true]);
    for (const [side, rotated] of attempts) {
      const canvas = drawScaled(bitmap, side, rotated);

      if (detector) {
        try {
          const found = nativeResult(await detector.detect(canvas));
          if (found) return found;
        } catch { /* try ZXing / next size */ }
      }
      try {
        zxing = zxing || await makeZxingReader(true);
        const found = zxingDecodeCanvas(zxing.Z, zxing.reader, canvas);
        if (found) return found;
      } catch { /* ZXing failed to load (offline and not cached) - treat as not found */ }
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}
