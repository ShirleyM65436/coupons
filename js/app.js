// app.js - app shell: hash router, service worker registration, install button.
// This is the only file that knows about every view.

import { requestPersistence } from './db.js';
import { setHeader, el } from './ui.js';

// ---------------------------------------------------------------- routes
// Each route: [pattern, view name, loader]. Params come from the regex groups.
// View modules export render(container, params) and optionally cleanup().
const ROUTES = [
  [/^#?\/?$/, 'list', () => import('./views/list.js')],
  [/^#\/add$/, 'edit', () => import('./views/edit.js')],
  [/^#\/scan$/, 'scan', () => import('./views/scan.js')],
  [/^#\/backup$/, 'backup', () => import('./views/backup.js')],
  [/^#\/card\/([^/]+)$/, 'detail', () => import('./views/detail.js')],
  [/^#\/card\/([^/]+)\/edit$/, 'edit', () => import('./views/edit.js')],
  [/^#\/card\/([^/]+)\/barcode$/, 'barcode', () => import('./views/barcode.js')],
];

const container = document.getElementById('view');
let currentView = null;   // module of the view on screen
let renderToken = 0;      // increases on every navigation, to ignore stale async renders

async function route() {
  const hash = location.hash || '#/';
  const token = ++renderToken;

  // Let the previous view release camera, wake lock, object URLs, timers...
  if (currentView?.cleanup) {
    try { currentView.cleanup(); } catch (err) { console.error('cleanup failed', err); }
  }
  currentView = null;

  let match = null;
  let entry = null;
  for (const r of ROUTES) {
    match = hash.match(r[0]);
    if (match) { entry = r; break; }
  }

  // Reset the shell for the new view.
  setHeader({ title: '', back: false, actions: [] });
  container.replaceChildren();
  window.scrollTo(0, 0);

  if (!entry) {
    document.body.dataset.route = 'notfound';
    setHeader({ title: 'Not found', back: '#/' });
    container.className = 'view';
    container.append(el('p', { class: 'empty-state' }, 'This page does not exist.'));
    return;
  }

  const [, name, load] = entry;
  // params: { id } for /card/:id routes, {} otherwise
  const params = match[1] ? { id: decodeURIComponent(match[1]) } : {};
  document.body.dataset.route = name;
  container.className = `view view-${name}`;

  try {
    const mod = await load();
    if (token !== renderToken) return; // user already navigated elsewhere
    currentView = mod;
    await mod.render(container, params);
  } catch (err) {
    console.error(err);
    if (token !== renderToken) return;
    container.replaceChildren(el('div', { class: 'empty-state' },
      el('p', {}, 'Something went wrong.'),
      el('p', { class: 'muted' }, String(err?.message || err)),
      el('a', { class: 'btn', href: '#/' }, 'Back to list')));
  }
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- service worker
// Disabled on localhost during development (cached files would hide your edits).
// Enable it locally by opening the app once with ?sw=1 (disable again with ?sw=0).
function shouldUseServiceWorker() {
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const flag = new URLSearchParams(location.search).get('sw');
  if (flag !== null) localStorage.setItem('swOnLocalhost', flag);
  return !isLocal || localStorage.getItem('swOnLocalhost') === '1';
}

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (shouldUseServiceWorker()) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (err) {
      console.warn('Service worker registration failed', err);
    }
  } else {
    // Make sure no old worker keeps serving cached files during development.
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) await reg.unregister();
  }
}

// ---------------------------------------------------------------- install button
async function setupInstallButton() {
  const btn = document.getElementById('app-install');
  const { initInstallPrompt } = await import('./services/install.js');
  initInstallPrompt({
    onAvailable(promptInstall) {
      btn.hidden = false;
      btn.onclick = async () => {
        await promptInstall();
        btn.hidden = true;
      };
    },
    onInstalled() { btn.hidden = true; },
  });
}

// ---------------------------------------------------------------- dev helpers
// On localhost, window.dev.seed() adds demo cards and window.dev.wipe() deletes everything.
async function setupDevHelpers() {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  const dev = await import('./dev.js');
  window.dev = { seed: dev.seedDemoData, wipe: dev.wipeAll, rerender: route };
}

// ---------------------------------------------------------------- start
requestPersistence();
setupServiceWorker();
setupInstallButton().catch((err) => console.warn('install prompt setup failed', err));
setupDevHelpers();
route();
