// Keeps the service worker's PRECACHE list in sync with the files in the repo.
// If this fails after you added/removed a file: update PRECACHE in sw.js
// (`node scripts/precache-list.mjs` prints the current list) and bump CACHE_VERSION.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT, deployableFiles } from '../scripts/precache-list.mjs';

/** Evaluate sw.js with a fake `self` and return { PRECACHE, CACHE_VERSION, CACHE_NAME }. */
function loadSw() {
  const source = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const self = { addEventListener() {}, location: { origin: 'http://x' }, registration: { scope: 'http://x/' } };
  // JSON round trip: arrays from the vm realm would confuse assert.deepEqual
  return JSON.parse(vm.runInNewContext(`${source}\n;JSON.stringify({ PRECACHE, CACHE_VERSION, CACHE_NAME })`,
    { self, URL, Request: class {} }));
}

const { PRECACHE, CACHE_VERSION, CACHE_NAME } = loadSw();
// './' is the app root, which is served from index.html
const listedFiles = PRECACHE.filter((u) => u !== './');

test('cache name is derived from CACHE_VERSION', () => {
  assert.ok(CACHE_VERSION);
  assert.equal(CACHE_NAME, `giftcards-${CACHE_VERSION}`);
});

test('PRECACHE entries are relative, unique and exist on disk', () => {
  assert.equal(new Set(PRECACHE).size, PRECACHE.length, 'duplicate entries in PRECACHE');
  assert.ok(PRECACHE.includes('./'), "PRECACHE must contain './'");
  const bad = listedFiles.filter((u) => u.startsWith('/') || /^[a-z]+:/i.test(u));
  assert.deepEqual(bad, [], 'PRECACHE entries must be relative paths');
  const missing = listedFiles.filter((u) => !existsSync(join(ROOT, u)) || !statSync(join(ROOT, u)).isFile());
  assert.deepEqual(missing, [], `Listed in sw.js PRECACHE but not on disk (remove them):\n  ${missing.join('\n  ')}`);
});

test('every deployable file is listed in PRECACHE', () => {
  const listed = new Set(listedFiles);
  const unlisted = deployableFiles().filter((f) => !listed.has(f));
  assert.deepEqual(unlisted, [],
    `Files missing from PRECACHE in sw.js (add them and bump CACHE_VERSION):\n  ${unlisted.join('\n  ')}`);
});

test('manifest icons and start_url are covered by PRECACHE', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './');
  for (const icon of manifest.icons) assert.ok(PRECACHE.includes(icon.src), `${icon.src} not in PRECACHE`);
  const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
  for (const want of ['192x192:any', '512x512:any', '512x512:maskable']) assert.ok(sizes.includes(want), `missing icon ${want}`);
});
