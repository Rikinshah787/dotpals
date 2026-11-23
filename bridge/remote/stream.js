// A drop-in replacement for EventSource that only holds a connection open while the app is in use.
//   visible        → connected (real time)
//   hidden 15 s    → the connection is closed: no radio, no server work, no battery. Web Push covers you.
//   visible again  → reconnects at once and asks only for what it missed (`since=<last id>`)
// The dashboard's own code is untouched: it still does `new EventSource('/events')`. Runs in <head>
// before it, as a classic script. It announces its state to the page ('dotpals:stream').
(() => {
  const Native = window.EventSource;
  if (!Native || window.__dotpalsStream) return;
  window.__dotpalsStream = true;
  const GRACE = 15_000;
  const state = { value: 'connecting', since: 0, lastId: '' };
  const latestStates = new Map();
  const activity = new Map();
  const announce = (value, extra = {}) => { state.value = value; window.dispatchEvent(new CustomEvent('dotpals:stream', { detail: { state: value, ...extra } })); };
  window.dotpalsStream = { state: () => state.value, lastId: () => state.lastId, snapshot: () => ({ states: [...latestStates.values()], activity: [...activity.values()] }) };

  class Foreground {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    #url; #native = null; #timer = null; #closed = false; #listeners = new Map(); #bound = new Set(); #retry = null; #fails = 0;
    onopen = null; onerror = null; onmessage = null;
    readyState = 0;
    constructor(url) {
      this.#url = String(url);
      this.url = this.#url;
      this.withCredentials = true;
      document.addEventListener('visibilitychange', this.#visibility);
      addEventListener('online', this.#wake);
      addEventListener('pageshow', this.#wake);
      if (document.visibilityState === 'visible') this.#connect(); else { this.readyState = 0; announce('paused'); }
    }
    addEventListener(name, fn) {
      if (typeof fn !== 'function') return;
      if (!this.#listeners.has(name)) this.#listeners.set(name, new Set());
      this.#listeners.get(name).add(fn);
      this.#bind(name);
    }
    removeEventListener(name, fn) { this.#listeners.get(name)?.delete(fn); }
    dispatchEvent() { return true; }
    close() {
      this.#closed = true;
      this.readyState = 2;
      clearTimeout(this.#timer);
      clearTimeout(this.#retry);
      document.removeEventListener('visibilitychange', this.#visibility);
      removeEventListener('online', this.#wake);
      removeEventListener('pageshow', this.#wake);
      this.#drop();
    }
    #drop() { if (this.#native) { this.#native.close(); this.#native = null; this.#bound.clear(); } }
    #bind(name) {
      if (name === 'open' || name === 'error' || !this.#native || this.#bound.has(name)) return;
      this.#bound.add(name);
      this.#native.addEventListener(name, (e) => this.#deliver(name, e));
    }
    #deliver(name, e) {
      if (e.lastEventId) state.lastId = e.lastEventId;
      // The agents' states (the unnamed "message" events) are also announced to the page ('dotpals:state'), so
      // the remote client's pals follow them without a second connection. Nothing else is: the saved history
      // replayed on every reconnect would only cost battery. The dashboard's own listeners are unaffected.
      if (name === 'message') { try {
        const u = JSON.parse(e.data);
        if (typeof u?.session === 'string' && u.session) {
          if (u.state === 'sleeping') latestStates.delete(u.session); else latestStates.set(u.session, u);
        }
        window.dispatchEvent(new CustomEvent('dotpals:state', { detail: u }));
      } catch {} }
      // The Story panel reads a session's steps; the dashboard already holds them all, so this only passes the line on.
      else if (name === 'activity') { try {
        const entry = JSON.parse(e.data);
        if (entry?.id) {
          activity.set(entry.id, entry);
          const mine = [...activity.values()].filter((a) => a.session === entry.session);
          if (mine.length > 120) for (const a of mine.sort((a, b) => a.at - b.at).slice(0, mine.length - 120)) activity.delete(a.id);
        }
        window.dispatchEvent(new CustomEvent('dotpals:activity', { detail: entry }));
      } catch {} }
      else if (name === 'reset') {
        latestStates.clear(); activity.clear();
        window.dispatchEvent(new CustomEvent('dotpals:reset'));
      }
      for (const fn of [this[`on${name}`], ...(this.#listeners.get(name) ?? [])]) {
        if (typeof fn === 'function') { try { fn.call(this, e); } catch (err) { console.error(err); } }
      }
    }
    #connect() {
      if (this.#closed || this.#native || document.visibilityState !== 'visible') return;
      clearTimeout(this.#retry); this.#retry = null;
      announce('connecting');
      const url = state.lastId ? `${this.#url}${this.#url.includes('?') ? '&' : '?'}since=${encodeURIComponent(state.lastId)}` : this.#url;
      this.readyState = 0;
      const es = new Native(url, { withCredentials: true });
      this.#native = es;
      es.onopen = (e) => {
        this.readyState = 1;
        this.#fails = 0;
        announce('live');
        this.#deliver('open', e);
      };
      es.onerror = (e) => {
        this.readyState = es.readyState === 2 ? 2 : 0;
        if (es.readyState === 2) {
          // The browser gave up (the server said no: signed out, or it's down). Retry quietly with a back-off.
          this.#drop();
          announce(++this.#fails > 3 ? 'closed' : 'offline', { status: 'refused' });
          if (!this.#closed && document.visibilityState === 'visible') this.#retry = setTimeout(() => this.#connect(), Math.min(30_000, 1000 * 2 ** this.#fails));
        } else announce('offline');
        this.#deliver('error', e);
      };
      this.#bound.clear();
      for (const name of this.#listeners.keys()) this.#bind(name);
      this.#bind('message');
      this.#bind('activity');
      this.#bind('reset');
    }
    #visibility = () => {
      if (this.#closed) return;
      if (document.visibilityState === 'visible') { clearTimeout(this.#timer); this.#timer = null; this.#connect(); }
      else {
        clearTimeout(this.#retry); this.#retry = null;
        if (!this.#timer) this.#timer = setTimeout(() => { this.#timer = null; this.#drop(); this.readyState = 0; announce('paused'); }, GRACE);
      }
    };
    #wake = () => { if (!this.#closed && document.visibilityState === 'visible' && !this.#native) { clearTimeout(this.#retry); this.#connect(); } };
  }
  window.EventSource = Foreground;
})();
