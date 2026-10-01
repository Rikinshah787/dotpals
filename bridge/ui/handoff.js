// The hand-off note: what one agent session asked for and did, written for another
// agent to pick up ("Continue in Codex / Claude / Gemini", or Copy). Markdown, from the
// session's own record: the ask, the latest request's recap, the files it changed, how
// the tests stand (with the failure, if any), what's left on its plan, what's risky and
// its last message. Plain rules, like the rest of the story; runs in Node and the pages.
import { relative } from '../activity.js';
import { buildTurns, facts, harnessName } from './recap.js';
import { planOf, simple, stepType, story, testLine, testState, turnMarkdown } from './story.js';

const firstLine = (s) => String(s ?? '').split('\n')[0].trim();
const clipTo = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
/** Quote text as a Markdown block quote (an agent's words, or yours). */
const quoted = (s) => String(s).replace(/\r\n/g, '\n').split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
/** Text for inside a ``` block: no fence of its own. */
const fenced = (s) => String(s ?? '').replace(/```/g, "'''");

/**
 * The note for `session`, or null when there's nothing recorded for it.
 *   entries  every activity entry (any order)
 *   cwd      the session's project folder, if known (paths are shown from it)
 *   file     where the note is saved, if it is (mentioned at the end)
 */
export function handoffNote(entries, { session, cwd, now = Date.now(), time = (at) => new Date(at).toLocaleString() } = {}) {
  const list = entries.filter((e) => e.session === session).sort((a, b) => a.at - b.at);
  if (!list.length) return null;
  const who = harnessName(list.find((e) => e.harness)?.harness);
  const label = list.findLast((e) => e.label)?.label;
  const turns = buildTurns(list).filter((t) => t.prompt || t.steps.length);
  const asks = turns.filter((t) => t.prompt);
  const first = asks[0]?.prompt.title;
  const last = asks.at(-1)?.prompt.title;
  const rel = (p) => relative(p, cwd);
  const out = [];

  out.push(`# Hand-off from ${who}${label ? ` · ${label}` : ''}`, '');
  out.push(`You're continuing work another agent started. Read this, check the current state (the files below, \`git status\`, the tests), then continue: ${last ? `“${clipTo(firstLine(last), 200)}”` : 'the work described below'}.`, '');

  if (first) out.push('## The original ask', '', quoted(clipTo(first, 2000)), '');
  if (last && last !== first) out.push('## The last request', '', quoted(clipTo(last, 2000)), '');

  // What was done: the newest request in full (its recap, with the evidence), the ones
  // before it in a sentence each.
  const latest = turns.at(-1);
  if (latest) {
    out.push('## What was done', '', turnMarkdown(latest), '');
    const earlier = turns.slice(0, -1).slice(-4);
    if (earlier.length) {
      out.push('Before that:');
      for (const t of earlier) out.push(`- ${t.prompt ? `“${clipTo(firstLine(t.prompt.title), 100)}”: ` : ''}${simple(t, { live: false }).text}`);
      out.push('');
    }
  }

  const f = facts(list);
  const changed = [...f.changed, ...f.wrote, ...f.deleted];
  if (changed.length) {
    out.push('## Files changed in this session', '');
    const how = { edit: 'changed', write: 'written', delete: 'deleted' };
    for (const x of changed.slice(0, 30)) out.push(`- \`${rel(x.path)}\` (${how[x.change]})`);
    if (changed.length > 30) out.push(`- and ${changed.length - 30} more`);
    out.push('');
  }

  // How the tests stand, and the failure itself when they're failing.
  const tests = testLine(list, time);
  if (tests) {
    out.push('## Tests', '', `${tests.text}. (Only tests the agent ran: run them again to be sure.)`);
    const t = testState(list);
    const run = t?.last;
    if (run && (t.state === 'failing' || (t.state === 'stale' && t.verdict?.state === 'failed'))) {
      const output = `${run.body?.output ?? ''}\n${run.error ?? ''}`.trim();
      out.push('', `The last run, \`${firstLine(run.body?.command ?? run.title).slice(0, 100)}\`, failed:`);
      if (output) out.push('', '```', fenced(output.split('\n').slice(-25).join('\n')), '```');
    }
    out.push('');
  }

  const plan = planOf(list);
  const todo = plan?.items.filter((p) => p.status !== 'completed') ?? [];
  if (todo.length) {
    out.push(`## Still on its plan (${plan.done} of ${plan.total} done)`, '');
    for (const p of todo.slice(0, 12)) out.push(`- [ ] ${clipTo(p.text, 160)}${p.status === 'in_progress' ? ' (it was on this one)' : ''}`);
    out.push('');
  }

  // Risky steps from any request; whether the code was tested only from the latest (the
  // earlier requests' word on it is out of date).
  const warnings = [];
  const TESTS = /^(Not tested|Tests unclear|Committed without)|after the tests/;
  for (const t of turns) {
    for (const fl of story(t).flags) if (fl.level === 'warn' && (t === latest || !TESTS.test(fl.text)) && !warnings.includes(fl.text)) warnings.push(fl.text);
  }
  if (warnings.length) {
    out.push('## Worth a second look', '');
    for (const w of warnings.slice(-6)) out.push(`- ${w}`);
    out.push('');
  }

  const said = list.findLast((e) => (e.kind === 'done' || e.kind === 'error') && e.summary)?.summary;
  if (said) out.push(`## ${who}'s last message`, '', quoted(clipTo(said, 2500)), '');
  const busy = list.findLast((e) => e.status === 'running' && stepType(e) !== 'quiet');
  if (busy && !said) out.push(`It was last working on: ${firstLine(busy.title)}.`, '');

  out.push('---', `_Written by dotpals from ${who}’s session ${String(session).slice(-8)}${cwd ? ` in ${cwd}` : ''}, ${time(now)}. dotpals only sees what the agent did through its tools: check the files for how things really stand._`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
