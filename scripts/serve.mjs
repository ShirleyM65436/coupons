// Tiny static file server for local development and tests (no dependencies).
//   npm start              -> http://localhost:8080   (also reachable from the Wi-Fi as http://<pc-ip>:8080)
//   npm run start:https    -> https://<pc-ip>:8443   (needs `npm run cert` first; lets a phone INSTALL the app)
//   PORT=9000 npm start    -> custom port
// localhost counts as a secure context, so the camera and service worker work there.
// (Alternatives for plain http: `npx serve` or `python -m http.server`.)
//
// Both modes also offer the PUBLIC certificate of your local CA at /local-ca.crt, so a phone
// can download and install it once (only the certificate - the private keys are never served).

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CERTS = join(ROOT, '.certs');

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

/** Request handler shared by the http and https servers. */
async function handle(req, res) {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);

    // The local CA certificate (public part only) for installing on a phone.
    if (path === '/local-ca.crt') {
      const ca = join(CERTS, 'ca.der.crt');
      if (!existsSync(ca)) throw Object.assign(new Error(), { code: 'ENOENT' });
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="giftcards-local-ca.crt"',
      });
      return res.end(await readFile(ca));
    }

    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    const rel = file.slice(ROOT.length);
    // Never serve outside the project, node_modules, or any dot-folder/file (.certs keys, .git, .claude).
    const hidden = rel.split(sep).some((part) => part.startsWith('.')) || rel.includes('node_modules');
    if (!file.startsWith(ROOT) || hidden) throw Object.assign(new Error(), { code: 'ENOENT' });
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
}

/** Start the plain-http server. Resolves with { server, url }. */
export function startServer(port = Number(process.env.PORT) || 8080) {
  const server = createServer(handle);
  return new Promise((resolve) => server.listen(port, () => resolve({ server, url: `http://localhost:${server.address().port}/` })));
}

/** Start the https server with the certificate from `npm run cert`. Resolves with { server, port }. */
export function startHttpsServer(port = Number(process.env.PORT) || 8443) {
  const key = join(CERTS, 'server.key');
  const cert = join(CERTS, 'server.crt');
  if (!existsSync(key) || !existsSync(cert)) {
    throw new Error('No certificate yet. Run `npm run cert` first (see README "Install from this PC").');
  }
  // Send the CA along with the server certificate so clients get the full chain.
  const chain = readFileSync(cert, 'utf8') + readFileSync(join(CERTS, 'ca.crt'), 'utf8');
  const server = createHttpsServer({ key: readFileSync(key), cert: chain }, handle);
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port: server.address().port })));
}

// Run directly: node scripts/serve.mjs [--https]
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  if (process.argv.includes('--https')) {
    const { port } = await startHttpsServer();
    // This PC's Wi-Fi/LAN IPv4 address, for the hint below.
    const ip = Object.values(networkInterfaces()).flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))?.address || '<this PC\'s IP>';
    console.log(`Serving ${ROOT} over HTTPS`);
    console.log(`  on the phone: https://${ip}:${port}`);
    console.log(`  CA certificate to install once: http://${ip}:8080/local-ca.crt  (needs \`npm start\` running too)`);
  } else {
    const { url } = await startServer();
    console.log(`Serving ${ROOT} at ${url}`);
  }
}
