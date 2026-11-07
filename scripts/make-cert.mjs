// Creates the certificates for serving the app over HTTPS on your home network, so a phone
// can install it as an app (Chrome only installs apps from HTTPS or localhost).
//
//   npm run cert              -> uses this PC's Wi-Fi IP (e.g. 10.0.0.10)
//   npm run cert -- 192.168.1.20   -> a specific IP
//
// What it makes (in .certs/, which is git-ignored and never served or deployed):
//   ca.crt / ca.key         your own small certificate authority (CA). Install ca.crt on the phone ONCE.
//                           It is "name constrained": it can only vouch for addresses in your local
//                           /24 network (e.g. 10.0.0.x) and this PC (localhost) - nothing on the internet.
//   server.crt / server.key the HTTPS certificate for this PC's IP, signed by that CA (valid 397 days).
// Re-running keeps the existing CA (so the phone doesn't need it again) and only renews server.crt,
// e.g. after the router gave the PC a new IP. Delete .certs/ to start over.
//
// Needs openssl - Git for Windows includes it (C:\Program Files\Git\usr\bin\openssl.exe).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.certs');

/** Find openssl: on PATH, or the copy that comes with Git for Windows. */
function findOpenssl() {
  const candidates = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe'];
  for (const c of candidates) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* try next */ }
  }
  throw new Error('openssl not found. Install Git for Windows (it includes openssl) or add openssl to PATH.');
}

/** This PC's LAN IPv4 address (Wi-Fi/Ethernet), skipping loopback and link-local. */
export function lanIp() {
  const all = Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
  const priv = all.find((i) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
  return (priv || all[0])?.address;
}

const ip = process.argv[2] || lanIp();
if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('Could not find this PC\'s IP. Pass it: npm run cert -- 10.0.0.10');
const subnet = ip.split('.').slice(0, 3).join('.') + '.0';

const openssl = findOpenssl();
const run = (...args) => execFileSync(openssl, args, { cwd: DIR, stdio: ['ignore', 'ignore', 'pipe'] });
mkdirSync(DIR, { recursive: true });

// ---- 1. the CA (only created once)
if (!existsSync(join(DIR, 'ca.crt'))) {
  writeFileSync(join(DIR, 'ca.cnf'), [
    '[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no',
    '[dn]', 'CN = Gift Cards local CA (home network only)', 'O = Gift Card Tracker (local)',
    '[ext]',
    'basicConstraints = critical, CA:TRUE, pathlen:0',
    'keyUsage = critical, keyCertSign, cRLSign',
    'subjectKeyIdentifier = hash',
    // The safety limit: this CA can ONLY sign certificates for these addresses.
    `nameConstraints = critical, permitted;IP:${subnet}/255.255.255.0, permitted;IP:127.0.0.1/255.255.255.255, permitted;DNS:localhost`,
  ].join('\n'));
  run('req', '-x509', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650', '-config', 'ca.cnf');
  // Android installs CA certificates from .crt (DER or PEM). Also write DER for maximum compatibility.
  run('x509', '-in', 'ca.crt', '-outform', 'der', '-out', 'ca.der.crt');
  console.log(`Created CA (limited to ${subnet}/24 + localhost): .certs/ca.crt`);
} else {
  console.log('Keeping existing CA: .certs/ca.crt (phone does not need it again)');
}

// ---- 2. the server certificate for this IP
writeFileSync(join(DIR, 'server.cnf'), [
  '[req]', 'distinguished_name = dn', 'prompt = no', '[dn]', `CN = ${ip}`,
  '[ext]',
  'basicConstraints = critical, CA:FALSE',
  'keyUsage = critical, digitalSignature',
  'extendedKeyUsage = serverAuth',
  `subjectAltName = IP:${ip}, IP:127.0.0.1, DNS:localhost`,
  'authorityKeyIdentifier = keyid',
].join('\n'));
run('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
  '-keyout', 'server.key', '-out', 'server.csr', '-config', 'server.cnf');
run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
  '-out', 'server.crt', '-days', '397', '-extfile', 'server.cnf', '-extensions', 'ext');
rmSync(join(DIR, 'server.csr'), { force: true });
console.log(`Created HTTPS certificate for ${ip}: .certs/server.crt`);
console.log(`\nNext: npm run start:https  ->  https://${ip}:8443`);
console.log(`On the phone, first install the CA once: http://${ip}:8080/local-ca.crt (see README "Install from this PC").`);
