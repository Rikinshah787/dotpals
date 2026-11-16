import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeWrapper, packagedExe, packagedRuntime, wrappers, writeRuntime } from '../bridge/runtime.js';
import { hookCommand } from '../bridge/adapters/setup.js';

function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dotpals-runtime-'));
  const before = process.env.DOTPALS_HOME;
  process.env.DOTPALS_HOME = dir;
  try { return fn(dir); } finally {
    if (before === undefined) delete process.env.DOTPALS_HOME; else process.env.DOTPALS_HOME = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('wrappers (macOS, Linux): quote the app’s path, run it as Node, and skip quietly when a script is gone', () => {
  const w = wrappers({ exe: "/Apps/it's/dotpals", app: '/Apps/app', platform: 'darwin' });
  assert.deepEqual(Object.keys(w), ['dotpals-node', 'dotpals']);
  assert.match(w['dotpals-node'], /^#!\/bin\/sh\n/);
  assert.ok(w['dotpals-node'].includes(`'/Apps/it'\\''s/dotpals'`));
  assert.match(w['dotpals-node'], /\[ -f "\$1" \] \|\| exit 0/);
  assert.match(w['dotpals-node'], /\[ -x '.*' \] \|\| \{ command -v node >\/dev\/null 2>&1 && exec node "\$@"; exit 0; \}/);
  assert.match(w['dotpals-node'], /ELECTRON_RUN_AS_NODE=1 exec '.*' "\$@"/);
  assert.match(w.dotpals, /'\/Apps\/app\/bin\/dotpals\.js' "\$@"/);
});

test('wrappers (Windows): .cmd files with CRLF, % doubled, and hook paths with forward slashes checked', () => {
  const w = wrappers({ exe: 'C:\\Users\\a%b\\dotpals\\dotpals.exe', app: 'C:\\Users\\a%b\\dotpals\\resources\\app', platform: 'win32' });
  assert.deepEqual(Object.keys(w), ['dotpals-node.cmd', 'dotpals.cmd']);
  for (const text of Object.values(w)) {
    assert.ok(text.startsWith('@echo off\r\nsetlocal\r\n'), 'setlocal: nothing it sets leaks into the window that ran it');
    assert.ok(!/[^\r]\n/.test(text), 'every line ends in CRLF');
    assert.ok(text.includes('a%%b'), 'a % in the path is doubled');
    assert.match(text, /set ELECTRON_RUN_AS_NODE=1/);
    assert.match(text, /exit \/b %errorlevel%/);
  }
  assert.ok(w['dotpals-node.cmd'].includes('if not exist "%DOTPALS_SCRIPT:/=\\%" exit /b 0'));
  for (const text of Object.values(w)) assert.ok(!/\([^)]*%errorlevel%/.test(text), 'no %errorlevel% inside ( ): cmd reads it before the command runs');
});

test('writeRuntime: runtime.json and the scripts; nodeWrapper only while the app is still there', () => withHome((dir) => {
  assert.equal(packagedRuntime(), null);
  assert.equal(nodeWrapper(), null);
  const exe = join(dir, 'fake-app');
  writeFileSync(exe, '');
  writeRuntime({ exe, app: dir, version: '9.9.9' });
  assert.deepEqual(packagedRuntime(), { exe, app: dir, version: '9.9.9' });
  assert.equal(packagedExe(), exe);
  assert.equal(nodeWrapper(), join(dir, 'bin', process.platform === 'win32' ? 'dotpals-node.cmd' : 'dotpals-node'));
  rmSync(exe);
  assert.equal(packagedExe(), null, 'the app was uninstalled');
  assert.equal(nodeWrapper(), null, 'so hooks go back to plain node');
}));

test('hookCommand: plain node without the app; the app’s dotpals-node with it (and `&` for PowerShell on Windows)', () => {
  assert.match(hookCommand('cursor', { node: null }), /^node ".*\/bridge\/hook\.js" cursor$/);
  assert.match(hookCommand('cursor', { node: '/Users/a/.dotpals/bin/dotpals-node', platform: 'darwin' }), /^"\/Users\/a\/\.dotpals\/bin\/dotpals-node" ".*\/bridge\/hook\.js" cursor$/);
  assert.match(hookCommand('gemini', { node: 'C:\\Users\\a\\.dotpals\\bin\\dotpals-node.cmd', platform: 'win32' }), /^& "C:\/Users\/a\/\.dotpals\/bin\/dotpals-node\.cmd" ".*\/bridge\/hook\.js" gemini$/);
});

test('dotpals-node (sh) runs the script with its arguments and stdin, keeps its exit code, and falls back to Node (or nothing) when the app is gone', { skip: process.platform === 'win32' }, () => withHome((dir) => {
  writeRuntime({ exe: process.execPath, app: dir, version: '1.0.0' });
  const script = join(dir, 'echo.js');
  writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.stringify([process.argv.slice(2),s,process.env.ELECTRON_RUN_AS_NODE]));process.exit(3)})");
  const wrapper = nodeWrapper();
  const r = spawnSync(wrapper, [script, 'cursor', 'a b'], { input: '{"x":1}', encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.deepEqual(JSON.parse(r.stdout), [['cursor', 'a b'], '{"x":1}', '1']);
  assert.equal(spawnSync(wrapper, [join(dir, 'gone.js')]).status, 0, 'a script that is gone: quiet success');
  writeRuntime({ exe: join(dir, 'no-such-app'), app: dir, version: '1.0.0' });
  const gone = join(dir, 'bin', 'dotpals-node');
  const nodeDir = join(dir, 'node-bin'); // a PATH whose only node is this test's
  mkdirSync(nodeDir);
  symlinkSync(process.execPath, join(nodeDir, 'node'));
  const viaNode = spawnSync(gone, [script, 'x'], { input: '', encoding: 'utf8', env: { PATH: `${nodeDir}:/usr/bin:/bin` } });
  assert.equal(viaNode.status, 3, 'an app that is gone, with Node: the script runs on Node');
  assert.deepEqual(JSON.parse(viaNode.stdout)[0], ['x']);
  assert.equal(spawnSync(gone, [script], { env: { PATH: join(dir, 'empty') } }).status, 0, 'an app that is gone, no Node: quiet success');
}));
