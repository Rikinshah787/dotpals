// Where something said to Talk goes (the notch, bridge/notch.html): to Blu the screen buddy
// (bridge/buddy.js: answer, look, explain, draw, do things on your computer) or to Talk's plan
// for a coding agent (bridge/tasks.js). Blu answers itself unless you ask for an agent: you name
// one ("have Claude…", "what are my agents doing?") or ask for coding work. Word lists, so the
// choice costs nothing; the plan still asks before anything is sent.

// About the computer itself: music, volume, windows, apps.
const COMPUTER = /\b(play|pause|resume|skip|next (song|track|video)|previous (song|track)|go back a song|volume|louder|quieter|softer|mute|unmute|turn (it |the music |the sound |the volume |this )?(up|down)|open|launch|close the|window|smaller|bigger|maximi[sz]e|minimi[sz]e|snap|move (it|this|that|the)|nudge|full ?screen|click|press|type|scroll|youtube|spotify|apple music|song|music|playlist|chrome|brave|edge|firefox|safari)\b/i;
// About what's on the screen.
const SCREEN = /\b(this|that|these|those|here|there|screen|see|look|show|draw|circle|highlight|point|underline|arrow|explain|what'?s|what is|what are|which|where|read|error|video|page|picture|image|photo|chart|graph|diagram|tab|button)\b/i;
// An agent, by name.
const AGENT = /\b(claude|codex|cursor (agent|ai)|in cursor|gemini|copilot|open ?code|agents?)\b/i;
// Work for a coding agent.
const CODING = /\b(fix|refactor|implement|commit|push|pull request|open a PR|merge|deploy|rebase|write (a |the |some )?tests?|add (a |an |the )?(test|feature|endpoint|function|page|component)|run the tests)\b/i;

/**
 * 'buddy' or 'plan'. `mode`: Settings → What Blu is for ('developer', 'everyday' or 'both').
 * Coding work goes to the plan unless Blu is for everyday things (then Blu says what it can do).
 */
export function route(text, { mode = 'both' } = {}) {
  const t = String(text ?? '');
  if (AGENT.test(t)) return 'plan';
  if (mode !== 'everyday' && CODING.test(t) && (!COMPUTER.test(t) || /\b(PR|pull request)\b/i.test(t))) return 'plan';
  return 'buddy';
}

/** Does it need a look at the screen? (Only then is the screenshot sent.) */
export const aboutScreen = (text) => SCREEN.test(String(text ?? ''));

/** What Blu drew, in a few words, for the next request's memory: 'circle "total", arrow'. */
export const drewWords = (marks) => (marks ?? []).map((m) => `${m.shape}${m.label ? ` “${m.label}”` : ''}`).join(', ');
