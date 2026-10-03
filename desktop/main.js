// dotpals desktop: the live pal in a small always-on-top window, so it floats
// above your editor without a browser tab. Starts the bridge if it isn't running.
//
//   npm run float        (or `node desktop/launch.js`)
//
// Closing hides it to the tray; Ctrl+Alt+P (Cmd+Option+P on macOS) shows or
// hides it from anywhere. Quit from the tray menu.
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, shell, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../bridge/server.js';
import { loadConfig, saveConfig } from '../bridge/config.js';
import { readUsage } from '../bridge/usage.js';

const port = Number(process.env.DOTPALS_PORT || process.env.PORT) || 5175;
const bridge = `http://127.0.0.1:${port}`;
const page = fileURLToPath(new URL('../bridge/index.html', import.meta.url));
const notchPage = fileURLToPath(new URL('../bridge/notch.html', import.meta.url));
const SIZE = { compact: { width: 260, height: 290 }, full: { width: 380, height: 600 } };
const MARGIN = 16;
const TALK_EXTRA = 270; // small mode: extra height above the pal for the chat bubble
const SHORTCUT = 'CommandOrControl+Alt+P';
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
    if (argv.includes('--open-at-login')) app.setLoginItemSettings({ ...loginItem(), openAtLogin: true });
    if (argv.includes('--dashboard')) openDashboard();
    if (argv.includes('--notch')) setNotchMode('always');
    if (argv.includes('--notch-auto')) setNotchMode('auto');
    if (argv.includes('--no-notch')) setNotchMode('off');
  }
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  // The bridge runs in a process of its own (this Electron binary as plain Node), so its
  // work (history, recaps, OpenCode's event stream) can never freeze the pal's window.
  // In this process only when that fails. A bridge that's already running is used as is.
  let bridgeProc = null;
  const QUIT_APP = 75; // the bridge's exit code when `dotpals setup` asks the app to quit (bridge/server.js)
  const bridgeUp = () => fetch(`${bridge}/api/agents`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  async function ensureBridge() {
    if (await bridgeUp()) return;
    if (!bridgeProc) {
      try {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../bridge/server.js', import.meta.url))], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DOTPALS_PORT: String(port), DOTPALS_DESKTOP_CHILD: '1' },
          stdio: 'ignore',
          windowsHide: true,
        });
        bridgeProc = child;
        child.on('error', () => { if (bridgeProc === child) bridgeProc = null; });
        child.on('exit', (code) => {
          if (bridgeProc === child) bridgeProc = null;
          if (code === QUIT_APP) app.quit();
        });
      } catch {}
    }
    for (let i = 0; i < 40 && bridgeProc; i++) {
      if (await bridgeUp()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (await bridgeUp()) return;
    try {
      await startBridge({ port, log: () => {}, onQuit: () => app.quit() });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') console.error('[dotpals] bridge failed to start:', err.message);
    }
  }
  // Quitting takes the bridge we started (and the OpenCode server it started) with it.
  app.on('will-quit', () => {
    const child = bridgeProc;
    bridgeProc = null;
    if (!child) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      else child.kill();
    } catch {}
  });

  app.whenReady().then(async () => {
    await ensureBridge();
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
    watchCursor();
  });

  // Hidden to the tray isn't "all closed"; only Quit ends the app.
  app.on('window-all-closed', () => { if (quitting) app.quit(); });

  // When run as electron.exe + main.js (npm run float, setup), log-in needs the script too.
  const loginItem = () => (app.isPackaged ? {} : { path: process.execPath, args: [fileURLToPath(import.meta.url)] });

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
  ipcMain.handle('login:get', () => app.getLoginItemSettings(loginItem()).openAtLogin);
  ipcMain.handle('login:set', (_, on) => { app.setLoginItemSettings({ ...loginItem(), openAtLogin: !!on }); return !!on; });

  // The dashboard: sessions, logs, stats and settings, in a normal window.
  let dashboard;
  function openDashboard() {
    if (dashboard && !dashboard.isDestroyed()) { dashboard.show(); dashboard.focus(); return; }
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
    dashboard.loadURL(`${bridge}/dashboard`);
  }
  ipcMain.on('dashboard:open', openDashboard);

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
      // Chat is optional (Dashboard → Settings → Chat with your agents).
      ...(loadConfig().chat ? [{ label: 'Start working…', click: sayHello }] : []),
      { type: 'separator' },
      { label: 'Notifications', type: 'checkbox', checked: loadConfig().notifications, click: (item) => saveConfig({ notifications: item.checked }) },
      ...(loadConfig().chat ? [{ label: 'Greet me when dotpals starts', type: 'checkbox', checked: !!loadConfig().greetOnStart, click: (item) => saveConfig({ greetOnStart: item.checked }) }] : []),
      { label: 'Open when I log in', type: 'checkbox', checked: app.getLoginItemSettings(loginItem()).openAtLogin, click: (item) => app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked }) },
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
      webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true },
    });
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
    // Grow upward, but never past the top of the screen (then the pal moves down a little).
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setResizable(true);
    win.setBounds({ x: x + w - next.width, y: Math.max(area.y, y + h - next.height), ...next });
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
        // If the bridge we were using went away, start another one.
        if (!quitting) await ensureBridge().catch(() => {});
        controller = new AbortController();
      }
    })();

    return () => { stopped = true; controller.abort(); };
  }
}
