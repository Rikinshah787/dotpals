// The agent report card: how each agent's work held up, from what it did, not what it said.
// Shared by the dashboard's Report card page and the MCP tool `report_card`, so both give
// the same numbers. Plain functions over turns (bridge/ui/recap.js buildTurns).
import { harnessName, hours, plural, short, tokenLine, tokens, turnTime } from './recap.js';
import { changedCode, claimCheck, retries, stuck, testState, weakenedTests } from './story.js';

/**
 * One agent's numbers over a set of requests (turns of that agent):
 *   requests  asked (turns with a prompt)
 *   changed   finished requests that changed code
 *   passed    of those, the ones whose last test run passed after the last change, and not
 *             only because the tests were changed
 *   untested  of those, the ones with no test run after the last change
 *   faked     requests whose tests passed only after they were changed
 *   claims    things a summary said it did that didn't happen (claimCheck)
 *   stuck     requests that went round in circles (stuck()) before they ended
 *   fixTries  how many tries a failure took to fix, on average (null: nothing was fixed)
 *   tokens    tokens per request, for requests whose agent logs them (null: none do)
 *   cost      what the tokens bought, in new tokens (input, cache writes and output; cache
 *             reads cost far less and aren't counted), for requests whose agent logs them:
 *               perPass  per code change that was tested after it and passed
 *               wasted   on code changes that didn't hold up (failing, untested, faked)
 *               retries  on the tries after a failure, until it was fixed or the request ended
 *               total    on every request; null when no request logged tokens
 *   time      time spent on finished requests (ms)
 */
export function agentStats(turns) {
  const s = { requests: 0, changed: 0, passed: 0, untested: 0, faked: 0, claims: 0, stuck: 0, fixTries: null, tokens: null, cost: null, time: 0 };
  const fixes = [];
  const used = [];
  const cost = { perPass: null, wasted: 0, retries: 0, total: 0 };
  const passes = [];
  for (const t of turns) {
    if (t.prompt) s.requests++;
    s.time += turnTime(t);
    const spent = fresh(t.usage);
    if (spent != null) used.push(t.usage); // only requests whose agent logged tokens
    cost.total += spent ?? 0;
    const chains = [...retries(t.steps).chains.values()];
    for (const c of chains) if (c.outcome === 'fixed') fixes.push(c.attempts.length);
    // The tokens of the replies that came after a failure, while the agent tried again. A
    // reply's tokens go on the newest step before it (activity.js addUsage), so the reply that
    // read the failure and made the next try sits on the failed step itself: it counts, and
    // the reply on the last try doesn't (that one came after it).
    const retrying = new Set();
    for (const c of chains) {
      if (c.attempts.length < 2) continue;
      const from = c.attempts[0].at;
      const to = c.attempts.at(-1).at;
      for (const e of t.steps) if (e.at >= from && e.at < to) retrying.add(e);
    }
    for (const e of retrying) cost.retries += fresh(e.usage) ?? 0;
    const last = Math.max(t.at, ...t.steps.map((e) => e.at ?? 0));
    if (stuck(t.steps, { now: t.end?.at ?? last, from: t.at })) s.stuck++;
    if (!t.end || t.end.kind !== 'done') continue;
    s.claims += claimCheck(t).length;
    const tested = testState(t.steps);
    const weak = tested?.state === 'passing' && weakenedTests(t.steps);
    if (weak) s.faked++;
    if (!changedCode(t.steps)) continue;
    s.changed++;
    const held = tested?.state === 'passing' && !weak;
    if (held) s.passed++;
    else if (!tested || tested.state === 'untested' || tested.state === 'stale') s.untested++;
    if (spent != null) { if (held) passes.push(spent); else cost.wasted += spent; }
  }
  if (fixes.length) s.fixTries = fixes.reduce((a, b) => a + b, 0) / fixes.length;
  const k = tokens(...used);
  if (k) s.tokens = Object.fromEntries(Object.entries(k).map(([key, v]) => [key, key === 'replies' ? v : Math.round(v / used.length)]));
  if (used.length) {
    if (passes.length) cost.perPass = Math.round(passes.reduce((a, b) => a + b, 0) / passes.length);
    s.cost = cost;
  }
  return s;
}

/**
 * The new tokens in a usage map (input, cache writes and output; not cache reads, which
 * cost a fraction), or null when there's none: what the work cost, comparable across agents.
 */
function fresh(usage) {
  const k = tokens(usage);
  return k ? k.input + k.cacheWrite + k.output : null;
}

/** Every agent's numbers, busiest first: [{ harness, name, ...agentStats }]. `turns` may mix agents. */
export function reportCard(turns) {
  const by = new Map();
  for (const t of turns) by.set(t.harness, [...(by.get(t.harness) ?? []), t]);
  return [...by].map(([harness, list]) => ({ harness, name: harnessName(harness), ...agentStats(list) }))
    .sort((a, b) => b.requests - a.requests || b.changed - a.changed);
}

const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '');

/**
 * The rows of the card, in order: { key, label, lead?, cells: [{ text, warn }] }, one cell per
 * agent column. `lead`: the headline row (did the code it changed hold up).
 */
export function reportRows(card) {
  const row = (key, label, cell, extra = {}) => ({ key, label, ...extra, cells: card.map(cell) });
  return [
    row('requests', 'Requests', (a) => ({ text: String(a.requests) })),
    row('passed', 'Changed code, tested and passed', (a) => ({ text: a.changed ? `${a.passed} of ${a.changed} (${pct(a.passed, a.changed)})` : '—', warn: a.changed > 0 && a.passed < a.changed }), { lead: true }),
    row('untested', 'Changed code, not tested after', (a) => ({ text: String(a.untested), warn: a.untested > 0 })),
    row('fixTries', 'Tries to fix a failure', (a) => ({ text: a.fixTries == null ? '—' : a.fixTries.toFixed(1) })),
    row('faked', 'Tests changed to pass', (a) => ({ text: String(a.faked), warn: a.faked > 0 })),
    row('claims', 'Claims that didn’t happen', (a) => ({ text: String(a.claims), warn: a.claims > 0 })),
    row('stuck', 'Went in circles', (a) => ({ text: String(a.stuck), warn: a.stuck > 0 })),
    row('tokens', 'Tokens per request', (a) => ({ text: a.tokens ? tokenLine(a.tokens) : '—' })),
    // What the tokens bought: new tokens only (cache reads cost a fraction), so agents compare.
    row('perPass', 'New tokens per change that held up', (a) => ({ text: a.cost?.perPass != null ? short(a.cost.perPass) : '—' })),
    row('wasted', 'New tokens on changes that didn’t', (a) => ({ text: a.cost ? `${short(a.cost.wasted)}${a.cost.total ? ` (${pct(a.cost.wasted, a.cost.total)})` : ''}` : '—', warn: !!a.cost && a.cost.total > 0 && a.cost.wasted / a.cost.total >= 0.25 })),
    row('retries', 'New tokens on retries', (a) => ({ text: a.cost ? `${short(a.cost.retries)}${a.cost.total ? ` (${pct(a.cost.retries, a.cost.total)})` : ''}` : '—' })),
    row('time', 'Time on requests', (a) => ({ text: a.time ? hours(a.time) : '—' })),
  ];
}

/** The card as Markdown: a table, one column per agent, for a PR, a standup or a post. */
export function reportMarkdown(title, card) {
  if (!card.length) return `## ${title}\n\nNo agent work in this period.`;
  const rows = reportRows(card);
  const cell = (c) => `${c.warn ? '⚠ ' : ''}${c.text}`.replace(/\|/g, '\\|');
  return [
    `## ${title}`,
    '',
    `| | ${card.map((a) => a.name).join(' | ')} |`,
    `|---|${card.map(() => '---:').join('|')}|`,
    ...rows.map((r) => `| ${r.label} | ${r.cells.map(cell).join(' | ')} |`),
    '',
    `_${plural(card.reduce((n, a) => n + a.requests, 0), 'request')} · read from what the agents did (their steps and test output), not what they said. Only tests an agent ran count._`,
  ].join('\n');
}
