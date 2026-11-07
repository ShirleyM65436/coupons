// Tiny static file server for local development and tests (no dependencies).
//   npm start            -> http://localhost:8080
//   PORT=9000 npm start  -> custom port
// localhost counts as a secure context, so the camera and service worker work here.
// (Alternatives: `npx serve` or `python -m http.server`.)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip', // served as-is (NOT Content-Encoding), like GitHub Pages
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** Start the server. Resolves with { server, url }. */
export function startServer(port = Number(process.env.PORT) || 8080) {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT) || file.includes('node_modules')) throw Object.assign(new Error(), { code: 'ENOENT' });
      const info = await stat(file);
      if (info.isDirectory()) { res.writeHead(301, { Location: path + '/' }); return res.end(); }
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, url: `http://localhost:${server.address().port}/` })));
}

// Run directly: node scripts/serve.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const { url } = await startServer();
  console.log(`Serving ${ROOT} at ${url}`);
}
