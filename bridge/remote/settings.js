// Settings → Remote, in the dashboard. One module, two faces:
//  - on the COMPUTER (the dashboard at 127.0.0.1): turn the remote client on, make a pairing QR code,
//    see and manage paired devices (rename, let one control, sign one out).
//  - on a PAIRED DEVICE: this device's own settings: install the app, notifications and which kinds,
//    send a test, sign this device out.
// Built with DOM calls only (no innerHTML), so nothing from the network is ever parsed as markup.
import { phoneRecord, pushList, pushVerdict, workerNote } from './push-words.js';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const card = $('remote-card');
if (card) init();

function init() {
  // The remote server adds this tag to the pages it serves to a device; the computer's own dashboard has none.
  const onDevice = document.querySelector('meta[name="dotpals-face"]')?.content === 'device';
  const call = async (path, body) => {
    const res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || `Error ${res.status}`), { status: res.status, data });
    return data;
  };
  const toast = (text) => { const t = $('toast'); if (!t) return; t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200); };
  const row = (title, note, control) => {
    const r = el('div', 'row');
    const text = el('div', 'text', title);
    if (note) text.append(el('small', '', note));
    r.append(text);
    if (control) r.append(control);
    return r;
  };
  const sw = (checked, onchange, label) => { const i = el('input', 'switch'); i.type = 'checkbox'; i.checked = !!checked; i.setAttribute('aria-label', label); i.onchange = () => onchange(i); return i; };
  const btn = (text, onclick, cls = '') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = onclick; return b; };
  const KINDS = [
    ['done', 'A request finishes', 'Only ones that took a while.'], ['waiting', 'An agent is waiting for you', 'Still waiting after 20 seconds.'],
    ['approval', 'An agent asks permission', 'Needs “Let this device control”.'], ['stuck', 'An agent seems stuck', 'Going in circles.'],
    ['conflict', 'Two agents, one file', ''], ['loop', 'An agent gave up on failing tests', ''], ['context', 'A context window is nearly full', 'Off by default.'],
  ];
  // -- on the computer ---------------------------------------------------------------------------------
  function drawQr(rows) {
    const scale = 6, quiet = 4, n = rows.length, size = (n + quiet * 2) * scale;
    const c = el('canvas', 'rc-qr');
    c.width = c.height = size;
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', 'Pairing QR code');
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, size, size);
    g.fillStyle = '#000';
    rows.forEach((r, y) => { for (let x = 0; x < n; x++) if (r[x] === '1') g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale); });
    c.style.cssText = 'width:min(240px,100%);height:auto;image-rendering:pixelated;border-radius:10px;background:#fff';
    return c;
  }
  // What a push is said to have done, in words (push-words.js, tested). The phone can also be asked what IT saw last: that is
  // the one thing the push service can't say, and it tells "never reached the phone" from "reached it and wasn't shown".
  let phone = { version: null, build: 0, last: null, since: 0 };
  const readPhone = async () => {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      const w = await new Promise((ok) => {
        const ch = new MessageChannel();
        const done = (value) => { clearTimeout(timer); ch.port1.close(); ch.port2.close(); ok(value); };
        const timer = setTimeout(() => done(null), 2000);
        ch.port1.onmessage = (e) => done(e.data ?? null);
        (reg.active ?? reg.waiting)?.postMessage({ type: 'version' }, [ch.port2]);
      });
      const log = await caches.open('dotpals-push-log').catch(() => null);
      const read = (key) => (log ? log.match(key).then((r) => (r ? r.json() : null)).catch(() => null) : Promise.resolve(null));
      const [last, started] = await Promise.all([read('/__last-push'), read('/__worker')]);
      phone = { version: w?.version ?? null, build: w?.build ?? 0, last, since: started?.at ?? 0 };
    } catch { /* no worker yet: the page says so */ }
  };
  readPhone();
  const when = (at) => { if (!at) return 'never'; const s = Math.round((Date.now() - at) / 1000); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };

  async function computerFace() {
    let state = null;
    let pairing = null; // { code, url, qr, secure, expiresAt }
    let tick = null;
    let changing = false;
    const draw = () => {
      if (!state) return;
      const nodes = [el('h2', '', 'Remote')];
      nodes.push(el('p', 'muted', 'Use dotpals from your phone or tablet: the same dashboard, live, with notifications. Off until you turn it on.'));
      nodes.push(row('Remote client', state.error || (state.running ? `Listening on port ${state.port}${state.bind === 'lan' ? ' (your network)' : ' (this computer only: put a tunnel or Tailscale in front)'}.` : 'Off.'),
        sw(state.enabled, async (i) => { await save({ enabled: i.checked }); })));
      if (state.enabled) {
        const where = el('select'); where.setAttribute('aria-label', 'Who can reach it');
        for (const [v, t] of [['local', 'This computer only (use a tunnel or Tailscale)'], ['lan', 'Anything on my network']]) where.add(new Option(t, v, false, v === state.bind));
        where.onchange = () => save({ bind: where.value });
        const port = el('input'); port.type = 'number'; port.min = 1024; port.max = 65535; port.value = state.port;
        port.setAttribute('aria-label', 'Remote port');
        port.onchange = () => save({ port: Number(port.value) }).catch((e) => toast(e.message));
        nodes.push(row('Port', 'Use this port in the HTTPS address or proxy configuration.', port));
        nodes.push(row('Reachable from', 'A phone needs https to install the app and get notifications: use a tunnel (Cloudflare, Tailscale) or your own certificate.', where));
        const url = el('input'); url.type = 'url'; url.placeholder = 'https://dotpals.example.com'; url.value = state.publicUrl; url.setAttribute('aria-label', 'Public address');
        url.onchange = () => save({ publicUrl: url.value.trim() }).catch((e) => toast(e.message));
        nodes.push(row('Address your devices open', 'The https address of your tunnel or proxy. Leave empty to use this computer’s address on your network. It goes in the QR code.', url));
        if (state.bind === 'lan') {
          const lan = state.lan ?? {};
          const auto = sw(lan.auto, (i) => save({ tlsAuto: i.checked, ...(i.checked ? { tlsCert: '', tlsKey: '' } : {}) }).catch((e) => toast(e.message)), 'https on my network');
          nodes.push(row('https on my network', lan.auto
            ? `dotpals keeps its own certificate and renews it when this computer’s address changes${lan.note ? `. ${lan.note}` : ''}. It needs openssl (Git for Windows has one).`
            : 'Turn on to serve https here with a private certificate, no tunnel. Each phone trusts it once.', auto));
          if (lan.auto) {
            const names = [...(lan.addresses ?? []), lan.name].filter(Boolean).join('  ·  ');
            nodes.push(row('Covers', names || 'No private network address found: connect to Wi-Fi or Ethernet.'));
            const fp = el('code', 'mono', lan.caFingerprint ?? 'not made yet'); fp.style.cssText = 'font-size:11px;word-break:break-all;display:block;max-width:100%';
            nodes.push(row('Install this certificate on each device, once', lan.caFile ? `Copy ${lan.caFile} to the phone and install it as a CA certificate (the file is public; its key never leaves this computer). Check the fingerprint matches:` : 'Made the first time https starts.', fp));
          }
        }
      }
      if (state.running) {
        const box = el('div', 'rc-pair');
        box.style.cssText = 'display:grid;gap:12px;justify-items:center;padding:14px 0';
        if (pairing) {
          box.append(drawQr(pairing.qr));
          const code = el('code', '', pairing.code); code.style.cssText = 'font-size:20px;letter-spacing:.1em';
          box.append(code, el('small', 'muted', pairing.url));
          if (pairing.byName) box.append(el('small', 'muted', `By name, if this phone can look up .local names: ${pairing.byName}`));
          if (!pairing.secure) box.append(el('small', 'bad', 'This address isn’t https, so a phone can’t finish pairing over it. Set an https address above.'));
          const left = el('small', 'muted'); left.id = 'rc-left';
          box.append(left, btn('Cancel', cancel));
        } else box.append(btn('Pair a device', start, 'primary'));
        nodes.push(box);
      }
      if (state.devices.length) {
        nodes.push(el('h3', '', 'Paired devices'));
        for (const d of state.devices) nodes.push(deviceRow(d));
        nodes.push(row('Sign out every device', 'Removes all of them at once.', btn('Sign out all', async () => { if (confirm('Sign out every paired device?')) { state = await call('/api/remote/revoke-all', {}); draw(); } }, 'danger')));
      }
      card.replaceChildren(...nodes);
      clearInterval(tick);
      if (pairing) tick = setInterval(countdown, 1000);
      countdown();
    };
    function countdown() {
      const left = $('rc-left'); if (!left || !pairing) return;
      const s = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
      left.textContent = s ? `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}. Works once.` : 'Expired.';
      if (!s) { pairing = null; draw(); }
    }
    const editing = () => card.contains(document.activeElement) && document.activeElement.matches('input, select, textarea');
    const refresh = async ({ preserveEdit = false } = {}) => {
      if (preserveEdit && (editing() || changing)) return;
      try {
        const next = await call('/api/remote');
        if (preserveEdit && (editing() || changing)) return;
        state = next;
        if (pairing && state.claimed?.includes(pairing.id)) { pairing = null; toast('Device paired'); }
        draw();
      } catch (e) { if (!preserveEdit || !editing()) card.replaceChildren(el('h2', '', 'Remote'), el('p', 'bad', e.message)); }
    };
    async function save(patch) { await call('/api/config', { remote: patch }); await new Promise((r) => setTimeout(r, 250)); await refresh(); }
    async function start() { try { pairing = await call('/api/remote/pair', {}); draw(); } catch (e) { toast(e.message); } }
    async function cancel() { try { await call('/api/remote/pair/cancel', {}); pairing = null; draw(); } catch (e) { toast(e.message); } }
    function deviceRow(d) {
      const box = el('div', 'rc-device');
      box.style.cssText = 'border-top:1px solid var(--line);padding:6px 0';
      const name = el('input'); name.value = d.name; name.maxLength = 40; name.setAttribute('aria-label', `Name of ${d.name}`);
      name.onchange = async () => { state = await call(`/api/remote/devices/${d.id}`, { name: name.value }); draw(); };
      const status = d.open ? 'Open now' : `Last seen ${when(d.lastSeen)}`;
      const lp = d.lastPush;
      const pushNote = !d.push ? 'Notifications off.' : lp ? `Notifications on. Last: ${pushVerdict(lp, when(lp.at))}` : 'Notifications on.';
      box.append(row(status, pushNote, name));
      box.append(row('Let this device control', 'Off: it can look and change appearance. On: it can also hand off sessions, rewind and start coding tasks. Permission prompts and Apps stay on the desktop.',
        sw(d.control, async (i) => {
          const control = i.checked;
          i.checked = d.control;
          if (control && !confirm(`Let “${d.name}” control dotpals, including starting coding tasks?`)) return;
          changing = i.disabled = true;
          try { state = await call(`/api/remote/devices/${d.id}`, { control }); draw(); }
          catch (e) {
            toast(e.message);
            try { state = await call('/api/remote'); draw(); }
            catch { i.indeterminate = true; i.setAttribute('aria-label', `Control permission for ${d.name} is unknown. Refresh to check.`); }
          } finally { changing = false; }
        }, `Let ${d.name} control`)));
      const acts = el('div', 'acts'); acts.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding-bottom:8px';
      if (d.push) acts.append(btn('Send a test', async () => { await call(`/api/remote/devices/${d.id}/test`, {}); toast('Sent'); }));
      acts.append(btn('Sign out', async () => { state = await call(`/api/remote/devices/${d.id}/revoke`, {}); draw(); }, 'danger'));
      box.append(acts);
      return box;
    }
    refresh();
    addEventListener('hashchange', () => { if (location.hash.startsWith('#settings/remote')) refresh(); });
    setInterval(() => { if (location.hash.startsWith('#settings/remote') && !document.hidden) refresh({ preserveEdit: true }); }, 4000);
  }
  // -- on a paired device --------------------------------------------------------------------------------
  async function deviceFace() {
    let me = null;
    const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } finally { await load(); } };
    const set = (patch) => call('/api/remote/me/prefs', patch);
    function draw() {
      const nodes = [el('h2', '', 'This device')];
      nodes.push(row('Name', 'Shown on your computer.', (() => { const i = el('input'); i.value = me.name; i.maxLength = 40; i.setAttribute('aria-label', 'Name of this device'); i.onchange = guard(() => set({ name: i.value })); return i; })()));
      nodes.push(row(me.control ? 'This device can control dotpals' : 'This device can look, not control', me.control ? 'Hand-offs, rewinds, coding tasks and settings are allowed. Permission cards and desktop actions still need the desktop.' : 'Turn it on from the computer: Settings → Remote → Let this device control.'));

      const P = window.dotpalsPush;
      const asked = P?.permission?.();
      nodes.push(el('h3', '', 'App'));
      const inst = window.dotpalsInstall;
      if (inst?.done) nodes.push(row('Installed', 'dotpals is on your home screen.'));
      else if (inst?.prompt) nodes.push(row('Install dotpals', 'Opens like an app, with its own icon.', btn('Install', async () => { inst.prompt.prompt(); await inst.prompt.userChoice; inst.prompt = null; draw(); }, 'primary')));
      else nodes.push(row('Install dotpals', /iPhone|iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document ? 'Tap Share, then “Add to Home Screen”.' : 'Use your browser’s menu: “Install app” or “Add to Home screen”.'));

      // Check for an update by hand, and apply it: the same explicit check the pdsvc dashboard has.
      const U = window.dotpalsUpdate;
      if (U) {
        const s = U.state();
        const w = U.words(s);
        const act = w.action === 'update' ? btn('Update', () => { U.apply(); }, 'primary')
          : w.action === 'check' ? btn('Check for updates', async () => { await U.check(); draw(); })
            : null;
        nodes.push(row(w.title, `${w.note}${phone.version ? ` Running ${phone.version}.` : ''}`.trim(), act));
      }

      nodes.push(el('h3', '', 'Notifications'));
      if (!P?.supported?.()) nodes.push(row('Not available', 'This browser can’t receive notifications here. On iPhone or iPad, add dotpals to the Home Screen first.'));
      else if (asked === 'denied') nodes.push(row('Blocked', 'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back.'));
      else {
        nodes.push(row('Notify this device', 'Receive background notifications. Use “Only when I’m away” to skip them while the app is in front.',
          sw(me.push && asked === 'granted', guard(async (i) => { if (i.checked) await P.enable(); else await P.disable(); }), 'Notify this device')));
        if (me.push) {
          nodes.push(row('Only when I’m away', 'Skip notifications while the app is open on this device.', sw(me.prefs.quietWhenOpen, guard((i) => set({ prefs: { quietWhenOpen: i.checked } })), 'Skip while open')));
          for (const [k, title, note] of KINDS) nodes.push(row(title, note, sw(me.prefs[k], guard((i) => set({ prefs: { [k]: i.checked } })), title)));
          const lp = me.lastPush;
          nodes.push(row('Check it works', `Sends a notification now, even with the app open. ${pushVerdict(lp, new Date(lp?.at).toLocaleTimeString())}`, btn('Send a test', guard(async () => { await call('/api/remote/me/test', {}); await new Promise((r) => setTimeout(r, 5000)); await readPhone(); }))));
          const recent = row('Recent pushes', me.pushes?.length ? '' : 'None since dotpals started.');
          for (const line of pushList(me.pushes)) recent.querySelector('.text')?.append(el('small', '', line));
          nodes.push(recent);
          nodes.push(row('What this phone saw', phoneRecord(phone.last, lp, phone.since, phone.build)));
          nodes.push(row('This phone is running', workerNote(me.version, phone)));
        }
      }
      nodes.push(el('h3', '', 'Foldable'));
      const fold = window.dotpalsFold?.fold?.();
      nodes.push(row('Layout', fold === 'book' ? 'Two screens side by side: one pane on each, nothing across the hinge.' : fold === 'table' ? 'Half-open: content above, controls below the hinge.' : 'Flat. Fold or span the device and the layout follows.'));
      nodes.push(el('h3', '', 'Sign out'));
      nodes.push(row('Sign this device out', 'You’ll pair again to use it.', btn('Sign out', async () => { if (!confirm('Sign this device out?')) return; await call('/api/remote/me/signout', {}); location.replace('/pair'); }, 'danger')));
      card.replaceChildren(...nodes);
    }
    // Read what the phone itself saw BEFORE drawing: drawn first, "What this phone saw" would say "nothing" for a push it did get.
    async function load() { try { me = await call('/api/remote/me'); await readPhone(); draw(); } catch (e) { card.replaceChildren(el('h2', '', 'This device'), el('p', 'bad', e.message)); } }
    load();
    addEventListener('dotpals:install', () => me && draw());
    // The update row follows the updater (checking, ready, applying), without redrawing when it isn't on screen.
    const watchUpdate = () => window.dotpalsUpdate?.onChange(() => { if (me && location.hash.startsWith('#settings/remote')) draw(); });
    if (window.dotpalsUpdate) watchUpdate(); else addEventListener('load', watchUpdate, { once: true });
    addEventListener('hashchange', () => { if (location.hash.startsWith('#settings/remote')) load(); });
  }
  (onDevice ? deviceFace : computerFace)();
}
