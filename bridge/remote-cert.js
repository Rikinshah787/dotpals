// A private certificate authority for your own network, so a phone can reach the remote client over
// https at this computer's LAN address, with no tunnel and nothing leaving your network.
//
//   dotpals remote cert        make (once) a CA and a server certificate for this computer's addresses
//
// The CA is restricted (X.509 name constraints) to private addresses and .local names: even if its key
// leaked, it could not vouch for any real website. Its key stays on this computer (0600), the server
// certificate is renewed from it, and only `ca.pem` (public) is ever put on a phone.
// Needs `openssl` (Git for Windows ships one); nothing else.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, X509Certificate, randomBytes } from 'node:crypto';

export const certDir = (home) => join(home, 'remote-cert');

/** The CA's SHA-256 fingerprint ("AB:CD:…"), to compare on the phone after copying ca.pem over; null if there's none yet. */
export function caFingerprint(dir) {
  try { return new X509Certificate(readFileSync(join(dir, 'ca.pem'))).fingerprint256; } catch { return null; }
}

/**
 * Every openssl we know to try, in order: PATH, then the ones Git for Windows and Homebrew ship. A PATH
 * entry isn't trusted to work: Anaconda's and XAMPP's builds on Windows look for a config file that often
 * isn't there, so each candidate has to make a real certificate request before it's chosen.
 */
let foundOpenssl;
export function findOpenssl(run = spawnSync, exists = existsSync) {
  // Remembered for the life of the process (the real one only): it's two spawns, and a renewal shouldn't repeat them.
  if (run === spawnSync && exists === existsSync && foundOpenssl) return foundOpenssl;
  const found = searchOpenssl(run, exists);
  if (found && run === spawnSync && exists === existsSync) foundOpenssl = found;
  return found;
}

function searchOpenssl(run, exists) {
  const candidates = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe', '/usr/bin/openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl'];
  const probeDir = mkdtempSync(join(tmpdir(), 'dotpals-ossl-'));
  try {
    for (const c of candidates) {
      if ((c.includes('\\') || c.startsWith('/')) && !exists(c)) continue;
      const v = run(c, ['version'], { encoding: 'utf8' });
      if (v.status !== 0 || !/OpenSSL|LibreSSL/.test(v.stdout)) continue;
      const t = run(c, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '1', '-subj', '/CN=probe'], { cwd: probeDir, encoding: 'utf8', env: opensslEnv(probeDir) });
      if (t.status === 0) return c;
    }
    return null;
  } finally { try { rmSync(probeDir, { recursive: true, force: true }); } catch {} }
}

/** openssl reads a config file on start; point it at an empty one of ours so a missing system one can't stop it. */
function opensslEnv(dir) {
  const conf = join(dir, 'empty.cnf');
  if (!existsSync(conf)) writeFileSync(conf, '');
  return { ...process.env, OPENSSL_CONF: conf };
}

/** This computer's private IPv4 addresses (the ones a phone on your Wi-Fi would use). */
export function privateAddresses(ifaces = networkInterfaces()) {
  const isPrivate = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  return Object.values(ifaces).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && isPrivate(i.address)).map((i) => i.address);
}

/**
 * This computer's multicast-DNS name as a phone would look it up ("nighthawk.local"), or null. macOS may already
 * give a ".local" hostname, and a name with spaces or dots isn't a valid label, so it's cleaned the way mDNS does.
 */
export function localName(name = hostname()) {
  const label = String(name ?? '').toLowerCase().replace(/\.local\.?$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return label ? `${label}.local` : null;
}

/** The names the server certificate must answer to: every private address, and the .local name. */
export const altNames = (ips, name) => [...ips.map((i) => `IP:${i}`), 'IP:127.0.0.1', ...(localName(name) ? [`DNS:${localName(name)}`] : []), 'DNS:localhost'].join(',');

// Name constraints: private ranges, loopback, .local and localhost only.
export const CONSTRAINTS = 'nameConstraints=critical,permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0,permitted;IP:127.0.0.1/255.255.255.255,permitted;DNS:.local,permitted;DNS:localhost';

/**
 * The server certificate's extensions. Key identifiers are spelled out: OpenSSL adds them by itself, LibreSSL (what macOS
 * ships) doesn't, and a strict verifier wants them. `keyid` (not `always`) leaves the authority one out when an older CA,
 * made before this, has no key identifier to point at.
 */
export const leafExtensions = (names) => `subjectAltName=${names}\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n`;

const sh = (openssl, args, cwd, run) => {
  const r = run(openssl, args, { cwd, encoding: 'utf8', env: opensslEnv(cwd) });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${String(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
  return r.stdout;
};
const lock = (path) => { if (platform() !== 'win32') { try { chmodSync(path, 0o600); } catch {} } };

/**
 * Make (or renew) the CA and server certificate in `dir`. The CA is made once and kept; the server
 * certificate is reissued whenever this computer's addresses change, or it's near its end (30 days).
 * Returns { ca, cert, key, addresses, created: { ca, cert }, openssl }.
 */
export function ensureCerts({ dir, openssl = findOpenssl(), ips = privateAddresses(), name = hostname(), run = spawnSync, now = Date.now } = {}) {
  if (!openssl) throw new Error('openssl wasn’t found. Install Git for Windows (it includes one) or OpenSSL, then run this again.');
  if (!ips.length) throw new Error('No private network address found (192.168.x.x, 10.x.x.x, 172.16-31.x.x). Are you connected to your Wi-Fi or Ethernet?');
  mkdirSync(dir, { recursive: true });
  const p = (f) => join(dir, f);
  const created = { ca: false, cert: false };

  if (!existsSync(p('ca.pem')) || !existsSync(p('ca-key.pem'))) {
    sh(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca-key.pem', '-out', 'ca.pem', '-days', '3650',
      '-subj', '/CN=dotpals local CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash', '-addext', CONSTRAINTS], dir, run);
    lock(p('ca-key.pem'));
    created.ca = true;
  }

  const want = altNames(ips, name);
  let current = '';
  try { current = readFileSync(p('names.txt'), 'utf8'); } catch {}
  let aging = true;
  if (existsSync(p('cert.pem'))) {
    const r = run(openssl, ['x509', '-in', 'cert.pem', '-noout', '-checkend', String(30 * 86400)], { cwd: dir, encoding: 'utf8', env: opensslEnv(dir) });
    aging = r.status !== 0; // non-zero: it ends within 30 days
  }
  let matchingKey = false;
  try { matchingKey = new X509Certificate(readFileSync(p('cert.pem'))).checkPrivateKey(createPrivateKey(readFileSync(p('key.pem')))); } catch {}
  if (created.ca || aging || current !== want || !matchingKey) {
    writeFileSync(p('ext.cnf'), leafExtensions(want));
    try {
      sh(openssl, ['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'key.next.pem', '-out', 'leaf.csr', '-subj', '/CN=dotpals'], dir, run);
      lock(p('key.next.pem'));
      sh(openssl, ['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-set_serial', `0x${randomBytes(8).toString('hex')}`, '-out', 'cert.next.pem', '-days', '800', '-extfile', 'ext.cnf'], dir, run);
      renameSync(p('key.next.pem'), p('key.pem'));
      renameSync(p('cert.next.pem'), p('cert.pem'));
    } finally {
      rmSync(p('key.next.pem'), { force: true });
      rmSync(p('cert.next.pem'), { force: true });
    }
    writeFileSync(p('names.txt'), want);
    created.cert = true;
  }
  return { ca: p('ca.pem'), cert: p('cert.pem'), key: p('key.pem'), addresses: ips, created, openssl, issued: now() };
}
