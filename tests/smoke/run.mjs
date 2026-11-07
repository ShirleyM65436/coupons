// Runs every smoke script in tests/smoke/ (files named *.smoke.mjs), one after another.
//   npm run smoke                 -> all
//   npm run smoke -- list detail  -> only list.smoke.mjs and detail.smoke.mjs
// Each smoke script exports `default async function ()` that throws on failure.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.smoke.mjs'))
  .filter((f) => !only.length || only.includes(f.replace('.smoke.mjs', '')))
  .sort();

let failed = 0;
for (const f of files) {
  console.log(`\n# ${f}`);
  try {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    await mod.default();
    console.log(`PASS ${f}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${f}\n${err.stack || err}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} smoke scripts passed`);
process.exit(failed ? 1 : 0);
