// dotpals desktop: the live pal in a small always-on-top window, so it floats
// above your editor without a browser tab. Starts the bridge if it isn't running.
//
//   npm run float        (or `node desktop/launch.js`)
//
// Closing hides it to the tray; Ctrl+Alt+P (Cmd+Option+P on macOS) shows or
// hides it from anywhere. Quit from the tray menu.
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, shell, Tray } from 'electron';
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
const SHORTCUT = 'CommandOrControl+Alt+P';
const icon = nativeImage.createFromPath(fileURLToPath(new URL('./icon.png', import.meta.url)));

app.setName('dotpals');
// Linux needs this for a see-through window (Windows and macOS don't).
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');
app.setAppUserModelId?.('dev.dotpals.desktop'); // Windows shows notifications only for apps with an id

// A bug in a handler shouldn't pop up an error dialog over your editor; log it instead.
process.on('uncaughtException', (err) => console.error('[dotpals]', err));

if (!app.requestSingleInstanceLock()) {
  app.quit();
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

  app.whenReady().then(async () => {
    // Run the bridge in this process, unless one is already running.
    try {
      await startBridge({ port, log: () => {} });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') console.error('[dotpals] bridge failed to start:', err.message);
    }
    app.dock?.hide(); // macOS: a floating widget with a menu-bar icon, not a Dock app
    createWindow();
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
      { label: 'Notch at the top of the screen', submenu: [
        { label: 'When the pal is hidden', type: 'radio', checked: notchMode() === 'auto', click: () => setNotchMode('auto') },
        { label: 'Always', type: 'radio', checked: notchMode() === 'always', click: () => setNotchMode('always') },
        { label: 'Never', type: 'radio', checked: notchMode() === 'off', click: () => setNotchMode('off') },
      ] },
      { label: 'Dashboard', click: openDashboard },
      { type: 'separator' },
      { label: 'Notifications', type: 'checkbox', checked: loadConfig().notifications, click: (item) => saveConfig({ notifications: item.checked }) },
      { label: 'Open when I log in', type: 'checkbox', checked: app.getLoginItemSettings(loginItem()).openAtLogin, click: (item) => app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked }) },
      { type: 'separator' },
      { label: 'Quit dotpals', click: () => app.quit() },
    ]);
    tray.on('right-click', () => tray.popUpContextMenu(menu()));
    if (process.platform !== 'win32') tray.setContextMenu(menu());
  }

  // The size the window should be right now (never read back from Windows, which drifts with scaling).
  const intendedSize = () => (prefs.compact ? { ...SIZE.compact } : { ...SIZE.full, height: prefs.height ?? SIZE.full.height });

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
    notch.webContents.on('render-process-gone', () => { notchKeysWanted = { escape: false, approval: false }; applyNotchKeys(); });
    notch.on('closed', () => { notch = null; notchKeysWanted = { escape: false, approval: false }; applyNotchKeys(); });
    notch.loadURL(`${bridge}/bridge/notch.html`).catch(() => notch?.loadFile(notchPage));
  }
  // When it shows: 'auto' (whenever the pal is hidden, the default), 'always' or 'off'.
  const notchMode = () => prefs.notchMode ?? (prefs.notch === true ? 'always' : 'auto');
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
    const next = compact ? SIZE.compact : { ...SIZE.full, height: prefs.height ?? SIZE.full.height };
    prefs.compact = !!compact;
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
    following.get(id)?.();
    following.set(id, follow(event.sender));
    event.sender.once('destroyed', () => { following.get(id)?.(); following.delete(id); });
  });

  function follow(target) {
    let controller = new AbortController();
    let stopped = false;
    const send = (channel, data) => { if (!target.isDestroyed()) target.send(channel, data); };

    (async () => {
      while (!stopped && !target.isDestroyed()) {
        try {
          const res = await fetch(`${bridge}/events?answers=1`, { signal: controller.signal });
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
        await startBridge({ port, log: () => {} }).catch(() => {});
        controller = new AbortController();
      }
    })();

    return () => { stopped = true; controller.abort(); };
  }
}
