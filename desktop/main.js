// dotpals desktop: the live pal in a small always-on-top window, so it floats
// above your editor without a browser tab. Starts the bridge if it isn't running.
//
//   npm run float        (or `node desktop/launch.js`)
//
// Closing hides it to the tray; Ctrl+Alt+P (Cmd+Option+P on macOS) shows or
// hides it from anywhere. Quit from the tray menu.
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, shell, systemPreferences, Tray } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, readFileSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../bridge/server.js';
import { configPath, home, loadConfig, saveConfig } from '../bridge/config.js';
import { readUsage } from '../bridge/usage.js';
import { action } from '../bridge/buddy.js';
import { createHands } from './hands.js';
import { loginAgentOn, setLoginAgent } from './mac-app.js';

const port = Number(process.env.DOTPALS_PORT || process.env.PORT) || 5175;
const bridge = `http://127.0.0.1:${port}`;
const page = fileURLToPath(new URL('../bridge/index.html', import.meta.url));
const notchPage = fileURLToPath(new URL('../bridge/notch.html', import.meta.url));
const SIZE = { compact: { width: 260, height: 290 }, full: { width: 380, height: 600 } };
const MARGIN = 16;
const TALK_EXTRA = 190; // small mode: extra height above the pal for the chat bubble
const SHORTCUT = 'CommandOrControl+Alt+P';
// Talk (in the notch): your own (talkShortcut in the settings), else the first of these that's free.
// Not Ctrl+Alt+Space: the Claude app uses it.
const TALK_SHORTCUTS = ['CommandOrControl+Shift+Space', 'CommandOrControl+Alt+T', 'CommandOrControl+Alt+Shift+T'];
// Dictate: your own (dictateShortcut in the settings), else the first of these that's free.
// Control, not Command, on macOS too: ⌘⌥D hides the Dock.
const DICTATE_SHORTCUTS = ['Control+Alt+D', 'Control+Alt+Shift+D'];
// Circle something on screen and ask Blu about it: your own (circleShortcut), else the first that's free.
const CIRCLE_SHORTCUTS = ['Control+Alt+C', 'Control+Alt+Shift+C'];
const icon = nativeImage.createFromPath(fileURLToPath(new URL('./icon.png', import.meta.url)));

app.setName('dotpals');
// Linux needs this for a see-through window (Windows and macOS don't).
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');
app.setAppUserModelId?.('dev.dotpals.desktop'); // Windows shows notifications only for apps with an id

// A bug in a handler shouldn't pop up an error dialog over your editor; log it instead.
process.on('uncaughtException', (err) => console.error('[dotpals]', err));

if (!app.requestSingleInstanceLock()) {
  // The running copy gets our arguments (its 'second-instance' handler); nothing else to do here.
  app.exit(0);
} else {
  const prefsFile = join(app.getPath('userData'), 'window.json');
  let prefs = {};
  try { prefs = JSON.parse(readFileSync(prefsFile, 'utf8')); } catch {}
  const savePrefs = () => { try { writeFileSync(prefsFile, JSON.stringify(prefs)); } catch {} };

  let win;
  let tray;
  let quitting = false;
  const following = new Map(); // webContents id → stop()

  const show = () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
  };
  const toggle = () => (win?.isVisible() ? win.hide() : show());

  // Launching it again (e.g. `npm run float`, `dotpals dashboard`) brings the running one back.
  app.on('second-instance', (_, argv) => {
    show();
    handleArgs(argv);
  });

  // Flags from `dotpals setup` / `dotpals dashboard`.
  function handleArgs(argv) {
    if (argv.includes('--open-at-login')) openAtLogin(true);
    if (argv.includes('--dashboard')) openDashboard();
    if (argv.includes('--notch')) setNotchMode('always');
    if (argv.includes('--notch-auto')) setNotchMode('auto');
    if (argv.includes('--no-notch')) setNotchMode('off');
  }
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(async () => {
    // Run the bridge in this process, unless one is already running.
    try {
      await startBridge({ port, log: () => {}, onQuit: () => app.quit() });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') console.error('[dotpals] bridge failed to start:', err.message);
    }
    app.dock?.hide(); // macOS: a floating widget with a menu-bar icon, not a Dock app
    // Tray → Greet me when dotpals starts (or --start-mini): start as just the pal.
    if (process.argv.includes('--start-mini') || greets()) prefs.compact = true;
    createWindow();
    win.on('show', keepOnScreen);
    win.on('resize', () => setTimeout(keepOnScreen, 50));
    createTray();
    syncNotch();
    handleArgs(process.argv);
    if (!globalShortcut.register(SHORTCUT, toggle)) console.warn(`[dotpals] ${SHORTCUT} is taken by another app`);
    registerTalkShortcut();
    registerDictateShortcut();
    registerCircleShortcut();
    watchShortcuts();
    watchCursor();
  });

  // Hidden to the tray isn't "all closed"; only Quit ends the app.
  app.on('window-all-closed', () => { if (quitting) app.quit(); });

  // When run as electron.exe + main.js (npm run float, setup), log-in needs the script too.
  const loginItem = () => (app.isPackaged ? {} : { path: process.execPath, args: [fileURLToPath(import.meta.url)] });
  // macOS ignores that path and those args (its login item would open Electron bare): a LaunchAgent starts dotpals there.
  const opensAtLogin = () => (process.platform === 'darwin' ? loginAgentOn() : app.getLoginItemSettings(loginItem()).openAtLogin);
  function openAtLogin(on) {
    if (process.platform === 'darwin') return setLoginAgent(on, { exe: process.execPath, main: fileURLToPath(import.meta.url) });
    app.setLoginItemSettings({ ...loginItem(), openAtLogin: on });
    return on;
  }

  // The start-of-day greeting ("what are we working on today?") and its folder picker.
  // Shown once the pal loads when Tray → Greet me when dotpals starts is on (off by
  // default), or with --greet; any time from the tray's "Start working…".
  // Only with chat on (Dashboard → Settings → Chat with your agents): the greeting starts a chat.
  function greets() { const c = loadConfig(); return !!(c.chat && c.greetOnStart); }
  let helloPending = process.argv.includes('--greet') || greets();
  const sayHello = () => { show(); win?.webContents.send('window:hello'); };
  /** Change a setting through the bridge, so the pal and the dashboard hear about it. */
  const setConfig = (patch) => fetch(`${bridge}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(patch) }).catch(() => {});
  ipcMain.handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a project folder', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ipcMain.handle('login:get', () => opensAtLogin());
  ipcMain.handle('login:set', (_, on) => openAtLogin(!!on));

  // The dashboard: sessions, logs, stats and settings, in a normal window.
  let dashboard;
  // `at`: a place in it ("settings/apps"), from the notch's buttons.
  function openDashboard(at) {
    const hash = typeof at === 'string' && /^[\w/-]{1,40}$/.test(at) ? at : '';
    if (dashboard && !dashboard.isDestroyed()) { if (hash) dashboard.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {}); dashboard.show(); dashboard.focus(); return; }
    dashboard = new BrowserWindow({
      width: 1180, height: 820, minWidth: 420, minHeight: 480,
      title: 'dotpals dashboard', icon, backgroundColor: '#0b0b0e', autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    dashboard.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|vscode|cursor):/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    dashboard.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(bridge)) { e.preventDefault(); if (/^(https?|vscode|cursor):/i.test(url)) shell.openExternal(url); }
    });
    dashboard.loadURL(`${bridge}/dashboard${hash ? `#${hash}` : ''}`);
  }
  ipcMain.on('dashboard:open', (_, at) => openDashboard(at));

  // Talk (the notch's Talk tab): the shortcut shows the notch and it listens. It takes a
  // screenshot first, of what you were looking at before the notch opens over it; it stays on
  // this computer unless what you say is about the screen (then Blu's brain looks at it).
  // Held while you talk (Windows): Blu listens until you let go, pauses and all; tapped, until you pause.
  let talkDown = 0;
  async function talkInNotch() {
    if (talkDown) return; // the shortcut repeating while you hold it
    talkDown = Date.now();
    // Only Windows can tell how long the key is held (keys.released): elsewhere every press is a tap.
    const held = process.platform === 'win32' && vkOf(talkShortcut) ? setTimeout(() => { if (talkDown) toNotch('notch:key', 'talk-hold'); }, HOLD) : null;
    keys.released(talkShortcut).then((ms) => {
      talkDown = 0;
      clearTimeout(held);
      if (ms > HOLD) toNotch('notch:key', 'talk-release');
    });
    const shot = loadConfig().blu?.see !== false ? await Promise.race([takeShot(), new Promise((r) => setTimeout(() => r(null), 1500))]) : null;
    createNotch();
    const go = () => { notch?.webContents.send('notch:key', 'talk'); notch?.webContents.send('notch:talk-shot', shot); };
    if (notch.webContents.isLoading()) notch.webContents.once('did-finish-load', () => setTimeout(go, 300)); else go();
  }
  let talkShortcut = null; // the one that's registered
  function registerTalkShortcut() {
    talkShortcut = registerShortcut('Talk', loadConfig().talkShortcut, TALK_SHORTCUTS, talkInNotch);
  }
  /**
   * Your own shortcut for `what` (Settings → Shortcuts), else the first of `defaults` that's
   * free; when yours is taken by another app, a notification says so. → the one registered, or null.
   */
  function registerShortcut(what, own, defaults, fn) {
    let got = null;
    for (const key of [...(own ? [own] : []), ...defaults]) {
      try { if (globalShortcut.register(key, fn)) { got = key; break; } } catch {}
      console.warn(`[dotpals] ${key} is taken by another app`);
    }
    if (own && got !== own && Notification.isSupported()) new Notification({ title: 'dotpals', body: `${own} is taken by another app. ${what} is on ${got ?? 'no shortcut'} for now (Dashboard → Settings → Shortcuts).`, icon, silent: true }).show();
    setTimeout(writeShortcuts, 0); // once the caller has it
    return got;
  }
  /** The shortcuts that work right now, for Settings and the notch (GET /api/shortcuts). */
  function writeShortcuts() {
    try { writeFileSync(join(home(), 'shortcuts.json'), JSON.stringify({ pal: SHORTCUT, talk: talkShortcut, dictate: dictateShortcut, circle: circleShortcut, platform: process.platform })); } catch {}
  }
  // Your own shortcuts take effect at once: the settings file is watched for them.
  const ownShortcuts = () => { const c = loadConfig(); return JSON.stringify([c.talkShortcut, c.dictateShortcut, c.circleShortcut]); };
  let shortcutsSeen = null;
  function watchShortcuts() {
    shortcutsSeen = ownShortcuts();
    watchFile(configPath(), { interval: 1500 }, () => {
      const now = ownShortcuts();
      if (now === shortcutsSeen) return;
      shortcutsSeen = now;
      for (const key of [talkShortcut, dictateShortcut, circleShortcut]) if (key) { try { globalShortcut.unregister(key); } catch {} }
      talkShortcut = dictateShortcut = circleShortcut = null;
      registerTalkShortcut();
      registerDictateShortcut();
      registerCircleShortcut();
    });
  }
  app.on('will-quit', () => unwatchFile(configPath()));

  // -- Dictate: say it, and it's typed where your cursor is ------------------------------------
  // The shortcut shows a pill at the bottom of the screen (bridge/dictate.html). It listens with
  // Whisper on this computer, cleans up what you said (bridge/ui/dictation.js), and the words are
  // pasted into the app you're in; your clipboard comes back after. The pill never takes focus or
  // clicks. Hold the shortcut while you talk and it finishes the moment you let go (Windows); tap
  // it and it finishes when you pause, or when you tap again. Esc throws it away. What happens is
  // written to dictate.log in the app's data folder, for when something goes wrong.
  let dictate = null;
  let dictateShortcut = null; // the one that's registered
  let dictateEsc = false;     // Esc is ours while it listens
  let dictateDown = 0;        // when the shortcut went down, until you let go of it
  const HOLD = 300;           // down longer than this (ms) is a hold, not a tap
  const DICTATE_SIZE = { width: 520, height: 96 };
  const dictateLog = join(app.getPath('userData'), 'dictate.log');
  function logDictate(line) {
    try {
      if ((statSync(dictateLog, { throwIfNoEntry: false })?.size ?? 0) > 200_000) writeFileSync(dictateLog, '');
      appendFileSync(dictateLog, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  }
  function placeDictate() {
    const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; // the screen you're working on
    dictate?.setBounds({ x: Math.round(a.x + (a.width - DICTATE_SIZE.width) / 2), y: a.y + a.height - DICTATE_SIZE.height - 12, ...DICTATE_SIZE });
  }
  function createDictate() {
    dictate = new BrowserWindow({
      ...DICTATE_SIZE, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      alwaysOnTop: true, resizable: false, movable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, show: false, title: 'dotpals dictate',
      type: process.platform === 'darwin' ? 'panel' : undefined,
      webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    dictate.setAlwaysOnTop(true, 'screen-saver');
    dictate.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    dictate.setIgnoreMouseEvents(true);
    dictate.on('closed', () => { dictate = null; releaseDictateEsc(); });
    dictate.webContents.on('console-message', (e, ...old) => logDictate(`page: ${e.message ?? old[1]}`));
    dictate.webContents.on('render-process-gone', (_, d) => logDictate(`page stopped: ${d?.reason}`));
    const key = encodeURIComponent((dictateShortcut ?? '').replace('Control', 'Ctrl'));
    dictate.loadURL(`${bridge}/bridge/dictate.html?key=${key}`).catch(() => dictate?.loadFile(fileURLToPath(new URL('../bridge/dictate.html', import.meta.url)), { query: { key } }));
  }
  function dictateKey() {
    if (dictateDown) return; // the shortcut repeating while you hold it
    dictateDown = Date.now();
    if (!dictate || dictate.isDestroyed()) createDictate();
    placeDictate();
    dictate.showInactive();
    const go = () => dictate?.webContents.send('dictate:key', 'toggle');
    if (dictate.webContents.isLoading()) dictate.webContents.once('did-finish-load', go); else go();
    // Held while you talked: done the moment you let go.
    keys.released(dictateShortcut).then((ms) => {
      dictateDown = 0;
      logDictate(`shortcut ${ms > HOLD ? `held ${ms} ms` : 'tapped'}`);
      if (ms > HOLD) dictate?.webContents.send('dictate:key', 'release');
    });
  }
  function registerDictateShortcut() {
    dictateShortcut = registerShortcut('Dictate', loadConfig().dictateShortcut, DICTATE_SHORTCUTS, dictateKey);
    if (process.platform === 'win32') setTimeout(() => keys.windows(), 5000); // ready before the first time (Talk's hold too)
  }
  function releaseDictateEsc() {
    if (!dictateEsc) return;
    globalShortcut.unregister('Escape');
    dictateEsc = false;
  }
  ipcMain.on('dictate:state', (event, state) => {
    if (!dictate || event.sender !== dictate.webContents) return;
    // Esc cancels while it listens and writes (unless the notch has it right now).
    if (state === 'listening' && !dictateEsc && !globalShortcut.isRegistered('Escape')) {
      try { dictateEsc = globalShortcut.register('Escape', () => dictate?.webContents.send('dictate:key', 'cancel')); } catch {}
    }
    if (state === 'hide') { releaseDictateEsc(); dictate.hide(); }
  });
  ipcMain.handle('dictate:type', async (event, text) => {
    if (!dictate || event.sender !== dictate.webContents || typeof text !== 'string' || !text.trim()) return { ok: false };
    return typeOut(text.slice(0, 20_000));
  });
  // "Blu, …" said to Dictate: Talk (in the notch) takes it, with a screenshot of what you were
  // looking at, so "Blu, what's this error?" or "fix this" can point. Only then: dictation alone
  // never takes one.
  ipcMain.on('dictate:blu', async (event, text) => {
    if (!dictate || event.sender !== dictate.webContents || typeof text !== 'string' || !text.trim()) return;
    const shot = loadConfig().blu?.see !== false ? await takeShot() : null;
    logDictate(`to Blu${shot ? ', with a screenshot' : ''}: ${text.slice(0, 80)}`);
    createNotch();
    const go = () => notch?.webContents.send('notch:talk-text', { text: text.slice(0, 2000), shot });
    if (notch.webContents.isLoading()) notch.webContents.once('did-finish-load', () => setTimeout(go, 300)); else go();
  });
  /** Screenshots taken here, by path: their size and the screen they showed, so Blu's marks and clicks land on it. The newest 20. */
  const shots = new Map();
  /**
   * The screen under your pointer, as a JPEG under ~/.dotpals/shots (the newest 20 are kept), at
   * the size Blu's brain looks at: about 1.15 megapixels, at most 1568 across. Vision models
   * shrink anything bigger, and the places they point at would be off.
   * → { path, w, h, x, y } (x, y: your pointer, in its pixels) or null.
   */
  let toldScreen = false; // macOS: said once that dotpals needs Screen Recording
  async function takeShot() {
    try {
      // macOS without Screen Recording gives a picture of the wallpaper: Blu would look at (and click on) nothing.
      const allowed = process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted';
      if (!allowed) {
        if (systemPreferences.getMediaAccessStatus('screen') === 'not-determined') await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {}); // asks you
        logDictate('screenshot: dotpals isn’t allowed to record the screen');
        if (!toldScreen && Notification.isSupported()) { toldScreen = true; new Notification({ title: 'dotpals', body: 'To see your screen, allow dotpals under System Settings → Privacy & Security → Screen & System Audio Recording, then reopen it.', icon, silent: true }).show(); }
        return null;
      }
      const point = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(point);
      const k = display.scaleFactor || 1;
      const pw = display.size.width * k, ph = display.size.height * k;
      const f = Math.min(1, 1568 / Math.max(pw, ph), Math.sqrt(1_150_000 / (pw * ph)));
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(pw * f), height: Math.round(ph * f) } });
      // The screen you're on; another screen's picture would put marks and clicks in the wrong place.
      const source = sources.find((s) => String(s.display_id) === String(display.id)) ?? (sources.length === 1 ? sources[0] : null);
      if (!source || source.thumbnail.isEmpty()) return null;
      const { width: w, height: h } = source.thumbnail.getSize();
      const path = await saveShot(source.thumbnail.toJPEG(85));
      const shot = { path, w, h, x: Math.round(((point.x - display.bounds.x) / display.bounds.width) * w), y: Math.round(((point.y - display.bounds.y) / display.bounds.height) * h) };
      shots.set(path, { ...shot, display: { id: display.id, bounds: display.bounds, scale: k } });
      while (shots.size > 20) shots.delete(shots.keys().next().value);
      return shot;
    } catch (err) {
      logDictate(`screenshot failed: ${err.message}`);
      return null;
    }
  }
  async function saveShot(jpeg) {
    const dir = join(home(), 'shots');
    await mkdir(dir, { recursive: true });
    const old = (await readdir(dir)).filter((f) => /^shot-\d+\.(png|jpg)$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 19))) await rm(join(dir, f), { force: true }).catch(() => {});
    const path = join(dir, `shot-${Date.now()}.jpg`);
    await writeFile(path, jpeg);
    return path;
  }

  /**
   * Type `text` into the app you're in: onto the clipboard, the system's paste keys, then
   * your clipboard back. Its text only: Electron 44's clipboard reads nothing else, so a
   * picture or files you'd copied aren't put back. If the keys can't be sent, the words
   * stay on the clipboard. (Electron 44's clipboard calls return promises.)
   */
  async function typeOut(text) {
    const saved = await clipboard.readText();
    await clipboard.writeText(text);
    const started = Date.now();
    try { await keys.paste(); }
    catch (err) { logDictate(`paste failed: ${err.message}`); return { ok: false, copied: true, error: err.message }; }
    logDictate(`pasted ${text.length} characters in ${Date.now() - started} ms`);
    // Some apps read the clipboard a moment after the keys; and don't undo a copy you made since.
    setTimeout(async () => {
      try {
        if ((await clipboard.readText()) !== text) return;
        await (saved ? clipboard.writeText(saved) : clipboard.clear());
      } catch (err) { logDictate(`clipboard not put back: ${err.message}`); }
    }, 450);
    return { ok: true };
  }
  // Keys. Windows: a PowerShell kept running (it takes a second or two to start, then it's
  // instant). Paste waits until you've let go of Ctrl, Alt, Shift and Windows (still held from
  // the shortcut, they'd turn Ctrl+V into something else), then presses Ctrl+V. Held says how
  // long a key stayed down. macOS: osascript, once dotpals is allowed under Privacy & Security
  // → Accessibility; Linux: xdotool. Neither can tell when you let go, so they know taps only.
  const KEYS_PS = [
    `Add-Type -Namespace DotPals -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk); [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'`,
    'function Down($vk) { ([DotPals.Keys]::GetAsyncKeyState($vk) -band 0x8000) -ne 0 }',
    'function Key($vk, $up) { [DotPals.Keys]::keybd_event($vk, 0, $(if ($up) { 2 } else { 0 }), [UIntPtr]::Zero) }',
    "function Paste { $n = 0; while (((Down 0x11) -or (Down 0x12) -or (Down 0x10) -or (Down 0x5B) -or (Down 0x5C)) -and $n -lt 70) { Start-Sleep -Milliseconds 15; $n++ }; Key 0x11 $false; Key 0x56 $false; Key 0x56 $true; Key 0x11 $true; [Console]::Out.WriteLine('pasted') }",
    "function Held($vk) { $w = [Diagnostics.Stopwatch]::StartNew(); $down = 0; while ((Down $vk) -and $w.ElapsedMilliseconds -lt 130000) { $down = $w.ElapsedMilliseconds; Start-Sleep -Milliseconds 15 }; [Console]::Out.WriteLine(\"released $down\") }",
  ].join('\n') + '\n';
  // The virtual-key code of a shortcut's last key: "Control+Alt+D" → 0x44.
  const vkOf = (accel) => {
    const k = String(accel ?? '').split('+').pop();
    return /^[A-Z0-9]$/i.test(k) ? k.toUpperCase().charCodeAt(0) : k === 'Space' ? 0x20 : /^F\d+$/.test(k) ? 0x6f + Number(k.slice(1)) : 0;
  };
  const keys = {
    proc: null,
    out: '',
    pasting: [],   // waiting for "pasted"
    releasing: [], // waiting for "released <ms>"
    windows() {
      if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
      const p = this.proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.out = '';
      p.on('error', (err) => logDictate(`key helper: ${err.message}`));
      p.on('exit', (code) => {
        logDictate(`key helper stopped (${code})`);
        if (this.proc === p) this.proc = null;
        for (const w of this.pasting.splice(0)) w.fail(new Error('the key helper stopped'));
        for (const w of this.releasing.splice(0)) w(0);
      });
      p.stdin.on('error', () => {});
      p.stderr.on('data', (d) => logDictate(`key helper error: ${String(d).trim().slice(0, 300)}`));
      p.stdout.on('data', (d) => {
        const lines = (this.out + d).split(/\r?\n/);
        this.out = lines.pop();
        for (const line of lines) {
          if (line === 'pasted') this.pasting.shift()?.ok();
          else if (line.startsWith('released')) this.releasing.shift()?.(Number(line.split(' ')[1]) || 0);
        }
      });
      p.stdin.write(KEYS_PS);
      return p;
    },
    /** How long (ms) the shortcut's key stayed down, once you let go of it; 0 for a tap. */
    released(accel) {
      const vk = vkOf(accel);
      if (process.platform !== 'win32' || !vk) return new Promise((ok) => setTimeout(() => ok(0), 350));
      return new Promise((ok) => { this.releasing.push(ok); this.windows().stdin.write(`Held ${vk}\n`); });
    },
    paste() {
      if (process.platform === 'darwin') {
        if (!systemPreferences.isTrustedAccessibilityClient(false)) {
          systemPreferences.isTrustedAccessibilityClient(true); // asks you
          return Promise.reject(new Error('allow dotpals under Privacy & Security → Accessibility'));
        }
        return run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
      }
      if (process.platform !== 'win32') return run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']).catch(() => { throw new Error('install xdotool to type'); });
      return new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error('the paste took too long')), 6000);
        this.pasting.push({ ok: () => { clearTimeout(timer); ok(); }, fail: (e) => { clearTimeout(timer); fail(e); } });
        this.windows().stdin.write('Paste\n');
      });
    },
  };
  const run = (file, args) => new Promise((ok, fail) => execFile(file, args, { timeout: 4000 }, (err) => (err ? fail(err) : ok())));
  app.on('will-quit', () => { try { keys.proc?.kill(); } catch {} });

  // -- Blu, the screen buddy: it draws on your screen and does things on your computer ------------
  // Talk asks Blu's brain (bridge/buddy.js), then hands us the marks to draw (bridge/draw.html, a
  // see-through window over the screen that clicks go through) and the actions to do
  // (desktop/hands.js). Circle mode (Ctrl+Alt+C): you draw around something, then ask about it.
  const hands = createHands({ shell, screen, typeOut, log: logDictate });
  app.on('will-quit', () => { hands.duck(false); hands.stop(); });
  let draw = null;
  let drawEsc = false;       // Esc is ours while you circle
  let pendingCircle = null;  // the screenshot you're circling on
  let circleShortcut = null; // the one that's registered
  let drawOk = null;         // whether the drawing window can be seen through (a promise)
  /** The drawing window, over the screen with these bounds; null when it can't be seen through. */
  async function drawWindow(bounds) {
    if (!draw || draw.isDestroyed()) {
      draw = new BrowserWindow({
        ...bounds, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
        alwaysOnTop: true, resizable: false, movable: false, maximizable: false, minimizable: false, fullscreenable: false,
        focusable: false, skipTaskbar: true, show: false, title: 'dotpals draw', enableLargerThanScreen: true,
        // macOS: a panel, and the first press of a circle reaches the page though the window isn't active.
        type: process.platform === 'darwin' ? 'panel' : undefined, acceptFirstMouse: true,
        webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true },
      });
      draw.setAlwaysOnTop(true, 'screen-saver');
      draw.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      draw.setIgnoreMouseEvents(true);
      draw.on('closed', () => { draw = null; releaseDrawEsc(); });
      drawOk = seeThrough(draw);
      draw.loadURL(`${bridge}/bridge/draw.html`).catch(() => draw?.loadFile(fileURLToPath(new URL('../bridge/draw.html', import.meta.url))));
    }
    if (!(await drawOk)) { draw?.destroy(); return null; }
    if (!draw || draw.isDestroyed()) return null;
    draw.setBounds(bounds);
    if (!draw.isVisible()) draw.showInactive();
    return draw;
  }
  // Linux without a compositor (some window managers run none): a see-through window comes out
  // black, and drawing would black out the screen. Its depth tells (32 bits: see-through). Then
  // Blu doesn't draw, it still talks; a window made later, once a compositor runs, is checked again.
  let toldCompositor = false;
  function seeThrough(w) {
    if (process.platform !== 'linux') return Promise.resolve(true);
    let id;
    try { id = w.getNativeWindowHandle().readUInt32LE(0); } catch { return Promise.resolve(true); }
    return new Promise((ok) => execFile('xwininfo', ['-id', String(id)], { timeout: 2000 }, (err, out) => {
      const depth = Number(/Depth:\s*(\d+)/.exec(out ?? '')?.[1]);
      if (err || !depth || depth === 32) return ok(true); // not an X window (Wayland), no xwininfo, or see-through
      logDictate(`drawing: no compositor is running (windows are ${depth}-bit), so Blu doesn’t draw on the screen`);
      if (!toldCompositor && Notification.isSupported()) { toldCompositor = true; new Notification({ title: 'dotpals', body: 'Blu can’t draw on your screen: that needs a compositor (picom, for one), and none is running. Blu still talks.', icon, silent: true }).show(); }
      ok(false);
    }));
  }
  function toDraw(cmd) {
    if (!draw || draw.isDestroyed()) return;
    const go = () => draw?.webContents.send('draw:cmd', cmd);
    if (draw.webContents.isLoading()) draw.webContents.once('did-finish-load', go); else go();
  }
  const toNotch = (channel, data) => { if (notch && !notch.isDestroyed()) notch.webContents.send(channel, data); };
  const fromNotch = (event) => !!notch && !notch.isDestroyed() && event.sender === notch.webContents;
  function releaseDrawEsc() {
    if (!drawEsc) return;
    globalShortcut.unregister('Escape');
    drawEsc = false;
  }

  // The notch asks: a fresh screenshot, marks to draw, drawings off, actions to do.
  ipcMain.handle('blu:shot', (event) => (fromNotch(event) && loadConfig().blu?.see !== false ? takeShot() : null));
  ipcMain.on('blu:draw', async (event, { marks, shot, keep } = {}) => {
    const s = shots.get(shot);
    if (!fromNotch(event) || !s || !Array.isArray(marks) || !marks.length) return;
    if (!(await drawWindow(s.display.bounds))) return;
    toDraw({ type: 'marks', marks: marks.slice(0, 24), w: s.w, h: s.h, keep: !!keep });
    toNotch('notch:drawing', true);
  });
  ipcMain.on('blu:clear', (event) => { if (fromNotch(event)) toDraw({ type: 'clear' }); });
  ipcMain.on('blu:warm', (event) => { if (fromNotch(event) && loadConfig().blu?.hands !== false) hands.warm(); });
  // Music quieter while Blu listens, and back after (desktop/hands.js duck).
  ipcMain.on('blu:duck', (event, on) => { if (fromNotch(event) && loadConfig().blu?.hands !== false) hands.duck(!!on); });
  ipcMain.handle('blu:do', async (event, { actions, shot } = {}) => {
    if (!fromNotch(event) || !Array.isArray(actions)) return [];
    // Checked again here: only actions from the list, as the bridge sent them; clicks on the screenshot.
    const s = shots.get(shot);
    const list = actions.slice(0, 6).map((a) => {
      const ok = action(a, s ? { W: s.w, H: s.h } : undefined);
      if (ok?.act === 'play') Object.assign(ok, { url: typeof a.url === 'string' && /^(https:|spotify:)/i.test(a.url) ? a.url.slice(0, 2000) : undefined, applemusic: typeof a.applemusic === 'string' ? a.applemusic.slice(0, 120) : undefined });
      return ok && { ...ok, words: typeof a.words === 'string' ? a.words.slice(0, 80) : undefined };
    }).filter(Boolean);
    const blu = loadConfig().blu ?? {};
    const receipts = await hands.run(list, { shot: s ?? null, allow: { hands: blu.hands !== false, click: blu.click === true } });
    // What Blu typed stays out of the log.
    logDictate(`Blu did: ${receipts.map((r) => `${r.ok ? '✓' : '✗'} ${r.act === 'type' ? 'Type …' : r.words}${r.error ? ` (${r.error})` : ''}`).join(' · ')}`);
    return receipts;
  });

  // You circle: the shortcut freezes nothing; you draw around something on the live screen, and
  // Blu gets the screenshot taken as you pressed it, with your circle drawn on it.
  async function circleKey() {
    if (pendingCircle) return cancelCircle();
    if (loadConfig().blu?.see === false) { talkInNotch(); return; } // Blu can't look: just talk
    const shot = await takeShot();
    const s = shot && shots.get(shot.path);
    if (!s) return;
    pendingCircle = shot;
    // Nothing to circle on (Linux without a compositor): just talk.
    if (!(await drawWindow(s.display.bounds))) { pendingCircle = null; talkInNotch(); return; }
    draw.setIgnoreMouseEvents(false);
    toDraw({ type: 'circle', w: shot.w, h: shot.h, image: `data:image/jpeg;base64,${(await readFile(shot.path)).toString('base64')}` });
    if (!drawEsc && !globalShortcut.isRegistered('Escape')) { try { drawEsc = globalShortcut.register('Escape', cancelCircle); } catch {} }
  }
  function cancelCircle() {
    pendingCircle = null;
    releaseDrawEsc();
    if (!draw || draw.isDestroyed()) return;
    draw.setIgnoreMouseEvents(true);
    toDraw({ type: 'cancel' });
  }
  ipcMain.on('draw:event', async (event, type, data) => {
    if (!draw || draw.isDestroyed() || event.sender !== draw.webContents) return;
    if (type === 'empty') {
      draw.hide();
      draw.setIgnoreMouseEvents(true);
      toNotch('notch:drawing', false);
    } else if (type === 'circled' && pendingCircle) {
      const shot = pendingCircle;
      pendingCircle = null;
      releaseDrawEsc();
      draw.setIgnoreMouseEvents(true);
      // The screenshot with your circle on it, in place of the plain one.
      let path = shot.path;
      const jpeg = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(data?.image ?? ''))?.[1];
      if (jpeg) { path = await saveShot(Buffer.from(jpeg, 'base64')); shots.set(path, { ...shots.get(shot.path), path }); }
      const b = data?.box;
      const circled = b && [b.x, b.y, b.w, b.h].every(Number.isFinite) ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) } : null;
      createNotch();
      const go = () => { toNotch('notch:talk-circle', { shot: { ...shot, path }, circled }); toNotch('notch:drawing', true); };
      if (notch.webContents.isLoading()) notch.webContents.once('did-finish-load', () => setTimeout(go, 300)); else go();
    }
  });
  function registerCircleShortcut() {
    circleShortcut = registerShortcut('Circle and ask', loadConfig().circleShortcut, CIRCLE_SHORTCUTS, circleKey);
  }

  // The notch's music card: what's playing, and its buttons (they're yours, so they work with Blu's hands off too).
  ipcMain.handle('blu:media', async (event, what) => {
    if (!fromNotch(event)) return null;
    if (what === 'info') return hands.nowPlaying();
    const a = what === 'louder' || what === 'quieter' ? { act: 'volume', by: what === 'louder' ? 10 : -10 } : action({ act: 'media', key: what });
    if (!a) return null;
    return (await hands.run([a], { allow: { hands: true, click: false } }))[0];
  });

  function createTray() {
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip(`dotpals: ${process.platform === 'darwin' ? 'Cmd+Option+P' : 'Ctrl+Alt+P'} to show or hide`);
    tray.on('click', toggle);
    const menu = () => Menu.buildFromTemplate([
      { label: 'Show / hide', accelerator: SHORTCUT, click: toggle },
      { label: 'Just the pal', type: 'checkbox', checked: !!prefs.compact, click: (item) => win?.webContents.send('window:set-compact', item.checked) },
      // How big the pal is in small mode (also Dashboard → Settings, or Ctrl+scroll over the pal).
      { label: 'Pal size', submenu: [['Small', 60], ['Normal', 100], ['Large', 140]].map(([label, palSize]) => (
        { label, type: 'radio', checked: (loadConfig().palSize ?? 100) === palSize, click: () => setConfig({ palSize }) }
      )) },
      { label: 'Notch at the top of the screen', submenu: [
        { label: 'When the pal is hidden', type: 'radio', checked: notchMode() === 'auto', click: () => setNotchMode('auto') },
        { label: 'Always', type: 'radio', checked: notchMode() === 'always', click: () => setNotchMode('always') },
        { label: 'Never', type: 'radio', checked: notchMode() === 'off', click: () => setNotchMode('off') },
      ] },
      { label: 'Dashboard', click: openDashboard },
      { label: 'Talk to Blu', ...(talkShortcut ? { accelerator: talkShortcut } : {}), click: talkInNotch },
      { label: 'Dictate (type with your voice)', ...(dictateShortcut ? { accelerator: dictateShortcut } : {}), click: dictateKey },
      { label: 'Circle something, ask Blu', ...(circleShortcut ? { accelerator: circleShortcut } : {}), click: circleKey },
      // Chat is optional (Dashboard → Settings → Chat with your agents).
      ...(loadConfig().chat ? [{ label: 'Start working…', click: sayHello }] : []),
      { type: 'separator' },
      { label: 'Notifications', type: 'checkbox', checked: loadConfig().notifications, click: (item) => saveConfig({ notifications: item.checked }) },
      ...(loadConfig().chat ? [{ label: 'Greet me when dotpals starts', type: 'checkbox', checked: !!loadConfig().greetOnStart, click: (item) => saveConfig({ greetOnStart: item.checked }) }] : []),
      { label: 'Open when I log in', type: 'checkbox', checked: opensAtLogin(), click: (item) => openAtLogin(item.checked) },
      { type: 'separator' },
      { label: 'Quit dotpals', click: () => app.quit() },
    ]);
    tray.on('right-click', () => tray.popUpContextMenu(menu()));
    if (process.platform !== 'win32') tray.setContextMenu(menu());
  }

  // The size the window should be right now (never read back from Windows, which drifts with scaling).
  let talking = false; // the chat bubble is open in small mode
  const intendedSize = () => {
    if (!prefs.compact) return { ...SIZE.full, height: prefs.height ?? SIZE.full.height };
    const k = Math.max(1, (loadConfig().palSize ?? 100) / 100); // Settings → Pal size: over 100%, a bigger window
    return { width: Math.round(SIZE.compact.width * k), height: Math.round(SIZE.compact.height * k) + (talking ? TALK_EXTRA : 0) };
  };

  function createWindow() {
    const compact = !!prefs.compact;
    const size = intendedSize();
    const area = screen.getPrimaryDisplay().workArea;
    const pos = onScreen(prefs.x, prefs.y, size) ?? {
      x: area.x + area.width - size.width - MARGIN,
      y: area.y + area.height - size.height - MARGIN,
    };

    win = new BrowserWindow({
      ...size,
      ...pos,
      minWidth: SIZE.compact.width,
      minHeight: SIZE.compact.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      resizable: !compact,
      maximizable: false,
      fullscreenable: false,
      title: 'dotpals',
      icon,
      skipTaskbar: true, // it lives in the tray
      webPreferences: {
        preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
        sandbox: true,
        contextIsolation: true,
        autoplayPolicy: 'no-user-gesture-required', // sounds play without a click first
      },
    });
    // Stay above full-screen editors too.
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Links (files → your editor, URLs → your browser) open outside the widget.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|vscode|cursor|file):/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file:') && !url.startsWith(bridge)) {
        e.preventDefault();
        if (/^(https?|vscode|cursor):/i.test(url)) shell.openExternal(url);
      }
    });

    const remember = () => {
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      prefs.x = x;
      prefs.y = y;
      if (!prefs.compact) prefs.height = win.getSize()[1];
      savePrefs();
    };
    win.on('moved', remember);
    win.on('resized', remember);

    // Tell the page when the mouse is over the window. The page can't tell by
    // itself: over a drag region (the empty space around the pal) Windows stops
    // sending it mouse events, so CSS :hover flickers off as soon as you click.
    let inside = null;
    const hover = setInterval(() => {
      if (win.isDestroyed()) return;
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      const now = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      if (now !== inside) win.webContents.send('window:hover', (inside = now));
    }, 100);
    win.webContents.on('did-finish-load', () => { inside = null; });

    // Closing hides it; the tray icon or the shortcut brings it back.
    // Hiding the pal hands over to the notch (and showing it takes over again).
    win.on('hide', () => { syncNotch(); tellNotchPal(); });
    win.on('show', () => { syncNotch(); tellNotchPal(); });

    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      win.hide();
    });
    win.on('closed', () => { clearInterval(hover); win = null; });

    win.webContents.once('did-finish-load', () => {
      if (!helloPending) return;
      helloPending = false;
      setTimeout(() => win?.webContents.send('window:hello'), 1500);
    });
    win.loadURL(`${bridge}/?float=1`).catch(() => win.loadFile(page, { query: { float: '1' } }));
  }

  // -- the notch: a small island at the top of the screen ------------------------
  // What every agent is doing, its plan and your usage limits (see bridge/notch.html
  // and its state machine, bridge/ui/notch-state.js). The window is sized to the
  // island (the page tells us), and on top of that it lets clicks through wherever
  // the island isn't, so it never blocks clicks around it. It never takes focus:
  // hover comes from the cursor feed below, keys from shortcuts held only while needed.
  let notch;
  let notchSize = { w: 220, h: 6 }; // the size we last gave it (never read back: scaling drifts)
  let notchIsland = null;           // { w, h } of the island, hanging from the top centre; null: nothing to click
  let notchSolid = null;            // whether it takes clicks right now
  let notchRestarts = 0;            // after a crash; it gives up after a few
  const notchArea = () => screen.getPrimaryDisplay().workArea;
  function createNotch() {
    if (notch && !notch.isDestroyed()) { if (!notch.isVisible()) notch.showInactive(); return; }
    const area = notchArea();
    notchSize = { w: 220, h: 6 }; // the hidden strip, until the page says otherwise
    notchIsland = null;
    notchSolid = null;
    notch = new BrowserWindow({
      width: notchSize.w, height: notchSize.h,
      x: Math.round(area.x + (area.width - notchSize.w) / 2),
      y: area.y,
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      alwaysOnTop: true, resizable: false, movable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, show: false, title: 'dotpals notch',
      type: process.platform === 'darwin' ? 'panel' : undefined,
      // Talk listens and speaks without a click on the notch (the shortcut starts it).
      webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    notch.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; }); // a PR's link
    notch.setAlwaysOnTop(true, 'screen-saver');
    notch.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    syncNotchMouse(screen.getCursorScreenPoint());
    notch.once('ready-to-show', () => notch?.showInactive());
    // Its shortcuts only while it's on screen; a reloaded page asks again.
    notch.on('show', applyNotchKeys);
    notch.on('hide', applyNotchKeys);
    notch.webContents.on('did-start-loading', () => { notchKeysWanted = { escape: false, approval: false }; applyNotchKeys(); });
    notch.webContents.on('did-finish-load', tellNotchPal);
    // A notch page that crashed (or was killed) comes back by itself, a few times.
    notch.webContents.on('render-process-gone', (_, details) => {
      notchKeysWanted = { escape: false, approval: false }; applyNotchKeys();
      console.error('[dotpals] the notch stopped:', details?.reason);
      // Always closed (so `dotpals doctor` sees it's gone); made again only the first few times.
      const gone = notch;
      const again = ++notchRestarts <= 3;
      setTimeout(() => { if (!gone.isDestroyed()) gone.destroy(); if (again) syncNotch(); }, 1000);
    });
    notch.on('closed', () => { notch = null; notchKeysWanted = { escape: false, approval: false }; applyNotchKeys(); });
    notch.loadURL(`${bridge}/bridge/notch.html`).catch((err) => {
      console.error('[dotpals] the notch page didn’t load from the bridge:', err.message);
      notch?.loadFile(notchPage);
    });
  }
  // When it shows: 'always' (the default: people install dotpals for the notch), 'auto' (whenever the pal is hidden) or 'off'.
  const notchMode = () => prefs.notchMode ?? (prefs.notch === false ? 'off' : 'always');
  function syncNotch() {
    const mode = notchMode();
    const want = mode === 'always' || (mode === 'auto' && !(win && !win.isDestroyed() && win.isVisible()));
    if (want) createNotch();
    else if (notch && !notch.isDestroyed()) notch.hide();
  }
  function setNotchMode(mode) {
    prefs.notchMode = mode;
    delete prefs.notch;
    savePrefs();
    syncNotch();
  }
  // Keep the island centred at the top as it grows and shrinks. The page sends the
  // window size it needs (the island plus room for its shadow and springy overshoot)
  // and the island's own size, which is the only part that takes clicks.
  let shrink;
  const clamp = (n, lo, hi) => Math.min(Math.max(Number(n) || 0, lo), hi);
  ipcMain.on('notch:size', (event, width, height, island) => {
    if (!notch || notch.isDestroyed() || event.sender !== notch.webContents) return;
    const area = notchArea();
    const w = Math.round(clamp(width, 40, Math.min(860, area.width)));
    const h = Math.round(clamp(height, 2, Math.min(640, area.height)));
    notchIsland = island && Number.isFinite(island.w) && Number.isFinite(island.h) && island.w > 0 && island.h > 0
      ? { w: clamp(island.w, 1, w), h: clamp(island.h, 1, h) } : null;
    syncNotchMouse(screen.getCursorScreenPoint());
    const apply = (size) => {
      if (!notch || notch.isDestroyed()) return;
      notchSize = size;
      const a = notchArea();
      try { notch.setBounds({ x: Math.round(a.x + (a.width - size.w) / 2), y: a.y, width: size.w, height: size.h }); } catch {}
    };
    clearTimeout(shrink);
    // Grow at once; shrink after the island's closing animation (both ways at once
    // when one side grows and the other shrinks).
    const grown = { w: Math.max(w, notchSize.w), h: Math.max(h, notchSize.h) };
    if (grown.w !== notchSize.w || grown.h !== notchSize.h) apply(grown);
    if (grown.w !== w || grown.h !== h) shrink = setTimeout(() => apply({ w, h }), 380);
  });

  /** Clicks go through the notch window except over the island itself. */
  function syncNotchMouse(p) {
    if (!notch || notch.isDestroyed()) return;
    const a = notchArea();
    const cx = a.x + a.width / 2;
    const solid = !!notchIsland && notch.isVisible()
      && p.x >= cx - notchIsland.w / 2 - 1 && p.x <= cx + notchIsland.w / 2 + 1
      && p.y >= a.y - 1 && p.y <= a.y + notchIsland.h + 1;
    if (solid === notchSolid) return;
    notchSolid = solid;
    try { notch.setIgnoreMouseEvents(!solid); } catch {}
  }

  // Keys for the notch, as global shortcuts because it never takes focus: Esc (only
  // while it's open with the mouse over it, so it can't steal Esc from your editor)
  // and Ctrl+Alt+Y / Ctrl+Alt+N (only while an approval card is on show). Each is
  // registered when the page asks and released the moment it doesn't.
  const NOTCH_KEYS = { escape: 'Escape', allow: 'CommandOrControl+Alt+Y', deny: 'CommandOrControl+Alt+N' };
  const notchKeysOn = new Set();
  let notchKeysWanted = { escape: false, approval: false };
  function applyNotchKeys() {
    const on = !!notch && !notch.isDestroyed() && notch.isVisible();
    const want = new Set();
    if (on && notchKeysWanted.escape) want.add('escape');
    if (on && notchKeysWanted.approval) { want.add('allow'); want.add('deny'); }
    for (const key of [...notchKeysOn]) {
      if (want.has(key)) continue;
      try { globalShortcut.unregister(NOTCH_KEYS[key]); } catch {}
      notchKeysOn.delete(key);
    }
    for (const key of want) {
      if (notchKeysOn.has(key)) continue;
      let ok = false;
      try { ok = globalShortcut.register(NOTCH_KEYS[key], () => { if (notch && !notch.isDestroyed()) notch.webContents.send('notch:key', key); }); } catch {}
      if (ok) notchKeysOn.add(key);
    }
    return { escape: notchKeysOn.has('escape'), allow: notchKeysOn.has('allow'), deny: notchKeysOn.has('deny') };
  }
  ipcMain.handle('notch:keys', (event, want) => {
    if (!notch || notch.isDestroyed() || event.sender !== notch.webContents) return {};
    notchKeysWanted = { escape: !!want?.escape, approval: !!want?.approval };
    return applyNotchKeys();
  });

  // The cursor, for the pals' eyes (they watch it anywhere on screen) and the notch's
  // hover: its position relative to each window's content, in CSS px, ~30 times a
  // second while it moves (nothing is sent while it's still). Also how long you've
  // been away (no keyboard or mouse), so the notch can hide while you're gone.
  function watchCursor() {
    const last = new Map(); // webContents id → last position sent
    const feed = (w, p) => {
      if (!w || w.isDestroyed()) return;
      if (!w.isVisible()) { last.delete(w.webContents.id); return; }
      const b = w.getContentBounds();
      const zoom = w.webContents.getZoomFactor() || 1;
      const x = Math.round(((p.x - b.x) / zoom) * 10) / 10;
      const y = Math.round(((p.y - b.y) / zoom) * 10) / 10;
      // Also the content size these are relative to: a page mid-resize can tell.
      const width = Math.round(b.width / zoom);
      const height = Math.round(b.height / zoom);
      const key = `${x},${y},${width},${height}`;
      if (last.get(w.webContents.id) === key) return;
      last.set(w.webContents.id, key);
      w.webContents.send('window:cursor', { x, y, width, height });
    };
    setInterval(() => {
      const p = screen.getCursorScreenPoint();
      feed(win, p);
      feed(notch, p);
      syncNotchMouse(p);
      syncPalMouse(p);
    }, 33);
    setInterval(() => {
      if (notch && !notch.isDestroyed() && notch.isVisible()) notch.webContents.send('notch:idle', powerMonitor.getSystemIdleTime());
    }, 2000);
  }
  ipcMain.handle('usage', () => readUsage().catch(() => ({ agents: [] })));

  /** Nudge the pal back inside its display's work area (its buttons were off the right edge for a user). */
  function keepOnScreen() {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const p = onScreen(b.x, b.y, b);
    if (p && (p.x !== b.x || p.y !== b.y)) { win.setPosition(p.x, p.y); [prefs.x, prefs.y] = [p.x, p.y]; savePrefs(); }
  }
  // Keep a saved position if it's still on a connected screen, nudged fully onto it.
  function onScreen(x, y, { width, height }) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const { workArea: a } = screen.getDisplayMatching({ x, y, width, height });
    if (x + width < a.x + 40 || x > a.x + a.width - 40 || y + height < a.y + 40 || y > a.y + a.height - 40) return null;
    return {
      x: Math.min(Math.max(x, a.x), a.x + a.width - width),
      y: Math.min(Math.max(y, a.y), a.y + a.height - height),
    };
  }

  // Resize around the bottom-right corner, so the pal stays where it was.
  ipcMain.handle('window:compact', (_, compact) => {
    if (!win) return;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    if (!!compact !== !!prefs.compact) talking = false; // the chat bubble closes when the mode changes
    prefs.compact = !!compact;
    const next = intendedSize(); // also when the pal's size changed: a pal over 100% needs a bigger window
    if (!compact) palAreas = null;
    palSolid = null; // re-apply for the new mode
    syncPalMouse(screen.getCursorScreenPoint());
    win.setResizable(true);
    win.setBounds({ x: x + w - next.width, y: y + h - next.height, ...next });
    win.setResizable(!compact);
    const [nx, ny] = win.getPosition();
    Object.assign(prefs, { x: nx, y: ny });
    savePrefs();
  });
  ipcMain.handle('window:is-compact', () => !!prefs.compact);
  // Small mode with the chat bubble open grows the window upward (bottom
  // edge stays put), so the bubble sits above the pal's head instead of covering it.
  ipcMain.handle('window:talk', (_, on) => {
    if (!win || !prefs.compact || talking === !!on) { talking = !!on && !!prefs.compact; return; }
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    talking = !!on;
    const next = intendedSize();
    win.setResizable(true);
    win.setBounds({ x: x + w - next.width, y: y + h - next.height, ...next });
    win.setResizable(false);
  });
  // Click-through for the transparent parts of the small window. The page sends the
  // areas that should take clicks (the round bar, a request card, the pals and their
  // bubbles); the app checks the real cursor against them ~30 times a second (see the
  // cursor loop) and lets clicks through everywhere else. The app decides, not the page:
  // a page can't see the mouse while clicks pass through it, so it could get stuck
  // see-through and its buttons would stop working.
  let palAreas = null; // [[left, top, width, height], …] in CSS px, or null: all solid
  let palSolid = null; // what the window is set to now (null: unknown)
  ipcMain.on('window:solid-areas', (event, rects) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    palAreas = Array.isArray(rects)
      ? rects.filter((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)).slice(0, 40)
      : null;
    syncPalMouse(screen.getCursorScreenPoint());
  });
  function syncPalMouse(p) {
    if (!win || win.isDestroyed()) return;
    let solid = true;
    if (prefs.compact && palAreas && win.isVisible() && !drag) {
      const b = win.getContentBounds();
      const zoom = win.webContents.getZoomFactor() || 1;
      const x = (p.x - b.x) / zoom;
      const y = (p.y - b.y) / zoom;
      solid = palAreas.some(([l, t, w, h]) => x >= l - 3 && x <= l + w + 3 && y >= t - 3 && y <= t + h + 3);
    }
    if (solid === palSolid) return;
    palSolid = solid;
    try { win.setIgnoreMouseEvents(!solid, { forward: true }); } catch {}
  }
  ipcMain.on('window:show', show);
  // The notch's pal button: bring the pal back as just the pal (small mode), waving so
  // you spot it; or, when it's already on screen, put it away (the notch keeps watching).
  const palShown = () => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  function showMini() {
    show();
    win?.webContents.send('window:set-compact', true);
    win?.webContents.send('window:greet');
  }
  function tellNotchPal() {
    if (notch && !notch.isDestroyed()) notch.webContents.send('notch:pal', palShown());
  }
  ipcMain.on('window:show-mini', showMini);
  ipcMain.on('window:toggle-mini', () => (palShown() ? win.hide() : showMini()));
  ipcMain.handle('window:pal-shown', () => palShown());
  ipcMain.on('clipboard:write', (_, text) => { if (typeof text === 'string') clipboard.writeText(text); });

  // Desktop notifications (the page decides when: see notify() in bridge/index.html).
  ipcMain.on('notify', (_, { title, body } = {}) => {
    if (!loadConfig().notifications || !Notification.isSupported() || typeof title !== 'string') return;
    const n = new Notification({ title, body: typeof body === 'string' ? body : '', icon, silent: true });
    n.on('click', show);
    n.show();
  });

  // Dragging by the pal itself (the page handles the pointer, so a short press still counts as a click).
  // The page's screenX is measured from the window's origin, which is moving,
  // so read the real cursor here instead.
  let drag = null;
  const followCursor = () => {
    if (!win || !drag) return;
    const p = screen.getCursorScreenPoint();
    // With display scaling, Windows rounds the size a little differently on every
    // move, so the window creeps bigger. Always pass the exact size we want.
    // (Whole numbers only: the page's press position can be fractional.)
    try {
      win.setBounds({ x: Math.round(drag.x + p.x - drag.cursor.x), y: Math.round(drag.y + p.y - drag.cursor.y), ...drag.size });
    } catch {}
  };
  ipcMain.on('window:drag-start', (_, cx, cy) => {
    if (!win) return;
    const [x, y] = win.getPosition();
    // The press position from the page is exact (the window hasn't moved yet);
    // by the time this message arrives the cursor may already have moved on.
    const cursor = Number.isFinite(cx) && Number.isFinite(cy) ? { x: cx, y: cy } : screen.getCursorScreenPoint();
    drag = { x, y, cursor, size: intendedSize() };
  });
  ipcMain.on('window:drag-to', followCursor);
  ipcMain.on('window:drag-end', () => {
    followCursor();
    drag = null;
    if (!win) return;
    [prefs.x, prefs.y] = win.getPosition(); // programmatic moves don't fire 'moved'
    savePrefs();
  });
  ipcMain.on('window:close', () => win?.hide());

  // Follow the bridge's event stream and hand each event to the page.
  ipcMain.on('bridge:connect', (event) => {
    const id = event.sender.id;
    // Which window it is, so the bridge can tell `dotpals doctor` the pal and the notch are up.
    const is = (w) => !!w && !w.isDestroyed() && event.sender === w.webContents;
    following.get(id)?.();
    following.set(id, follow(event.sender, is(notch) ? 'notch' : is(win) ? 'pal' : null));
    event.sender.once('destroyed', () => { following.get(id)?.(); following.delete(id); });
  });

  function follow(target, kind) {
    let controller = new AbortController();
    let stopped = false;
    const send = (channel, data) => { if (!target.isDestroyed()) target.send(channel, data); };

    (async () => {
      while (!stopped && !target.isDestroyed()) {
        try {
          const res = await fetch(`${bridge}/events?answers=1${kind ? `&window=${kind}` : ''}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          send('bridge:status', true);
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              let type = 'message';
              let data = '';
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) type = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
              }
              if (data) {
                try { send('bridge:event', { type, data: JSON.parse(data) }); } catch {}
              }
            }
          }
        } catch {}
        if (stopped) return;
        send('bridge:status', false);
        await new Promise((r) => setTimeout(r, 1500));
        // If the bridge we were using went away, take over.
        await startBridge({ port, log: () => {}, onQuit: () => app.quit() }).catch(() => {});
        controller = new AbortController();
      }
    })();

    return () => { stopped = true; controller.abort(); };
  }
}
