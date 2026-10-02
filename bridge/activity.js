// The activity model shared by every harness (Claude Code, Codex, or anything
// that POSTs to the bridge): what the agent did, on which files, how long it
// took and whether it worked.
//
// An entry looks like:
//   {
//     id, session, harness, label, at,
//     kind,    prompt · read · edit · write · run · search · web · agent · mcp · skill · plan · tool · done · error · compact
//     tool,    the harness's own tool name, e.g. "Bash" or "exec_command"
//     title,   one line: a file, a command's description, a search pattern…
//     detail?, a second line
//     files?,  [{ path, change: 'read' | 'edit' | 'write' | 'delete' }]
//     body?,   what you see when you open the row:
//              { command?, patch?, output?, args? }   (all plain text, clipped)
//     status,  running · waiting · ok · failed · stopped · info
//     ms?, error?,
//     summary?, on `done` entries: the agent's closing message for that turn
//   }

export const clip = (s, n = 120) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Clip multi-line text, keeping line breaks. */
export const clipText = (s, n = 4000) => {
  s = String(s ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s;
};

/**
 * Clip a command's output, keeping its start and its end: test runners and builds
 * print their summary ("48 passed", "1 failed") last, and that's what tells whether
 * it worked. Keeps about n characters, half from each end.
 */
export const clipEnds = (s, n = 3000) => {
  s = String(s ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (s.length <= n) return s;
  const head = Math.ceil(n / 2);
  const tail = n - head;
  return `${s.slice(0, head)}\n… (${s.length - n} characters cut) …\n${s.slice(-tail)}`;
};

/** A path relative to the session's folder when it's inside it. */
export function relative(path, cwd) {
  if (!path) return '';
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const p = norm(path);
  const c = cwd ? norm(cwd) : '';
  if (c && p.toLowerCase().startsWith(`${c.toLowerCase()}/`)) return p.slice(c.length + 1);
  return p;
}

/** Last folder name of a path, used as the session's label. */
export const folderName = (cwd) => (cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : undefined);

/** A before/after pair as patch lines: "-old" then "+new". */
export function toPatch(before, after, max = 6000) {
  const lines = (s, sign) => (s ? String(s).replace(/\r\n/g, '\n').split('\n').map((l) => sign + l) : []);
  return clipText([...lines(before, '-'), ...lines(after, '+')].join('\n'), max);
}

const FINAL = new Set(['ok', 'failed']);

/**
 * Keeps the activity history for every session. Entries are merged by id, so
 * sources can report a tool call in pieces (start, approval, result) and in any
 * order: hooks run as separate processes, so a result can arrive before its start.
 */
export function createActivityLog({ limit = 800 } = {}) {
  const bySession = new Map(); // session → entries (oldest first)
  const byId = new Map();      // entry id → entry

  function upsert(patch) {
    const entry = byId.get(patch.id);
    if (!entry) {
      const fresh = { ...patch };
      const list = bySession.get(fresh.session) ?? [];
      // Keep each session's entries in time order, even when history is backfilled late.
      let i = list.length;
      while (i > 0 && list[i - 1].at > fresh.at) i--;
      list.splice(i, 0, fresh);
      if (list.length > limit) byId.delete(list.shift().id);
      bySession.set(fresh.session, list);
      byId.set(fresh.id, fresh);
      return fresh;
    }
    const { status, at, ...rest } = patch;
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      if (key === 'body') entry.body = { ...entry.body, ...value };
      else entry[key] = value;
    }
    if (status && !FINAL.has(entry.status)) entry.status = status;
    entry.at ??= at;
    return entry;
  }

  return {
    upsert,
    get: (id) => byId.get(id),
    /** The newest entry in a session that matches `test`. */
    findLast(session, test) {
      const list = bySession.get(session) ?? [];
      for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return list[i];
      return null;
    },
    /** When a turn ends, tools that never reported back stop spinning. */
    settle(session) {
      return (bySession.get(session) ?? []).filter((entry) => {
        if (entry.status !== 'running' && entry.status !== 'waiting') return false;
        entry.status = 'stopped';
        return true;
      });
    },
    has: (session) => bySession.has(session),
    /** Every entry, oldest first, for replaying to a new viewer. */
    all: () => [...bySession.values()].flat().sort((a, b) => a.at - b.at),
    /** Every entry in no particular order, without copying or sorting (for scans that don't need order). */
    *each() { for (const list of bySession.values()) yield* list; },
    clear() {
      bySession.clear();
      byId.clear();
    },
    forget(session) {
      for (const entry of bySession.get(session) ?? []) byId.delete(entry.id);
      bySession.delete(session);
    },
  };
}
