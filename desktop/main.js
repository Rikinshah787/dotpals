// dotpals desktop: the live pal in a small always-on-top window, so it floats
// above your editor without a browser tab. Starts the bridge if it isn't running.
//
//   npm run float        (or `node desktop/launch.js`)
//
// Closing hides it to the tray; Ctrl+Alt+P (Cmd+Option+P on macOS) shows or
// hides it from anywhere. Quit from the tray menu.
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
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
    win.on('hide', syncNotch);
    win.on('show', syncNotch);

    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      win.hide();
    });
    win.on('closed', () => { clearInterval(hover); win = null; });

    win.loadURL(`${bridge}/?float=1`).catch(() => win.loadFile(page, { query: { float: '1' } }));
  }

  // -- the notch: a small island at the top of the screen ------------------------
  // What every agent is doing, its plan and your usage limits. It opens on hover.
  // The window is always exactly the island's size (the page tells us), so it
  // never blocks clicks around it, on any platform.
  let notch;
  function createNotch() {
    if (notch && !notch.isDestroyed()) { if (!notch.isVisible()) notch.showInactive(); return; }
    const area = screen.getPrimaryDisplay().workArea;
    const size = { width: 230, height: 58 };
    notch = new BrowserWindow({
      ...size,
      x: Math.round(area.x + (area.width - size.width) / 2),
      y: area.y,
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      alwaysOnTop: true, resizable: false, movable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, show: false, title: 'dotpals notch',
      type: process.platform === 'darwin' ? 'panel' : undefined,
      webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true },
    });
    notch.setAlwaysOnTop(true, 'screen-saver');
    notch.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    notch.once('ready-to-show', () => notch.showInactive());
    notch.on('closed', () => { notch = null; });
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
  // Keep the island centred at the top as it grows and shrinks.
  let shrink;
  ipcMain.on('notch:size', (event, width, height) => {
    if (!notch || notch.isDestroyed() || event.sender !== notch.webContents) return;
    const area = screen.getPrimaryDisplay().workArea;
    const w = Math.round(Math.min(Math.max(width, 120), 520));
    const h = Math.round(Math.min(Math.max(height, 40), 480));
    const apply = () => { try { notch?.setBounds({ x: Math.round(area.x + (area.width - w) / 2), y: area.y, width: w, height: h }); } catch {} };
    clearTimeout(shrink);
    // Grow at once; shrink after the island's closing animation.
    const [cw, ch] = notch.getSize();
    if (w < cw || h < ch) shrink = setTimeout(apply, 420); else apply();
  });
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
    if (!compact) win.setIgnoreMouseEvents(false);
    win.setResizable(true);
    win.setBounds({ x: x + w - next.width, y: y + h - next.height, ...next });
    win.setResizable(!compact);
    const [nx, ny] = win.getPosition();
    Object.assign(prefs, { x: nx, y: ny });
    savePrefs();
  });
  ipcMain.handle('window:is-compact', () => !!prefs.compact);
  // Click-through for the transparent parts of the small window. Windows and macOS keep
  // sending mouse moves while it's on, so the page can turn it off over the pal again;
  // Linux can't, so there the window just stays solid.
  ipcMain.on('window:ignore-mouse', (_, on) => {
    if (!win || process.platform === 'linux') return;
    win.setIgnoreMouseEvents(!!on && !!prefs.compact, { forward: true });
  });
  ipcMain.on('window:show', show);
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
          const res = await fetch(`${bridge}/events`, { signal: controller.signal });
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
