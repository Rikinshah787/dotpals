// The bridge between the floating window's page and the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dotpalsDesktop', {
  /** Stream bridge events: onEvent({ type: 'message' | 'activity', data }), onStatus(connected). */
  connect(onEvent, onStatus) {
    ipcRenderer.removeAllListeners('bridge:event');
    ipcRenderer.removeAllListeners('bridge:status');
    ipcRenderer.on('bridge:event', (_, e) => onEvent(e));
    ipcRenderer.on('bridge:status', (_, on) => onStatus(on));
    ipcRenderer.send('bridge:connect');
  },
  /** onHover(inside): whether the mouse is over the window. */
  onHover(onHover) {
    ipcRenderer.removeAllListeners('window:hover');
    ipcRenderer.on('window:hover', (_, inside) => onHover(inside));
  },
  /** onSetCompact(compact): the tray menu toggled "Just the pal". */
  onSetCompact(callback) {
    ipcRenderer.removeAllListeners('window:set-compact');
    ipcRenderer.on('window:set-compact', (_, compact) => callback(compact));
  },
  /** Drag the window by the pal; the app follows the real cursor. */
  dragStart: (x, y) => ipcRenderer.send('window:drag-start', x, y),
  dragTo: () => ipcRenderer.send('window:drag-to'),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  /** Let clicks through the transparent parts of the window (small mode). */
  setIgnoreMouse: (on) => ipcRenderer.send('window:ignore-mouse', !!on),
  setCompact: (compact) => ipcRenderer.invoke('window:compact', compact),
  isCompact: () => ipcRenderer.invoke('window:is-compact'),
  close: () => ipcRenderer.send('window:close'),
  show: () => ipcRenderer.send('window:show'),
  openDashboard: () => ipcRenderer.send('dashboard:open'),
  getOpenAtLogin: () => ipcRenderer.invoke('login:get'),
  setOpenAtLogin: (on) => ipcRenderer.invoke('login:set', on),
  copy: (text) => ipcRenderer.send('clipboard:write', text),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  /** Plan usage limits: { agents: [{ harness, window, weekly, … }] } (see bridge/usage.js). */
  usage: () => ipcRenderer.invoke('usage'),
  /**
   * onCursor({ x, y }): where the mouse is, relative to this window's content in CSS px
   * (anywhere on screen, so it can be outside the window), ~30 times a second while it
   * moves (or the window moves under it). Also `width` and `height`: the content size
   * x and y are measured against. Returns a function that stops listening.
   */
  onCursor(callback) {
    const listener = (_, p) => callback(p);
    ipcRenderer.on('window:cursor', listener);
    return () => ipcRenderer.removeListener('window:cursor', listener);
  },
  /** The operating system, for showing shortcuts ("Ctrl+Alt+Y" or "⌘⌥Y"). */
  platform: process.platform,
  /**
   * The notch asks for its window to fit: the window's size, and the island's
   * { w, h } (hanging from the top centre), the only part that takes clicks.
   */
  notchSize: (width, height, island) => ipcRenderer.send('notch:size', width, height, island ?? null),
  /** The notch's shortcuts: { escape, approval } → which ones got registered { escape, allow, deny }. */
  notchKeys: (want) => ipcRenderer.invoke('notch:keys', want),
  /** onNotchKey('escape' | 'allow' | 'deny'): one of those shortcuts was pressed. */
  onNotchKey(callback) {
    ipcRenderer.removeAllListeners('notch:key');
    ipcRenderer.on('notch:key', (_, key) => callback(key));
  },
  /** onIdle(seconds): how long since the last keyboard or mouse input (every 2 s). */
  onIdle(callback) {
    ipcRenderer.removeAllListeners('notch:idle');
    ipcRenderer.on('notch:idle', (_, seconds) => callback(seconds));
  },
});
