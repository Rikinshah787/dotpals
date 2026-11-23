// The remote client's live stream, built to cost little on both ends.
//  - Resume: every event gets a sequence number. A device that comes back to the foreground
//    asks for what it missed (`since`), and gets only that, not the whole history again.
//  - Coalescing: an activity entry that changes ten times in a moment is sent once, with its
//    final state, in one write (one radio wake-up), not ten.
//  - Compression: the replay burst and the live writes go through one gzip stream per device.
//  - Bounded: a slow device is dropped (it reconnects and resumes) rather than buffered forever.
//  - Idle: no timers run while no device is connected, and nothing is kept for a device that isn't.
import { randomBytes } from 'node:crypto';
import { constants, createGzip } from 'node:zlib';

/** What identifies the latest version of an event: a newer one replaces an older one of the same key. */
export function keyOf(event, data) {
  switch (event) {
    case 'activity': return data?.id ? `a:${data.id}` : null;
    case null: case undefined: case 'message': return data?.session ? `m:${data.session}` : null;
    case 'context': case 'helpers': return data?.session ? `${event[0]}:${data.session}` : null;
    case 'task': case 'approval': case 'ocask': return data?.id ? `${event}:${data.id}` : null;
    case 'config': case 'laya': case 'agents': case 'apps': return event;
    default: return null; // conflict, loop, stuck, reset…: each one is news
  }
}

export const frame = (event, data, id) => `${id ? `id: ${id}\n` : ''}${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

export function createHub({ keep = 4000, flushMs = 60, maxBuffered = 1024 * 1024, beatMs = 25_000 } = {}) {
  const epoch = randomBytes(3).toString('hex');
  let seq = 0;
  let floor = 0; // changes at or before this are no longer remembered
  const ring = new Map(); // key → { seq, event, data }; Map order is change order, oldest first
  const clients = new Set();
  let beat = null;

  const idOf = (n) => `${epoch}.${n}`;
  const parse = (since) => {
    const m = /^([0-9a-f]{6})\.(\d{1,15})$/.exec(String(since ?? ''));
    return m && m[1] === epoch ? Number(m[2]) : null;
  };

  function remember(event, data) {
    const key = keyOf(event, data) ?? `u:${seq}`;
    ring.delete(key); // re-adding moves it to the newest end
    ring.set(key, { seq, event, data });
    while (ring.size > keep) {
      const [oldest, v] = ring.entries().next().value;
      ring.delete(oldest);
      floor = Math.max(floor, v.seq);
    }
    return key;
  }

  function startBeat() {
    if (beat || !clients.size) return;
    beat = setInterval(() => { for (const c of clients) c.raw(': ping\n\n'); }, beatMs);
    beat.unref?.();
  }
  function stopBeat() { if (beat && !clients.size) { clearInterval(beat); beat = null; } }

  function publish(event, data) {
    seq++;
    const reset = event === 'reset';
    if (reset) { ring.clear(); floor = seq; }
    const key = reset ? `u:${seq}` : remember(event, data);
    for (const c of clients) c.queue(event, data, key, seq, reset);
  }

  /**
   * Attach a response as a live stream. `snapshot(emit)` writes everything now (config, entries,
   * sessions…); `since` is the last id the device saw. Returns { close }.
   */
  function join(req, res, { snapshot, since, deviceId = null, compress = false, headers = {} }) {
    const gzip = compress ? createGzip({ level: 6 }) : null;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no', ...(gzip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}), ...headers,
    });
    gzip?.pipe(res);
    const out = gzip ?? res;
    const pending = new Map(); // key → latest { event, data, n } not yet written
    let timer = null;
    let closed = false;

    const c = {
      deviceId,
      raw(text) {
        if (closed || !text) return;
        if (res.writableLength + (gzip?.writableLength ?? 0) > maxBuffered) return close(); // too slow: it reconnects and resumes
        out.write(text);
        if (gzip) gzip.flush(constants.Z_SYNC_FLUSH);
      },
      queue(event, data, key, n, isReset) {
        if (closed) return;
        if (isReset) pending.clear();
        pending.delete(key);
        pending.set(key, { event, data, n });
        timer ??= setTimeout(flush, flushMs);
      },
      end: () => close(),
    };
    function flush() {
      timer = null;
      if (closed || !pending.size) return;
      let text = '';
      for (const { event, data, n } of pending.values()) text += frame(event, data, idOf(n));
      pending.clear();
      c.raw(text);
    }
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clients.delete(c);
      stopBeat();
      try { gzip ? gzip.end() : res.end(); } catch {}
    }

    // Everything in one write: what changed since the device left, else the whole picture.
    let text = 'retry: 3000\n\n';
    const last = parse(since);
    const resumed = last !== null && last >= floor && last <= seq;
    if (resumed) {
      for (const v of ring.values()) if (v.seq > last) text += frame(v.event, v.data, idOf(v.seq));
    } else {
      if (since) text += frame('reset', {}); // it had something older: start clean
      snapshot((event, data) => { text += frame(event, data); });
    }
    text += frame('ready', { resumed }, idOf(seq));
    c.raw(text);

    clients.add(c);
    startBeat();
    req.on('close', close);
    res.on('error', close);
    return { close };
  }

  return {
    publish, join,
    epoch: () => epoch,
    seq: () => seq,
    open: (deviceId) => [...clients].some((c) => c.deviceId === deviceId),
    /** Drop one device's streams (it was signed out). */
    drop(deviceId) { for (const c of [...clients]) if (c.deviceId === deviceId) c.end(); },
    size: () => clients.size,
    remembered: () => ring.size,
    close() { for (const c of [...clients]) c.end(); },
  };
}
