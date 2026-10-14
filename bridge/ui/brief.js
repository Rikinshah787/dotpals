// The morning brief and the weekly recap: what your agents did, what's unfinished and what's
// failing, per project. Shared by the pal (once a day, on first open) and the MCP tool
// `brief`, so both say the same. Plain functions over sessions (recap.js summarizeSessions).
import { baseName, buildTurns, facts, harnessName, plural, tokenLine, tokens } from './recap.js';
import { changedCode, claimCheck, testState, weakenedTests, whyStopped } from './story.js';

const MIN = 60_000;
const lastAt = (t) => Math.max(t.at, t.end?.at ?? 0, ...t.steps.map((e) => e.at ?? 0));
const asked = (t) => (t.prompt ? `“${String(t.prompt.title).split('\n')[0].slice(0, 120)}”` : '(no prompt recorded)');
const agentName = (h) => (h === 'claude' ? 'Claude Code' : harnessName(h));

/**
 * What happened since `since`, per project (the folder a session works in, else its name):
 *   [{ name, cwd, last, requests, files, agents, tokens,
 *      unfinished: [{ agent, asked, why }],   a session's newest request that didn't finish
 *                                             cleanly: cut off, gave up, failing, a question
 *      failing:    [{ agent, text }],         sessions whose tests fail now, or whose code
 *                                             changed after the last test run (or never ran)
 *      warnings:   [{ agent, text }] }]       tests changed to pass, claims that didn't happen
 * newest first. A session still working (something in the last 5 minutes) isn't unfinished.
 * `sessions`: summarizeSessions(entries), each with an optional `cwd`.
 */
export function brief(sessions, { now = Date.now(), since = 0 } = {}) {
  const projects = new Map();
  // A project is its folder. A session whose folder isn't known (an agent that doesn't say)
  // joins the project of that name when there's only one; otherwise it's a project by name.
  const folder = (s) => String(s.cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const nameOf = (s) => String(s.label ?? (s.cwd ? baseName(s.cwd) : '?')).toLowerCase();
  const byName = new Map(); // name → the folders of that name
  for (const s of sessions) if (s.cwd) byName.set(nameOf(s), new Set([...(byName.get(nameOf(s)) ?? []), folder(s)]));
  const keyOf = (s) => (s.cwd ? folder(s) : byName.get(nameOf(s))?.size === 1 ? [...byName.get(nameOf(s))][0] : `name:${nameOf(s)}`);
  for (const s of sessions) {
    const turns = (s.turns ?? buildTurns(s.entries)).filter((t) => (t.prompt || t.steps.length) && lastAt(t) >= since);
    if (!turns.length) continue;
    const key = keyOf(s);
    const p = projects.get(key) ?? { name: s.label ?? (s.cwd ? baseName(s.cwd) : 'a project'), cwd: s.cwd ?? null, last: 0, requests: 0, files: new Set(), agents: new Set(), usage: [], unfinished: [], failing: [], warnings: [] };
    projects.set(key, p);
    const agent = agentName(s.harness);
    p.agents.add(agent);
    p.last = Math.max(p.last, ...turns.map(lastAt));
    p.requests += turns.filter((t) => t.prompt).length;
    for (const t of turns) {
      const f = facts(t.steps);
      for (const x of [...f.changed, ...f.wrote, ...f.deleted]) p.files.add(String(x.path).toLowerCase());
      if (t.usage) p.usage.push(t.usage);
      if (t.end?.kind !== 'done') continue;
      const tested = testState(t.steps);
      const weak = tested?.state === 'passing' && weakenedTests(t.steps);
      if (weak) p.warnings.push({ agent, text: `Tests passed only after they were changed (${asked(t)}): ${weak.text}` });
      for (const c of claimCheck(t)) p.warnings.push({ agent, text: `Said it ${c.claim}, but ${c.found} (${asked(t)})` });
    }
    // How the session stands now: its newest request, and its tests over the whole session.
    const newest = turns.at(-1);
    const live = !newest.end && now - lastAt(newest) < 5 * MIN;
    if (!live) {
      const why = whyStopped(newest, { live: false });
      if (why && ['cut', 'gave-up', 'failing', 'question', 'error'].includes(why.kind)) p.unfinished.push({ agent, asked: asked(newest), why: why.text });
    }
    const all = (s.turns ?? turns).flatMap((t) => t.steps);
    const t = testState(all);
    if (t?.state === 'failing') p.failing.push({ agent, text: `${agent}: tests failing${t.verdict?.summary ? ` (${t.verdict.summary})` : ''}` });
    else if (changedCode(newest.steps) && (t?.state === 'stale' || t?.state === 'untested')) p.failing.push({ agent, text: `${agent}: code changed ${t.state === 'stale' ? 'after the last test run' : 'and no tests ran'}` });
  }
  return [...projects.values()].map(({ files, agents, usage, ...p }) => ({ ...p, files: files.size, agents: [...agents].sort(), tokens: tokens(...usage) }))
    .sort((a, b) => b.last - a.last);
}

/** One line for the pal's bubble: "Since yesterday: 9 requests in 2 projects · 1 unfinished · tests failing in shop", or ''. */
export function briefLine(label, projects) {
  if (!projects.length) return '';
  const requests = projects.reduce((n, p) => n + p.requests, 0);
  const unfinished = projects.reduce((n, p) => n + p.unfinished.length, 0);
  const failing = projects.filter((p) => p.failing.length).map((p) => p.name);
  const warnings = projects.reduce((n, p) => n + p.warnings.length, 0);
  return [
    `${label}: ${plural(requests, 'request')} in ${plural(projects.length, 'project')}`,
    unfinished ? `${unfinished} unfinished` : '',
    failing.length ? `tests failing or untested in ${failing.slice(0, 3).join(', ')}${failing.length > 3 ? ` +${failing.length - 3}` : ''}` : '',
    warnings ? plural(warnings, 'thing', 'things') + ' to check' : '',
  ].filter(Boolean).join(' · ');
}

/** The brief as Markdown, per project: what was done, what's unfinished, what's failing, what to check. */
export function briefMarkdown(title, projects) {
  if (!projects.length) return `## ${title}\n\nNo agent work in this period.`;
  const out = [`## ${title}`];
  for (const p of projects) {
    out.push('', `### ${p.name}`, '', `${plural(p.requests, 'request')} · ${plural(p.files, 'file')} changed · ${p.agents.join(', ')}${p.tokens ? ` · ${tokenLine(p.tokens)}` : ''}`);
    if (p.unfinished.length) out.push('', '**Unfinished**', ...p.unfinished.map((u) => `- ${u.agent}: ${u.asked}. ${u.why}`));
    if (p.failing.length) out.push('', '**Failing**', ...p.failing.map((f) => `- ${f.text}`));
    if (p.warnings.length) out.push('', '**To check**', ...p.warnings.slice(0, 10).map((w) => `- ${w.agent}: ${w.text}`), ...(p.warnings.length > 10 ? [`- and ${p.warnings.length - 10} more`] : []));
    if (!p.unfinished.length && !p.failing.length && !p.warnings.length) out.push('', 'Nothing left open.');
  }
  out.push('', '_Read from what the agents did (their steps and test output), not what they said. Only tests an agent ran count._');
  return out.join('\n');
}
