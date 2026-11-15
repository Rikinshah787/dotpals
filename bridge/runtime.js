// The dotpals app (the .exe and .dmg) brings its own runtime: there may be no Node on the computer.
// Each time it starts it writes where it is to ~/.dotpals/runtime.json, and two small scripts to
// ~/.dotpals/bin, so what other tools run (hooks, the dotpals command) runs on the app itself,
// as Node (ELECTRON_RUN_AS_NODE, the way VS Code runs its own command line):
//
//   dotpals-node <script> [args]   run one of dotpals' scripts (what agents' hooks call)
//   dotpals <command>              the dotpals command (bin/dotpals.js)
//
// When the app is gone (uninstalled), dotpals-node runs the script with Node if there is one, and
// otherwise does nothing and succeeds, as it does when the script is gone: a hook left behind never
// gets in an agent's way.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './config.js';

export const runtimeFile = () => join(home(), 'runtime.json');
export const binDir = () => join(home(), 'bin');

/** What the app wrote: { exe, app, version }, or null when it isn't installed (or was removed). */
export function packagedRuntime() {
  try {
    const r = JSON.parse(readFileSync(runtimeFile(), 'utf8'));
    return r?.exe && existsSync(r.exe) ? r : null;
  } catch { return null; }
}

/** The app's executable, when it's installed. */
export const packagedExe = () => packagedRuntime()?.exe ?? null;

/** dotpals-node, when the app is installed: commands written into other tools run it instead of `node`. */
export function nodeWrapper(platform = process.platform) {
  const file = join(binDir(), platform === 'win32' ? 'dotpals-node.cmd' : 'dotpals-node');
  return packagedExe() && existsSync(file) ? file : null;
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // a single-quoted sh word
const pct = (s) => String(s).replace(/%/g, '%%'); // cmd expands %…% even inside quotes

/** The two scripts' names and contents for `exe` (the app) and `app` (its folder, holding bin/dotpals.js). */
export function wrappers({ exe, app, platform = process.platform }) {
  const cli = join(app, 'bin', 'dotpals.js');
  if (platform === 'win32') {
    // setlocal: what it sets stays in here, not in the window that ran it.
    const head = '@echo off\r\nsetlocal\r\nrem Made by the dotpals app each time it starts. Runs dotpals\' scripts on the app itself.\r\n';
    return {
      // Hooks pass the script with forward slashes, which `if exist` doesn't take. The app gone: Node, if there is one.
      'dotpals-node.cmd': `${head}set "DOTPALS_SCRIPT=%~1"\r\nif not exist "%DOTPALS_SCRIPT:/=\\%" exit /b 0\r\nif not exist "${pct(exe)}" (\r\n  where node >nul 2>nul || exit /b 0\r\n  node %*\r\n  exit /b %errorlevel%\r\n)\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${pct(exe)}" %*\r\nexit /b %errorlevel%\r\n`,
      'dotpals.cmd': `${head}if not exist "${pct(exe)}" (echo The dotpals app isn't installed any more. & exit /b 1)\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${pct(exe)}" "${pct(cli)}" %*\r\nexit /b %errorlevel%\r\n`,
    };
  }
  const head = '#!/bin/sh\n# Made by the dotpals app each time it starts. Runs dotpals\' scripts on the app itself.\n';
  return {
    // The app gone: Node, if there is one; otherwise nothing.
    'dotpals-node': `${head}[ -f "$1" ] || exit 0\n[ -x ${sq(exe)} ] || { command -v node >/dev/null 2>&1 && exec node "$@"; exit 0; }\nELECTRON_RUN_AS_NODE=1 exec ${sq(exe)} "$@"\n`,
    dotpals: `${head}[ -x ${sq(exe)} ] || { echo "The dotpals app isn't installed any more." >&2; exit 1; }\nELECTRON_RUN_AS_NODE=1 exec ${sq(exe)} ${sq(cli)} "$@"\n`,
  };
}

/** Write runtime.json and the scripts (the app does, each time it starts: it may have moved). */
export function writeRuntime({ exe, app, version, platform = process.platform }) {
  mkdirSync(binDir(), { recursive: true });
  for (const [name, text] of Object.entries(wrappers({ exe, app, platform }))) {
    const file = join(binDir(), name);
    writeFileSync(file, text);
    chmodSync(file, 0o755);
  }
  writeFileSync(runtimeFile(), `${JSON.stringify({ exe, app, version }, null, 2)}\n`);
}
