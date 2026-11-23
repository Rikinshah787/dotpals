import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { createServer as createNet } from 'node:net';
import { connect } from 'node:tls';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteServer, hostAllowed, pairingUrl, servesTls } from '../bridge/remote-server.js';
import { ensureCerts, findOpenssl, localName } from '../bridge/remote-cert.js';

const openssl = findOpenssl();
const home = mkdtempSync(join(tmpdir(), 'dotpals-renew-'));
after(() => rmSync(home, { recursive: true, force: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Ports the system says are free, not a guess in a range other tests also use, and not "the one after it" either: on a CI
// runner that neighbour can already be taken, and then the server never starts (that failed the second test on Windows).
const freePort = () => new Promise((ok) => { const s = createNet().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => ok(p)); }); });
const port = await freePort();
const port2 = await freePort();

/** What certificate does a TLS client see on this port right now (trusting nothing: we only want to read it). */
const peerCert = (at = port) => new Promise((ok, no) => {
  const s = connect({ host: '127.0.0.1', port: at, rejectUnauthorized: false }, () => { const c = s.getPeerCertificate(); const raw = c.raw; s.end(); ok(new X509Certificate(raw)); });
  s.on('error', no);
});

test('.local names: cleaned like mDNS does, allowed as a Host only on the network', () => {
  assert.equal(localName('NIGHTHAWK'), 'nighthawk.local');
  assert.equal(localName("Vedant's MacBook Pro.local"), 'vedant-s-macbook-pro.local');
  assert.equal(localName('  '), null);
  assert.equal(localName('a'.repeat(80)), `${'a'.repeat(63)}.local`);
  const lan = { bind: 'lan', publicUrl: '' };
  assert.equal(hostAllowed('nighthawk.local:5176', lan, 'nighthawk.local'), true);
  assert.equal(hostAllowed('NightHawk.local.', lan, 'nighthawk.local'), true);
  assert.equal(hostAllowed('other.local', lan, 'nighthawk.local'), false);
  assert.equal(hostAllowed('nighthawk.local', { ...lan, bind: 'local' }, 'nighthawk.local'), false);
  assert.equal(hostAllowed('nighthawk.local.evil.com', lan, 'nighthawk.local'), false);
});

test('automatic https (tlsAuto) makes the pairing link https, with the address and with the name', () => {
  const auto = { bind: 'lan', port: 5176, publicUrl: '', tlsAuto: true, tlsCert: '', tlsKey: '' };
  assert.equal(servesTls(auto), true);
  assert.equal(pairingUrl(auto, 'X', ['192.168.1.69'], { own: 'nighthawk.local' }), 'https://192.168.1.69:5176/pair#X');
  assert.equal(pairingUrl(auto, 'X', ['192.168.1.69'], { name: true, own: 'nighthawk.local' }), 'https://nighthawk.local:5176/pair#X');
  assert.equal(pairingUrl({ ...auto, bind: 'local' }, 'X', ['192.168.1.69']), 'https://127.0.0.1:5176/pair#X');
  // The other ways to be https, and the ways not to be.
  assert.equal(servesTls({ tlsCert: 'c.pem', tlsKey: 'k.pem' }), true);
  assert.equal(servesTls({ tlsCert: 'c.pem', tlsKey: '' }), false);
  assert.equal(servesTls({ tlsAuto: false }), false);
  assert.equal(servesTls(undefined), false);
  assert.equal(pairingUrl({ ...auto, tlsAuto: false }, 'X', ['192.168.1.69']), 'http://192.168.1.69:5176/pair#X');
});

test('the pairing link carries the address by default and the name on request', () => {
  const cfg = { bind: 'lan', port: 5176, publicUrl: '', tlsAuto: false, tlsCert: 'c', tlsKey: 'k' };
  assert.equal(pairingUrl(cfg, 'X', ['192.168.1.69'], { own: 'nighthawk.local' }), 'https://192.168.1.69:5176/pair#X');
  assert.equal(pairingUrl(cfg, 'X', ['192.168.1.69'], { name: true, own: 'nighthawk.local' }), 'https://nighthawk.local:5176/pair#X');
  assert.equal(pairingUrl({ ...cfg, publicUrl: 'https://dp.example.com' }, 'X', ['192.168.1.69'], { name: true, own: 'x.local' }), 'https://dp.example.com/pair#X');
});

test('when the address changes, the running server serves a certificate for the new one, with no restart', { skip: !openssl && 'needs openssl' }, async (t) => {
  let ips = ['192.168.1.69'];
  const cfg = { enabled: true, bind: 'local', port, tlsAuto: true, tlsCert: '', tlsKey: '', publicUrl: '' };
  const logs = [];
  const server = createRemoteServer({
    config: () => cfg, file: () => join(home, 'remote.json'), certHome: home, root: process.cwd(), version: 't',
    api: () => {}, snapshot: () => {}, turn: () => null, log: (l) => logs.push(l),
    renewMs: 40, addressesNow: () => ips, certs: (o) => ensureCerts({ ...o, openssl, name: 'NIGHTHAWK' }),
  });
  t.after(() => server.stop());
  await server.apply();
  assert.equal(server.state().running, true, server.state().error ?? '');
  // What the computer-side API hands the pairing screen: a link that matches what's being served.
  const reply = { status: 0, body: null };
  const json = (res, status, body) => { reply.status = status; reply.body = body; };
  await server.controlApi({ method: 'POST', url: '/api/remote/pair' }, {}, '/api/remote/pair', { json, readBody: async () => '{}' });
  assert.equal(reply.status, 200);
  assert.match(reply.body.url, /^https:\/\//, 'the QR link is https when the server is');
  assert.equal(reply.body.secure, true);
  const first = await peerCert();
  assert.match(first.subjectAltName, /IP Address:192\.168\.1\.69/);
  assert.match(first.subjectAltName, /DNS:nighthawk\.local/);
  assert.doesNotMatch(first.subjectAltName, /10\.0\.0\.7/);

  ips = ['192.168.1.69', '10.0.0.7']; // a new lease arrives
  let second;
  for (let i = 0; i < 200; i++) { await wait(100); second = await peerCert(); if (/10\.0\.0\.7/.test(second.subjectAltName)) break; }
  assert.match(second.subjectAltName, /IP Address:10\.0\.0\.7/, 'the new address is covered');
  assert.notEqual(second.fingerprint256, first.fingerprint256, 'a different certificate');
  assert.equal(second.checkIssued(new X509Certificate(readFileSync(join(home, 'remote-cert', 'ca.pem')))), true, 'issued by the same CA');
  assert.equal(second.verify(new X509Certificate(readFileSync(join(home, 'remote-cert', 'ca.pem'))).publicKey), true, 'still signed by the same CA');
  assert.ok(logs.some((l) => /certificate renewed/.test(l)));
  assert.equal(server.state().error, null);

  ips = []; // the network drops for a moment: keep serving what we have
  await wait(200);
  assert.equal((await peerCert()).fingerprint256, second.fingerprint256);
  await server.stop();
});

test('a rejected TLS context keeps the old certificate and retries the same address', { skip: !openssl && 'needs openssl' }, async (t) => {
  let ips = ['192.168.1.69'];
  let broken = false;
  const invalidKey = join(home, 'invalid.pem');
  writeFileSync(invalidKey, 'not a PEM key');
  const cfg = { enabled: true, bind: 'lan', port: port2, tlsAuto: true, tlsCert: '', tlsKey: '', publicUrl: '' };
  const server = createRemoteServer({
    config: () => cfg, file: () => join(home, 'remote2.json'), certHome: home, root: process.cwd(), version: 't',
    api: () => {}, snapshot: () => {}, turn: () => null,
    renewMs: 40, addressesNow: () => ips, certs: (o) => {
      const made = ensureCerts({ ...o, openssl, name: 'NIGHTHAWK' });
      return broken ? { ...made, key: invalidKey } : made;
    },
  });
  t.after(() => server.stop());
  await server.apply();
  assert.equal(server.state().running, true);
  const first = await peerCert(port2);
  broken = true;
  ips = ['192.168.1.99'];
  for (let i = 0; i < 30 && !server.state().error; i++) await wait(50);
  assert.match(server.state().error, /Couldn’t renew the certificate/);
  assert.equal(server.state().addresses, '192.168.1.69');
  assert.equal((await peerCert(port2)).fingerprint256, first.fingerprint256);
  const pair = () => server.controlApi({ method: 'POST' }, {}, '/api/remote/pair', { json: (_, status, body) => ({ status, body }), readBody: async () => '{}' });
  assert.equal((await pair()).status, 409);
  broken = false;
  for (let i = 0; i < 60 && server.state().error; i++) await wait(50);
  assert.equal(server.state().error, null);
  assert.equal(server.state().addresses, '192.168.1.99');
  assert.match((await peerCert(port2)).subjectAltName, /IP Address:192\.168\.1\.99/);
  assert.match((await pair()).body.url, /^https:\/\/192\.168\.1\.99:/);
});
