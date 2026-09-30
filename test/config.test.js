import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dotpals-config-'));
process.env.DOTPALS_HOME = home;
delete process.env.DOTPALS_CODEX;
after(() => rm(home, { recursive: true, force: true }));

const { AGENT_IDS, loadConfig, saveConfig } = await import('../bridge/config.js');
const { ADAPTERS } = await import('../bridge/adapters/index.js');

test('every integration can be switched off in the config', () => {
  assert.deepEqual(ADAPTERS.map((a) => a.id).filter((id) => !AGENT_IDS.includes(id)), []);
});

test('agents: only known ids with true/false are kept; everything else is on', async () => {
  const config = saveConfig({ agents: { cursor: false, gemini: 'no', evil: false, __proto__: { x: 1 } } });
  assert.equal(config.agents.cursor, false);
  assert.equal(config.agents.gemini, true);
  assert.equal(config.agents.opencode, true);
  assert.equal('evil' in config.agents, false);
  const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(saved.agents, { cursor: false });

  // Patches merge, rather than replacing the whole map.
  saveConfig({ agents: { opencode: false } });
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).agents, { cursor: false, opencode: false });
  saveConfig({ agents: { cursor: true } });
  assert.equal(loadConfig().agents.cursor, true);

  // Junk is ignored.
  for (const agents of [null, 'x', ['cursor'], 3]) assert.doesNotThrow(() => saveConfig({ agents }));
  assert.equal(loadConfig().agents.opencode, false);
});

test('agents.codex is the same switch as codex', () => {
  assert.equal(saveConfig({ agents: { codex: false } }).codex, false);
  assert.equal(loadConfig().agents.codex, false);
  assert.equal(saveConfig({ codex: true }).agents.codex, true);
});
