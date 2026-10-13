// The agent report card: how each agent's work held up, from what it did, not what it said.
// Shared by the dashboard's Report card page and the MCP tool `report_card`, so both give
// the same numbers. Plain functions over turns (bridge/ui/recap.js buildTurns).
import { harnessName, hours, plural, tokenLine, tokens, turnTime } from './recap.js';
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
 *   time      time spent on finished requests (ms)
 */
export function agentStats(turns) {
  const s = { requests: 0, changed: 0, passed: 0, untested: 0, faked: 0, claims: 0, stuck: 0, fixTries: null, tokens: null, time: 0 };
  const fixes = [];
  const used = [];
  for (const t of turns) {
    if (t.prompt) s.requests++;
    s.time += turnTime(t);
    if (t.usage) used.push(t.usage);
    for (const c of retries(t.steps).chains.values()) if (c.outcome === 'fixed') fixes.push(c.attempts.length);
    const last = Math.max(t.at, ...t.steps.map((e) => e.at ?? 0));
    if (stuck(t.steps, { now: t.end?.at ?? last, from: t.at })) s.stuck++;
    if (!t.end || t.end.kind !== 'done') continue;
    s.claims += claimCheck(t).length;
    const tested = testState(t.steps);
    const weak = tested?.state === 'passing' && weakenedTests(t.steps);
    if (weak) s.faked++;
    if (!changedCode(t.steps)) continue;
    s.changed++;
    if (tested?.state === 'passing' && !weak) s.passed++;
    else if (!tested || tested.state === 'untested' || tested.state === 'stale') s.untested++;
  }
  if (fixes.length) s.fixTries = fixes.reduce((a, b) => a + b, 0) / fixes.length;
  const k = tokens(...used);
  if (k) s.tokens = Object.fromEntries(Object.entries(k).map(([key, v]) => [key, key === 'replies' ? v : Math.round(v / used.length)]));
  return s;
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
