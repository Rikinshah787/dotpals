// The one-click installers: site/install.ps1 and site/install.sh (served with the website),
// and the double-click wrappers in installers/. What can be checked on any system: they point at
// the published scripts, run `dotpals@latest setup`, parse, stay runnable, and get published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(root, file), 'utf8');
const SITE = 'https://dotpals.vercel.app/';

test('the install scripts run dotpals setup and link to troubleshooting', () => {
  for (const file of ['site/install.ps1', 'site/install.sh']) {
    const text = read(file);
    assert.match(text, /npx(\.Source)?\b.*--yes dotpals@latest setup/, file);
    assert.ok(text.includes(`${SITE}guide/troubleshooting.html#installer`), file);
  }
  assert.ok(read('site/install.ps1').includes(`irm ${SITE}install.ps1 | iex`));
  assert.ok(read('site/install.sh').includes(`curl -fsSL ${SITE}install.sh | bash`));
});

test('install.ps1 is plain ASCII, never exits the shell, and keeps Node on the PATH for every app', () => {
  const text = read('site/install.ps1');
  // irm decodes a script without a charset as Latin-1, so anything else would come out garbled.
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text), 'only ASCII characters');
  assert.doesNotMatch(text, /^\s*exit\b/m, '`exit` would close the window it was pasted into');
  assert.doesNotMatch(text, /^\s*param\s*\(/m);
  assert.match(text, /winget install --id OpenJS\.NodeJS\.LTS -e --silent --accept-source-agreements --accept-package-agreements/);
  assert.match(text, /GetEnvironmentVariable\('Path', 'Machine'\)/);
  assert.match(text, /GetEnvironmentVariable\('Path', 'User'\)/);
  assert.ok(text.includes('https://nodejs.org/dist/index.json'));
});

test('install.sh parses with bash', { skip: process.platform === 'win32' && 'bash may not be installed' }, () => {
  const r = spawnSync('bash', ['-n', join(root, 'site/install.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(read('site/install.sh'), /^set -euo pipefail$/m);
  assert.match(read('site/install.sh'), /^main "\$@"\n$/m, 'runs only once the whole script has arrived');
});

test('the double-click wrappers run the published scripts', () => {
  const bat = read('installers/dotpals-setup.bat');
  assert.match(bat, /powershell -NoProfile -ExecutionPolicy Bypass -Command ".*irm https:\/\/dotpals\.vercel\.app\/install\.ps1 \| iex/);
  assert.match(bat, /^pause\r?$/m);
  assert.match(bat, /^REM .*Windows protected your PC/m);
  const mac = read('installers/dotpals-setup.command');
  assert.ok(mac.includes(`curl -fsSL ${SITE}install.sh | bash`));
  assert.match(mac, /^read -r -p /m);
});

test('dotpals-setup.command is executable in git', () => {
  const r = spawnSync('git', ['ls-files', '-s', 'installers/dotpals-setup.command'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return; // not a git checkout (an npm tarball)
  assert.match(r.stdout, /^100755 /);
});

test('the website build publishes both install scripts', () => {
  const r = spawnSync(process.execPath, [join(root, 'site/build.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['install.ps1', 'install.sh']) {
    assert.equal(readFileSync(join(root, '_site', name), 'utf8'), read(`site/${name}`), name);
  }
  assert.ok(!existsSync(join(root, '_site', 'build.mjs')));
});
