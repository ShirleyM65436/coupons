// views/barcode.js - "Show at the till" screen: draws the card's barcode as large as
// possible on a white panel, keeps the screen awake, and shows number + PIN underneath.
//
// Route: #/card/:id/barcode   params: { id }

import { el, setHeader, loadScript } from '../ui.js';
import { getCard } from '../db.js';
import qrcode from '../../vendor/qrcode/qrcode.mjs';

// BarcodeDetector-style format name -> JsBarcode format name.
const JSBARCODE_FORMAT = {
  code_128: 'CODE128',
  ean_13: 'EAN13',
  ean_8: 'EAN8',
  upc_a: 'UPC',
  upc_e: 'UPCE',
  code_39: 'CODE39',
  itf: 'ITF',
  codabar: 'codabar',
  code_93: 'CODE93', // present in the vendored "all" build
};

// Human readable names, used in the fallback note.
const FORMAT_LABEL = {
  qr_code: 'QR code', code_128: 'Code 128', code_39: 'Code 39', code_93: 'Code 93', codabar: 'Codabar',
  ean_13: 'EAN-13', ean_8: 'EAN-8', upc_a: 'UPC-A', upc_e: 'UPC-E', itf: 'ITF',
  pdf417: 'PDF417', aztec: 'Aztec', data_matrix: 'Data Matrix',
};

// Longer values make 1D bars too thin to scan on a phone screen -> use a QR code instead.
const MAX_1D_LENGTH = 40;

// ---- module state (released in cleanup) ----
let wakeLock = null;       // current WakeLockSentinel
let wakeActive = false;    // true while this view is open
let onVisibility = null;   // visibilitychange listener
let statusEl = null;
let renderToken = 0;       // bumped by cleanup(), so a render that resumes after leaving does nothing

// ---------------------------------------------------------------- drawing

/** Try to draw `value` with JsBarcode into a new <svg>. Returns the svg, or null if invalid. */
function draw1D(JsBarcode, value, format, barHeight) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  let ok = true;
  try {
    JsBarcode(svg, value, {
      format,
      displayValue: true,
      width: 2,            // module width in svg units; the svg is scaled to fit anyway
      height: barHeight,
      margin: 0,
      marginLeft: 24,      // quiet zone: 12 modules each side (>= the 10 recommended)
      marginRight: 24,
      marginTop: 16,
      marginBottom: 12,
      fontSize: 22,
      textMargin: 6,
      background: '#ffffff',
      lineColor: '#000000',
      valid: (isValid) => { ok = isValid; },
    });
  } catch {
    ok = false;
  }
  return ok ? svg : null;
}

/**
 * Draw a 1D barcode scaled to fill `availWidth` and roughly `targetHeight` px tall.
 * Two passes: the first measures the natural width, the second picks a bar height
 * that gives the wanted on-screen height at the resulting scale.
 */
function build1D(JsBarcode, value, format, availWidth, targetHeight) {
  const probe = draw1D(JsBarcode, value, format, 100);
  if (!probe) return null;
  const naturalW = parseFloat(probe.getAttribute('width'));
  const scale = availWidth / naturalW;
  // total svg height = bars + ~60 units of text/margins
  const bars = Math.max(80, Math.min(400, Math.round(targetHeight / scale - 60)));
  const svg = draw1D(JsBarcode, value, format, bars) || probe;
  // Make it scale with its container (crisp at any size).
  svg.setAttribute('viewBox', `0 0 ${parseFloat(svg.getAttribute('width'))} ${parseFloat(svg.getAttribute('height'))}`);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('class', 'barcode-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Barcode ' + value);
  return svg;
}

/** QR code as a scalable SVG (error correction M, auto type number). */
function buildQr(value) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const holder = el('div', { class: 'barcode-qr', html: qr.createSvgTag({ cellSize: 1, margin: 4, scalable: true }) });
  const svg = holder.querySelector('svg');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('class', 'barcode-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code');
  return holder;
}

/** Decide what to draw. Returns { node, kind, note }. */
async function buildBarcode(card, panelWidth) {
  const value = card.barcodeValue;
  const format = card.barcodeFormat;
  const label = FORMAT_LABEL[format] || format || 'unknown';
  const targetHeight = Math.min(window.innerHeight * 0.38, 360);

  if (format === 'qr_code') return { node: buildQr(value), kind: 'qr', note: '' };

  const fallbackNote = `Shown as Code 128 – the original format (${label}) can't be drawn here, so the scanner at the till may not accept it.`;
  const qrNote = 'Shown as a QR code – the value is too long for a readable barcode, so the scanner at the till may not accept it.';

  if (value.length > MAX_1D_LENGTH) return { node: buildQr(value), kind: 'qr', note: qrNote };

  const JsBarcode = await loadScript('vendor/jsbarcode/JsBarcode.all.min.js', 'JsBarcode');
  const wanted = JSBARCODE_FORMAT[format];
  if (wanted) {
    const svg = build1D(JsBarcode, value, wanted, panelWidth, targetHeight);
    if (svg) return { node: svg, kind: '1d', note: '' };
  }
  // Unsupported format or value invalid for its format -> Code 128.
  const svg = build1D(JsBarcode, value, 'CODE128', panelWidth, targetHeight);
  if (svg) return { node: svg, kind: '1d', note: fallbackNote };
  // Code 128 can't encode it either (non-ASCII text) -> QR as a last resort.
  return { node: buildQr(value), kind: 'qr', note: wanted ? qrNote : fallbackNote.replace('Code 128', 'a QR code') };
}

// ---------------------------------------------------------------- wake lock

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

/** Request the screen wake lock; updates the status line with the outcome. */
async function acquireWakeLock() {
  if (!wakeActive) return;
  if (!('wakeLock' in navigator) || !navigator.wakeLock?.request) {
    setStatus("Your browser can't keep the screen on – it may dim");
    return;
  }
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    if (!wakeActive) { sentinel.release().catch(() => {}); return; } // left the view meanwhile
    wakeLock = sentinel;
    sentinel.addEventListener('release', () => { if (wakeLock === sentinel) wakeLock = null; });
    setStatus('Screen will stay on while this page is open');
  } catch (err) {
    console.warn('Wake lock not granted:', err?.message || err);
    setStatus("Your browser can't keep the screen on – it may dim");
  }
}

// ---------------------------------------------------------------- view

function infoRow(label, value) {
  return el('div', { class: 'barcode-info-row' },
    el('span', { class: 'muted small' }, label),
    el('span', { class: 'barcode-info-value mono' }, value));
}

export async function render(container, params) {
  const token = ++renderToken;
  const card = await getCard(params.id);
  if (token !== renderToken) return; // user already left this view

  if (!card) {
    setHeader({ title: 'Card not found', back: '#/' });
    container.append(el('div', { class: 'empty-state' },
      el('p', {}, 'Card not found'),
      el('a', { class: 'btn', href: '#/' }, 'Back to all cards')));
    return;
  }

  setHeader({ title: card.merchant, back: `#/card/${card.id}` });

  if (!card.barcodeValue) {
    container.append(el('div', { class: 'empty-state' },
      el('p', {}, 'This card has no barcode saved'),
      el('a', { class: 'btn btn-primary', href: `#/card/${card.id}/edit` }, 'Edit card to add one')));
    return;
  }

  // Panel first (so we can measure its width), then fill it.
  const panel = el('div', { class: 'barcode-panel' });
  statusEl = el('p', { class: 'small muted barcode-status', role: 'status' }, '');
  container.append(el('div', { class: 'stack' },
    panel,
    el('div', { class: 'barcode-notes stack-small' },
      el('p', { class: 'barcode-hint' }, 'Turn your screen brightness up for the scanner.'),
      statusEl),
    el('div', { class: 'card barcode-info stack-small' },
      el('div', { class: 'barcode-merchant' }, card.merchant),
      card.cardNumber ? infoRow('Card number', card.cardNumber) : null,
      card.pin ? infoRow('PIN', card.pin) : null),
    el('a', { class: 'btn btn-block', href: `#/card/${card.id}` }, 'Done')));

  const { node, note } = await buildBarcodeInto(card, panel);
  // The user may have left while JsBarcode was loading: don't grab the wake lock then.
  if (token !== renderToken) return;
  panel.append(node);
  if (note) panel.after(el('p', { class: 'banner banner-warn barcode-note', role: 'note' }, note));

  // Keep the screen on while showing the code; re-acquire after the tab was hidden.
  wakeActive = true;
  onVisibility = () => { if (document.visibilityState === 'visible' && wakeActive && !wakeLock) acquireWakeLock(); };
  document.addEventListener('visibilitychange', onVisibility);
  acquireWakeLock();
}

/** Measure the panel (minus padding) and build the barcode for it. */
function buildBarcodeInto(card, panel) {
  const style = getComputedStyle(panel);
  const inner = panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return buildBarcode(card, Math.max(200, inner));
}

export function cleanup() {
  renderToken++;
  wakeActive = false;
  try {
    if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    onVisibility = null;
    const sentinel = wakeLock;
    wakeLock = null;
    if (sentinel) sentinel.release().catch(() => {});
  } catch { /* never throw from cleanup */ }
  statusEl = null;
}
