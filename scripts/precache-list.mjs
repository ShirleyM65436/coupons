// Prints the list of deployable files, formatted for pasting into PRECACHE in sw.js.
//   node scripts/precache-list.mjs
// Also imported by tests/sw.test.mjs (deployableFiles()).
//
// Deployable = everything except dev-only stuff (see EXCLUDED_* below) and sw.js itself.
// Decision: vendor LICENSE files ARE excluded from the precache (they are not needed to run the app;
// they are still deployed to GitHub Pages because they are in the repo). Everything else in vendor/ is included.

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXCLUDED_DIRS = new Set(['node_modules', 'tests', 'scripts', '.claude', '.git', 'test-results']);
const EXCLUDED_FILES = new Set(['package.json', 'package-lock.json', '.gitignore', 'sw.js']);

function isExcluded(relPath) {
  const name = relPath.split('/').pop();
  if (EXCLUDED_FILES.has(name) && !relPath.includes('/')) return true;
  if (name.endsWith('.md') || name.endsWith('.log')) return true;
  if (/^LICEN[CS]E/i.test(name)) return true; // vendor license texts: optional, not precached
  return false;
}

/** Sorted list of deployable files as forward-slash paths relative to the project root. */
export function deployableFiles(dir = ROOT) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      if (dir === ROOT && EXCLUDED_DIRS.has(name)) continue;
      out.push(...deployableFiles(full));
    } else if (!isExcluded(rel)) {
      out.push(rel);
    }
  }
  return out.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  for (const f of deployableFiles()) console.log(`  '${f}',`);
}
