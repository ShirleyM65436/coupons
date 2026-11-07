// ui.js - small shared UI helpers used by every view.
// Views import from here instead of from app.js (avoids circular imports).

// ---------------------------------------------------------------- DOM

/**
 * Create an element. Example:
 *   el('button', { class: 'btn btn-primary', onclick: save }, 'Save')
 * - attrs starting with "on" become event listeners
 * - `class`, `for`, `html` (sets innerHTML - only for trusted strings!), `dataset` (object)
 * - boolean attrs: true -> present, false/null/undefined -> omitted
 * - children: strings (inserted as text, so user data is safe) or Nodes; null/false skipped
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'value' && 'value' in node) node.value = value;
    else if (key === 'checked' || key === 'selected' || key === 'disabled') node[key] = Boolean(value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Escape text for use inside an HTML string. Prefer el() which needs no escaping. */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- icons

// Inline SVG icons (Feather-style line icons, 24x24). Inherit color via currentColor.
const ICON_PATHS = {
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  edit: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  barcode: '<path d="M3 5v14M6 5v14M10 5v14M13 5v14M17 5v14M21 5v14"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

/** Names accepted by icon(). */
export const ICON_NAMES = Object.keys(ICON_PATHS);

/** An inline SVG icon element, e.g. el('button', {}, icon('plus'), 'Add'). */
export function icon(name, size = 24) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</svg>`;
  return span;
}

// ---------------------------------------------------------------- navigation & header

/** Go to a hash route, e.g. navigate('#/card/abc'). */
export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

/**
 * Configure the top app bar for the current view. Call from a view's render().
 * @param {object} opts
 * @param {string} opts.title           text shown in the bar
 * @param {string|false} [opts.back]    hash to go back to (e.g. '#/'), or false for no back button
 * @param {Node[]} [opts.actions]       buttons/links shown on the right side
 */
export function setHeader({ title = '', back = false, actions = [] } = {}) {
  document.getElementById('app-title').textContent = title;
  document.title = title ? `${title} · Gift Cards` : 'Gift Cards';
  const backBtn = document.getElementById('app-back');
  backBtn.hidden = !back;
  backBtn.onclick = back ? () => navigate(back) : null;
  const slot = document.getElementById('app-actions');
  slot.replaceChildren(...actions);
}

/**
 * Icon button for the app bar, with an accessible label.
 * @param {string} label     e.g. 'Edit card'
 * @param {string} iconName  a name from ICON_NAMES
 * @param {() => void} onClick
 */
export function headerButton(label, iconName, onClick) {
  return el('button', { class: 'appbar-btn', type: 'button', 'aria-label': label, title: label, onclick: onClick }, icon(iconName));
}

// ---------------------------------------------------------------- feedback

let toastTimer = null;
/**
 * Show a short message at the bottom of the screen.
 * @param {string} message
 * @param {'info'|'success'|'error'} [type]
 */
export function toast(message, type = 'info') {
  const box = document.getElementById('toast');
  box.textContent = message;
  box.className = `toast toast-${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), type === 'error' ? 5000 : 2500);
}

/**
 * Modal confirmation. Resolves true if the user pressed OK.
 * @param {string} message
 * @param {{ okLabel?: string, cancelLabel?: string, danger?: boolean, title?: string }} [opts]
 */
export function confirmDialog(message, { okLabel = 'OK', cancelLabel = 'Cancel', danger = false, title = '' } = {}) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'dialog' },
      el('form', { method: 'dialog', class: 'stack' },
        title ? el('h2', { class: 'dialog-title' }, title) : null,
        el('p', {}, message),
        el('div', { class: 'dialog-actions' },
          el('button', { class: 'btn', value: 'cancel', type: 'submit' }, cancelLabel),
          el('button', { class: danger ? 'btn btn-danger' : 'btn btn-primary', value: 'ok', type: 'submit' }, okLabel),
        ),
      ),
    );
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok');
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * Modal with custom content (e.g. a photo viewer or a choice). Returns the <dialog>.
 * Closes on the "Close" button, Escape, or a click on the backdrop. Removed from the DOM on close.
 * @param {Node} content
 * @param {{ closeLabel?: string, class?: string }} [opts]
 */
export function showDialog(content, { closeLabel = 'Close', class: extraClass = '' } = {}) {
  const dialog = el('dialog', { class: `dialog ${extraClass}` },
    content,
    el('form', { method: 'dialog', class: 'dialog-actions' }, el('button', { class: 'btn', type: 'submit' }, closeLabel)),
  );
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

// ---------------------------------------------------------------- clipboard & files

/** Copy text to the clipboard. Resolves true on success. Shows no toast itself. */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers without the async clipboard API
    const area = el('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** Trigger a file download of a string or Blob. */
export function downloadFile(filename, content, mimeType = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename, style: 'display:none' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------- vendor scripts

const scriptCache = new Map();
/**
 * Load a classic (non-module) script once and resolve with the global it defines.
 * Paths are relative to index.html, e.g. loadScript('vendor/jsbarcode/JsBarcode.all.min.js', 'JsBarcode').
 */
export function loadScript(src, globalName) {
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  if (!scriptCache.has(src)) {
    scriptCache.set(src, new Promise((resolve, reject) => {
      const s = el('script', { src });
      s.onload = () => resolve(globalName ? window[globalName] : undefined);
      s.onerror = () => { scriptCache.delete(src); reject(new Error('Failed to load ' + src)); };
      document.head.append(s);
    }));
  }
  return scriptCache.get(src);
}
