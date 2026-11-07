// views/scan.js - route #/scan. Step 1: live camera or a photo; step 2 (after a live
// detection): optionally add a photo for OCR. Ends by calling runOcrStep().
// Flow: see ARCHITECTURE.md section 7.

import { el, icon, setHeader, toast } from '../ui.js';
import { startLiveScan, scanImage } from '../services/scanner.js';
import { downscaleImage } from '../services/photo.js';
import { runOcrStep } from './ocrStep.js';

let container = null;
let camera = null;      // { stop() } while the live camera runs
let starting = false;   // true while waiting for getUserMedia
let generation = 0;     // bumped on every render/cleanup so late async results can be ignored

/** Render the view into the container. */
export async function render(el0) {
  container = el0;
  generation++;
  setHeader({ title: 'Scan card', back: '#/' });
  showStart();
}

/** Release the camera. Safe to call when nothing was started. */
export function cleanup() {
  generation++;
  stopCamera();
  container = null;
}

// ---------------------------------------------------------------- helpers

function stopCamera() {
  try { camera?.stop(); } catch { /* ignore */ }
  camera = null;
}

/** Friendly message for a getUserMedia / scanner error. */
function cameraErrorMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return "Camera access was blocked. Allow it in the browser's site settings, or take a photo instead.";
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. Take a photo or choose an image instead.';
    case 'NotSupportedError':
      return 'Live scanning is not available here (it needs a camera and a secure https connection). Take a photo instead.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is in use by another app. Close it and try again, or take a photo instead.';
    default:
      return 'The camera could not be started. Take a photo instead.';
  }
}

/** A button-looking label that wraps a visually hidden file input. */
function fileButton(label, iconName, { capture, primary, onFile }) {
  const input = el('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', capture: capture ? 'environment' : null });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = ''; // allow picking the same file again later
    if (file) onFile(file);
  });
  return el('label', { class: `btn btn-block scan-file-btn${primary ? ' btn-primary' : ''}` }, icon(iconName), label, input);
}

function replaceContent(...nodes) {
  if (container) container.replaceChildren(...nodes);
}

// ---------------------------------------------------------------- step 1: scan

function showStart(message) {
  stopCamera();
  const gen = generation;

  const video = el('video', { class: 'scan-video', playsinline: true, muted: true });
  const stage = el('div', { class: 'scan-stage', hidden: true },
    video,
    el('div', { class: 'scan-frame', 'aria-hidden': 'true' }),
    el('p', { class: 'scan-hint small' }, 'Point the camera at the barcode or QR code'),
  );
  const errorBox = el('div', { class: 'banner banner-warn', role: 'alert', hidden: !message }, message || '');

  const startBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, icon('camera'), 'Start camera');
  const stopBtn = el('button', { class: 'btn btn-block', type: 'button', hidden: true }, icon('close'), 'Stop camera');

  // Tapping "Start camera" is the first moment we ask for camera permission.
  startBtn.addEventListener('click', async () => {
    if (starting) return;
    starting = true;
    startBtn.disabled = true;
    errorBox.hidden = true;
    try {
      // Guard: if the camera never starts (hung permission prompt, play() never resolving),
      // give up after a while so the button is usable again. A late controller is stopped.
      let timedOut = false;
      const pending = startLiveScan(video, {
        onDetected: (result) => {
          if (gen !== generation) return;
          stopCamera();
          navigator.vibrate?.(100);
          showFound(result);
        },
      });
      pending.then((c) => { if (timedOut) c.stop(); }, () => {});
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(Object.assign(new Error('Camera start timed out'), { name: 'TimeoutError' })); }, 20000);
      });
      let controller;
      try { controller = await Promise.race([pending, timeout]); } finally { clearTimeout(timer); }
      if (gen !== generation) { controller.stop(); return; } // user left meanwhile
      camera = controller;
      stage.hidden = false;
      startBtn.hidden = true;
      stopBtn.hidden = false;
    } catch (err) {
      if (gen !== generation) return;
      errorBox.textContent = cameraErrorMessage(err);
      errorBox.hidden = false;
      startBtn.disabled = false;
    } finally {
      starting = false;
    }
  });

  stopBtn.addEventListener('click', () => showStart());

  replaceContent(el('div', { class: 'stack' },
    el('p', { class: 'muted' }, 'Scan the barcode or QR code on the gift card. You can also photograph the card so its text (number, expiry, amount) is read for you.'),
    errorBox,
    stage,
    startBtn,
    stopBtn,
    el('div', { class: 'scan-or muted small center' }, 'or use a picture'),
    el('div', { class: 'stack-small' },
      fileButton('Take photo', 'camera', { capture: true, onFile: (f) => handleStill(f, null) }),
      fileButton('Choose image', 'image', { capture: false, onFile: (f) => handleStill(f, null) }),
    ),
    el('p', { class: 'center' }, el('a', { href: '#/add' }, 'Enter manually')),
  ));
}

// ---------------------------------------------------------------- step 2: barcode found live

function showFound(barcode) {
  replaceContent(el('div', { class: 'stack' },
    el('div', { class: 'card scan-result' },
      el('div', { class: 'small muted' }, 'Barcode found'),
      el('div', { class: 'mono scan-value', 'data-role': 'found-value' }, barcode.value),
      el('div', { class: 'small muted' }, 'Type: ' + barcode.format.replace(/_/g, ' ')),
    ),
    el('p', { class: 'muted' }, 'A photo of the card lets the app read the number, expiry date and amount from the text. It is also saved with the card.'),
    el('div', { class: 'stack-small' },
      el('h3', {}, 'Add a photo for text recognition'),
      fileButton('Take photo', 'camera', { capture: true, primary: true, onFile: (f) => handleStill(f, barcode) }),
      fileButton('Choose image', 'image', { capture: false, onFile: (f) => handleStill(f, barcode) }),
    ),
    el('button', { class: 'btn btn-block', type: 'button', onclick: () => runOcrStep(container, { barcode, photoBlob: null }) }, 'Continue without photo'),
    el('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => showStart() }, 'Scan again'),
  ));
}

// ---------------------------------------------------------------- still image

/** Busy screen shown while an image is processed. */
function showBusy(text) {
  replaceContent(el('div', { class: 'empty-state', role: 'status' },
    el('div', { class: 'progress scan-busy-bar' }, el('div', { class: 'progress-bar' })),
    el('p', {}, text),
  ));
  // Indeterminate-looking bar: just animate to 100% slowly.
  requestAnimationFrame(() => {
    const bar = container && container.querySelector('.progress-bar');
    if (bar) bar.style.width = '90%';
  });
}

/**
 * Handle a still photo: downscale it for storage, look for a barcode (unless one is already
 * known from the live scan), then hand over to the OCR step.
 */
async function handleStill(file, knownBarcode) {
  const gen = generation;
  stopCamera();
  showBusy('Reading image...');
  try {
    // Scan the ORIGINAL file: downscaling can hurt barcode decoding.
    let barcode = knownBarcode;
    if (!barcode) barcode = await scanImage(file);
    if (gen !== generation) return;

    const photoBlob = await downscaleImage(file);
    if (gen !== generation) return;

    if (!barcode) toast('No barcode found in the photo');
    await runOcrStep(container, { barcode, photoBlob });
  } catch (err) {
    if (gen !== generation) return;
    console.warn('Scan failed', err);
    toast('Could not read that image. Try another one.', 'error');
    knownBarcode ? showFound(knownBarcode) : showStart();
  }
}
