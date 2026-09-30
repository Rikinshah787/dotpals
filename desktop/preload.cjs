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
  setCompact: (compact) => ipcRenderer.invoke('window:compact', compact),
  isCompact: () => ipcRenderer.invoke('window:is-compact'),
  close: () => ipcRenderer.send('window:close'),
  show: () => ipcRenderer.send('window:show'),
  copy: (text) => ipcRenderer.send('clipboard:write', text),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
});
