// dotpals.app on macOS (desktop/mac-app.js), with the Mac swapped out: the exact commands that make
// it, the command's answer on other systems, and the LaunchAgent that opens dotpals at login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMacApp, bundleVersion, electronDist, loginAgentFile, loginAgentOn, loginAgentPlist, setLoginAgent } from '../desktop/mac-app.js';
import { openMacApp } from '../desktop/launch.js';

const script = fileURLToPath(new URL('../desktop/mac-app.js', import.meta.url));
const icon = fileURLToPath(new URL('../desktop/icon.png', import.meta.url));
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'dotpals-mac-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

/** A pretend Mac: records each command; `fail(cmd, args)` says which one fails. ditto makes the folder, like the real one. */
function mac(fail = () => false) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'ditto') mkdirSync(args[1], { recursive: true });
    return fail(cmd, args) ? { status: 1, stderr: `${cmd}: no\n` } : { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('Making dotpals.app copies Electron.app, names it dotpals, gives it the icon, signs it ad hoc and checks the signature', (t) => {
  const dist = join(temp(t), 'dist');
  const dest = join(temp(t), 'dotpals.app');
  const { calls, run } = mac();
  assert.equal(buildMacApp({ electronDist: dist, dest, run }), dest);
  const plist = join(dest, 'Contents', 'Info.plist');
  assert.deepEqual(calls, [
    ['ditto', join(dist, 'Electron.app'), dest],
    ['plutil', '-replace', 'CFBundleName', '-string', 'dotpals', plist],
    ['plutil', '-replace', 'CFBundleDisplayName', '-string', 'dotpals', plist],
    ['plutil', '-replace', 'CFBundleIdentifier', '-string', 'dev.dotpals.desktop', plist],
    ['plutil', '-replace', 'LSUIElement', '-bool', 'YES', plist],
    ['plutil', '-replace', 'NSAppleEventsUsageDescription', '-string', 'When you ask, dotpals moves windows, presses keys, pastes what you dictate and controls music in your other apps.', plist],
    ['plutil', '-replace', 'NSMicrophoneUsageDescription', '-string', 'dotpals listens only while you use Talk or Dictate.', plist],
    ['sips', '-s', 'format', 'icns', icon, '--out', join(dest, 'Contents', 'Resources', 'electron.icns')],
    ['xattr', '-cr', dest],
    ['codesign', '--force', '--deep', '--sign', '-', dest],
    ['codesign', '--verify', '--deep', '--strict', dest],
  ]);
  assert.ok(existsSync(dest));
});

test('A failed step stops the build, says which command failed, and leaves no half-made app', (t) => {
  const dest = join(temp(t), 'dotpals.app');
  const { calls, run } = mac((cmd, args) => cmd === 'codesign' && args.includes('--sign'));
  assert.throws(() => buildMacApp({ electronDist: '/x/dist', dest, run }), /^Error: codesign failed: codesign: no$/);
  assert.ok(!calls.some((c) => c.includes('--verify')), 'nothing runs after the failed step');
  assert.ok(!existsSync(dest));
});

test('The icon is only looks: when sips fails, dotpals.app is still made', (t) => {
  const dest = join(temp(t), 'dotpals.app');
  const { calls, run } = mac((cmd) => cmd === 'sips');
  assert.equal(buildMacApp({ electronDist: '/x/dist', dest, run }), dest);
  assert.deepEqual(calls.at(-1), ['codesign', '--verify', '--deep', '--strict', dest]);
});

test('Making it again starts from a clean copy', (t) => {
  const dest = join(temp(t), 'dotpals.app');
  mkdirSync(join(dest, 'Contents', 'old'), { recursive: true });
  const { run } = mac();
  buildMacApp({ electronDist: '/x/dist', dest, run });
  assert.ok(!existsSync(join(dest, 'Contents', 'old')));
});

test('The Electron version an app holds comes from its CFBundleVersion, and is empty when there is no app', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return /there/.test(args.at(-1)) ? { status: 0, stdout: '44.5.1\n' } : { status: 1, stdout: '', stderr: 'no file' }; };
  assert.equal(bundleVersion('/there/dotpals.app', run), '44.5.1');
  assert.deepEqual(calls[0], ['plutil', '-extract', 'CFBundleVersion', 'raw', '-o', '-', join('/there/dotpals.app', 'Contents', 'Info.plist')]);
  assert.equal(bundleVersion('/missing/dotpals.app', run), '');
});

test('Electron.app\'s folder is found from the path to its executable', () => {
  assert.equal(electronDist('/Users/me/.dotpals/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), '/Users/me/.dotpals/node_modules/electron/dist');
});

test('Run as a command anywhere but macOS, it says dotpals.app is macOS-only, makes nothing and exits 0', { skip: process.platform === 'darwin' }, (t) => {
  const dest = join(temp(t), 'dotpals.app');
  const r = spawnSync(process.execPath, [script, dest], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /macOS only/);
  assert.ok(!existsSync(dest));
});

test('Anywhere but macOS, the pal starts on Electron as before, not through open', { skip: process.platform === 'darwin' }, () => {
  assert.equal(openMacApp('/app/desktop/main.js', ['--dashboard']), false);
});

test('The LaunchAgent starts the app\'s executable with main.js when you log in', () => {
  const plist = loginAgentPlist('/Users/me/.dotpals/dotpals.app/Contents/MacOS/Electron', '/Users/me/.dotpals/app/desktop/main.js');
  assert.match(plist, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1.0\/\/EN"/);
  assert.match(plist, /<key>Label<\/key>\s*<string>dev\.dotpals\.desktop<\/string>/);
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/me\/\.dotpals\/dotpals\.app\/Contents\/MacOS\/Electron<\/string>\s*<string>\/Users\/me\/\.dotpals\/app\/desktop\/main\.js<\/string>\s*<\/array>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /KeepAlive/, 'quitting dotpals keeps it quit');
  // Paths are XML text.
  assert.match(loginAgentPlist('/a & b/<x>', '/m'), /<string>\/a &amp; b\/&lt;x&gt;<\/string>/);
});

test('Opening at login writes the LaunchAgent in ~/Library/LaunchAgents, and turning it off removes it', (t) => {
  const home = temp(t);
  const file = join(home, 'Library', 'LaunchAgents', 'dev.dotpals.desktop.plist');
  assert.equal(loginAgentFile(home), file);
  assert.equal(loginAgentOn(home), false);
  const exe = '/Users/me/.dotpals/dotpals.app/Contents/MacOS/Electron';
  const main = '/Users/me/.dotpals/app/desktop/main.js';
  assert.equal(setLoginAgent(true, { exe, main, home }), true);
  assert.equal(readFileSync(file, 'utf8'), loginAgentPlist(exe, main));
  assert.equal(loginAgentOn(home), true);
  assert.equal(setLoginAgent(false, { home }), false);
  assert.ok(!existsSync(file));
  assert.equal(setLoginAgent(false, { home }), false, 'turning it off twice is fine');
});
