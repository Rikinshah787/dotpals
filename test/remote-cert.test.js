import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { altNames, certDir, ensureCerts, findOpenssl, leafExtensions, privateAddresses } from '../bridge/remote-cert.js';

const openssl = findOpenssl();
const tmp = mkdtempSync(join(tmpdir(), 'dotpals-cert-'));
after(() => rm());
const rm = () => rmSync(tmp, { recursive: true, force: true });

test('private addresses only: Wi-Fi and Ethernet ranges, not loopback, link-local or public', () => {
  const nic = (address, internal = false) => ({ family: 'IPv4', address, internal });
  const got = privateAddresses({ a: [nic('192.168.1.69'), nic('127.0.0.1', true), nic('169.254.9.9'), nic('8.8.8.8')], b: [nic('10.1.2.3'), nic('172.16.5.5'), nic('172.32.0.1'), { family: 'IPv6', address: 'fe80::1', internal: false }] });
  assert.deepEqual(got, ['192.168.1.69', '10.1.2.3', '172.16.5.5']);
  assert.equal(altNames(['192.168.1.69'], 'NightHawk'), 'IP:192.168.1.69,IP:127.0.0.1,DNS:nighthawk.local,DNS:localhost');
});

test('without openssl or an address it says what to do, and writes nothing', () => {
  assert.throws(() => ensureCerts({ dir: join(tmp, 'a'), openssl: null, ips: ['192.168.1.5'] }), /openssl wasn’t found/);
  assert.throws(() => ensureCerts({ dir: join(tmp, 'b'), openssl: 'openssl', ips: [] }), /No private network address/);
  assert.equal(existsSync(join(tmp, 'a', 'ca.pem')), false);
  assert.equal(certDir('/h'), join('/h', 'remote-cert'));
});

test('an openssl failure is reported, not swallowed', () => {
  const run = () => ({ status: 1, stdout: '', stderr: 'boom: bad config\n' });
  assert.throws(() => ensureCerts({ dir: join(tmp, 'c'), openssl: 'x', ips: ['192.168.1.5'], run }), /openssl req failed: boom: bad config/);
});

test('a real CA and server certificate: chain verifies, names and constraints are right', { skip: !openssl && 'needs openssl' }, () => {
  const dir = join(tmp, 'real');
  const made = ensureCerts({ dir, openssl, ips: ['192.168.1.69'], name: 'NIGHTHAWK' });
  assert.deepEqual(made.created, { ca: true, cert: true });
  const ca = new X509Certificate(readFileSync(made.ca));
  const leaf = new X509Certificate(readFileSync(made.cert));
  assert.equal(leaf.verify(ca.publicKey), true);
  assert.equal(ca.ca, true);
  assert.match(leaf.subjectAltName, /IP Address:192\.168\.1\.69/);
  assert.match(leaf.subjectAltName, /DNS:nighthawk\.local/);
  assert.equal(leaf.checkIP('192.168.1.69'), '192.168.1.69');
  assert.equal(leaf.checkIP('192.168.1.70'), undefined);
  assert.equal(leaf.checkHost('evil.com'), undefined);
  assert.ok(new Date(leaf.validTo) - Date.now() > 700 * 86400_000, 'about 800 days');
  assert.ok(new Date(leaf.validTo) - Date.now() < 810 * 86400_000);
  const text = spawnSync(openssl, ['x509', '-in', made.ca, '-noout', '-text'], { encoding: 'utf8' }).stdout;
  assert.match(text, /Name Constraints: critical/);
  assert.match(text, /IP:192\.168\.0\.0\/255\.255\.0\.0/);
  assert.doesNotMatch(text, /DNS:com|DNS:\.com/);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'ca-key.pem')).mode & 0o777, 0o600);
});

test('the CA cannot vouch for a public name (name constraints, checked by openssl)', { skip: !openssl && 'needs openssl' }, () => {
  const dir = join(tmp, 'real');
  const sign = (alt, tag) => {
    writeFileSync(join(dir, `${tag}.cnf`), leafExtensions(alt));
    spawnSync(openssl, ['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${tag}.key`, '-out', `${tag}.csr`, '-subj', '/CN=x'], { cwd: dir });
    spawnSync(openssl, ['x509', '-req', '-in', `${tag}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-set_serial', '0x1234', '-out', `${tag}.pem`, '-days', '5', '-extfile', `${tag}.cnf`], { cwd: dir });
    return spawnSync(openssl, ['verify', '-CAfile', 'ca.pem', '-x509_strict', `${tag}.pem`], { cwd: dir, encoding: 'utf8' });
  };
  const good = sign('IP:192.168.4.4', 'good');
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const bad = sign('DNS:www.paypal.com', 'bad');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /permitted subtree violation/);
  const badIp = sign('IP:8.8.8.8', 'badip');
  assert.notEqual(badIp.status, 0);
});

test('running it again keeps the CA, and reissues the server certificate only when the addresses change', { skip: !openssl && 'needs openssl' }, () => {
  const dir = join(tmp, 'real');
  const caBefore = readFileSync(join(dir, 'ca.pem'), 'utf8');
  const certBefore = readFileSync(join(dir, 'cert.pem'), 'utf8');
  const same = ensureCerts({ dir, openssl, ips: ['192.168.1.69'], name: 'NIGHTHAWK' });
  assert.deepEqual(same.created, { ca: false, cert: false });
  assert.equal(readFileSync(join(dir, 'cert.pem'), 'utf8'), certBefore);
  const moved = ensureCerts({ dir, openssl, ips: ['192.168.1.69', '10.0.0.7'], name: 'NIGHTHAWK' });
  assert.deepEqual(moved.created, { ca: false, cert: true });
  assert.equal(readFileSync(join(dir, 'ca.pem'), 'utf8'), caBefore, 'phones that trust the CA keep working');
  assert.match(new X509Certificate(readFileSync(moved.cert)).subjectAltName, /10\.0\.0\.7/);
  assert.equal(new X509Certificate(readFileSync(moved.cert)).verify(new X509Certificate(readFileSync(moved.ca)).publicKey), true);
});
