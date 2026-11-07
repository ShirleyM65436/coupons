// PWA smoke test: manifest + icons, service worker precache, full offline operation, ?sw=0 opt-out.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { openApp, check } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** PRECACHE array from sw.js (evaluated with a fake `self`). */
function readPrecache() {
  const source = readFileSync(join(root, 'sw.js'), 'utf8');
  const self = { addEventListener() {}, location: { origin: 'http://x' }, registration: { scope: 'http://x/' } };
  return JSON.parse(vm.runInNewContext(`${source}\n;JSON.stringify({ PRECACHE, CACHE_NAME })`, { self, URL, Request: class {} }));
}

export default async function () {
  const { PRECACHE, CACHE_NAME } = readPrecache();
  const app = await openApp();
  const { page } = app;
  try {
    // ---- manifest and icons (online)
    const manifest = await page.evaluate(() => fetch('manifest.webmanifest').then((r) => r.json()));
    check(manifest.name === 'Gift Card Tracker' && manifest.short_name, 'manifest has name and short_name');
    check(manifest.display === 'standalone' && manifest.start_url === './' && manifest.scope === './', 'manifest display/start_url/scope');
    const iconInfo = await page.evaluate(async (icons) => Promise.all(icons.map(async (i) => {
      const r = await fetch(i.src);
      return { src: i.src, status: r.status, type: r.headers.get('content-type') };
    })), manifest.icons);
    for (const i of iconInfo) check(i.status === 200, `icon ${i.src} resolves (${i.type})`);
    check(manifest.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png'), 'has 192 png icon');
    check(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'), 'has 512 maskable icon');
    check(await page.evaluate(() => !!document.querySelector('link[rel=manifest]')), 'index.html links the manifest');

    // ---- enable the service worker (disabled on localhost unless ?sw=1)
    await page.goto(app.url + '?sw=1');
    await page.waitForFunction(() => window.dev);
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
      await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, { timeout: 30000 });
      await page.reload();
      await page.waitForFunction(() => window.dev);
    }
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    check(true, 'service worker controls the page');

    // ---- precache complete
    const cached = await page.evaluate(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).map((r) => r.url);
    }, CACHE_NAME);
    const missing = PRECACHE.map((u) => new URL(u, app.url).href).filter((u) => !cached.includes(u));
    check(missing.length === 0, `cache ${CACHE_NAME} holds all ${PRECACHE.length} PRECACHE entries` + (missing.length ? ' missing: ' + missing.join(', ') : ''));

    // seed one card while online, then go offline
    await app.seed();
    app.errors.length = 0; // from here on only offline behaviour is checked

    await page.context().setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.dev);
    check(await page.locator('#app-title').isVisible(), 'offline reload: app shell renders (#app-title visible)');
    for (const hash of ['#/', '#/backup', '#/scan', '#/add']) {
      await app.goto(hash);
      const text = await page.locator('#view').innerText();
      check(!text.includes('Something went wrong'), `offline: route ${hash} renders`);
    }
    check((await page.locator('#view').innerHTML()).length > 50, 'offline: view has content');

    const expected = statSync(join(root, 'vendor', 'tessdata', 'eng.traineddata.gz')).size;
    const got = await page.evaluate(async () => {
      const r = await fetch('vendor/tessdata/eng.traineddata.gz');
      return { status: r.status, length: (await r.arrayBuffer()).byteLength };
    });
    check(got.status === 200 && got.length === expected, `offline: eng.traineddata.gz served byte-for-byte (${got.length} bytes)`);

    // dynamic import of a view works offline too
    const imported = await page.evaluate(() => import('./js/views/backup.js').then(() => true));
    check(imported, 'offline: ES module import works');

    await page.context().setOffline(false);

    // ---- ?sw=0 unregisters the worker
    await page.goto(app.url + '?sw=0');
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length === 0, null, { timeout: 10000 });
    check(true, '?sw=0 unregisters the service worker');

    check(app.errors.length === 0, 'no console errors / failed requests (offline included)');
  } finally {
    await app.close();
  }
}
