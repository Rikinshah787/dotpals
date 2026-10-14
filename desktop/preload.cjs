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
  /** Small mode: the areas that take clicks, [[left, top, width, height], …] (null: all of it). */
  setSolidAreas: (rects) => ipcRenderer.send('window:solid-areas', rects),
  setCompact: (compact) => ipcRenderer.invoke('window:compact', compact),
  isCompact: () => ipcRenderer.invoke('window:is-compact'),
  /** Small mode: make room above the pal for the chat bubble. */
  setTalking: (on) => ipcRenderer.invoke('window:talk', on),
  close: () => ipcRenderer.send('window:close'),
  show: () => ipcRenderer.send('window:show'),
  /** Show the pal in small mode (just the pal). */
  showMini: () => ipcRenderer.send('window:show-mini'),
  /** The notch's pal button: show the pal (small) when it's hidden, hide it when it's showing. */
  togglePal: () => ipcRenderer.send('window:toggle-mini'),
  palShown: () => ipcRenderer.invoke('window:pal-shown'),
  /** onPalShown(shown): the pal window appeared or went away. */
  onPalShown(callback) {
    ipcRenderer.removeAllListeners('notch:pal');
    ipcRenderer.on('notch:pal', (_, shown) => callback(shown));
  },
  /** onGreet(): wave hello (the pal was just brought back). */
  onGreet(callback) {
    ipcRenderer.removeAllListeners('window:greet');
    ipcRenderer.on('window:greet', () => callback());
  },
  /** onHello(): say good morning and ask what to work on. */
  onHello(callback) {
    ipcRenderer.removeAllListeners('window:hello');
    ipcRenderer.on('window:hello', () => callback());
  },
  /** Ask for a project folder: its path, or null when cancelled. */
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
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
  /** onNotchKey('escape' | 'allow' | 'deny' | 'talk'): one of those shortcuts was pressed. */
  onNotchKey(callback) {
    ipcRenderer.removeAllListeners('notch:key');
    ipcRenderer.on('notch:key', (_, key) => callback(key));
  },
  /** Dictate (bridge/dictate.html): onDictate('toggle' | 'cancel'): its shortcut (start, or finish now), or Esc. */
  onDictate(callback) {
    ipcRenderer.removeAllListeners('dictate:key');
    ipcRenderer.on('dictate:key', (_, what) => callback(what));
  },
  /** Type this where the cursor is (the app pastes it, then puts your clipboard back) → { ok, copied?, error? }. */
  dictateType: (text) => ipcRenderer.invoke('dictate:type', text),
  /** Dictate is 'listening' (Esc cancels it), or 'hide' (it's done: hide the pill). */
  dictateState: (state) => ipcRenderer.send('dictate:state', state),
  /** "Blu, …" said to Dictate: hand the request to Talk in the notch (with a screenshot). */
  dictateToBlu: (text) => ipcRenderer.send('dictate:blu', text),
  /** The notch: onTalkText({ text, shot }), a request said to Blu from Dictate. */
  onTalkText(callback) {
    ipcRenderer.removeAllListeners('notch:talk-text');
    ipcRenderer.on('notch:talk-text', (_, said) => callback(said));
  },
  // -- Blu, the screen buddy (bridge/buddy.js, desktop/hands.js) ------------------------------
  /** The notch: onTalkShot(shot), the screenshot taken as Talk's shortcut was pressed ({ path, w, h, x, y } or null). */
  onTalkShot(callback) {
    ipcRenderer.removeAllListeners('notch:talk-shot');
    ipcRenderer.on('notch:talk-shot', (_, shot) => callback(shot));
  },
  /** The notch: onTalkCircle({ shot, circled }), you circled something (Ctrl+Alt+C): ask about it. */
  onTalkCircle(callback) {
    ipcRenderer.removeAllListeners('notch:talk-circle');
    ipcRenderer.on('notch:talk-circle', (_, data) => callback(data));
  },
  /** A fresh screenshot of the screen you're on → { path, w, h, x, y } or null. */
  bluShot: () => ipcRenderer.invoke('blu:shot'),
  /** Draw Blu's marks over the screen a screenshot showed: { marks, shot: its path, keep }. */
  bluDraw: (data) => ipcRenderer.send('blu:draw', data),
  /** Take Blu's drawings off the screen. */
  bluClear: () => ipcRenderer.send('blu:clear'),
  /** Do these actions on the computer → a receipt for each [{ act, ok, words, error? }]. `shot`: the screenshot's path, for clicks. */
  bluDo: (data) => ipcRenderer.invoke('blu:do', data),
  /** The music card: 'info' → what's playing { title, artist, playing, app } or null; 'play' | 'pause' | 'playpause' | 'next' | 'previous' | 'louder' | 'quieter' → a receipt. */
  bluMedia: (what) => ipcRenderer.invoke('blu:media', what),
  /** Music that's playing goes quieter (true) while Blu listens, and back (false). */
  bluDuck: (on) => ipcRenderer.send('blu:duck', !!on),
  /** Get Blu's hands ready (Windows: its helper starts), while you're still talking. */
  bluWarm: () => ipcRenderer.send('blu:warm'),
  /** onBluDrawing(on): Blu's marks came on screen, or all went away. */
  onBluDrawing(callback) {
    ipcRenderer.removeAllListeners('notch:drawing');
    ipcRenderer.on('notch:drawing', (_, on) => callback(on));
  },
  /** The drawing window (bridge/draw.html): onDrawCmd({ type: 'marks' | 'clear' | 'circle' | 'cancel', … }). */
  onDrawCmd(callback) {
    ipcRenderer.removeAllListeners('draw:cmd');
    ipcRenderer.on('draw:cmd', (_, cmd) => callback(cmd));
  },
  /** The drawing window tells the app: 'empty' (nothing left on screen), 'circled' ({ box, image }). */
  drawEvent: (type, data) => ipcRenderer.send('draw:event', type, data ?? null),
  /** onIdle(seconds): how long since the last keyboard or mouse input (every 2 s). */
  onIdle(callback) {
    ipcRenderer.removeAllListeners('notch:idle');
    ipcRenderer.on('notch:idle', (_, seconds) => callback(seconds));
  },
});
