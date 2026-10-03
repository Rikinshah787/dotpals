import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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

test('chat is off and the pal is 100% until changed; the pal size is a whole percent from 50 to 150', () => {
  assert.equal(loadConfig().chat, false);
  assert.equal(loadConfig().palSize, 100);
  assert.equal(saveConfig({ palSize: 140 }).palSize, 140);
  for (const palSize of [300, 49, 151, 120.5, 'big', null]) assert.equal(saveConfig({ palSize }).palSize, 140, `${palSize} is ignored`);
  assert.equal(saveConfig({ chat: true }).chat, true);
  assert.equal(saveConfig({ chat: 'yes' }).chat, true, 'only true or false');
});

test('name: a trimmed string of at most 30 chars; empty means not set', () => {
  assert.equal(loadConfig().name, '', 'no name by default');
  assert.equal(saveConfig({ name: '  Ade ' }).name, 'Ade');
  const long = 'a'.repeat(40);
  assert.equal(saveConfig({ name: long }).name.length, 30, 'trimmed to 30');
  for (const name of [42, null, ['Ade'], { a: 1 }]) assert.equal(saveConfig({ name }).name, 'a'.repeat(30), `${JSON.stringify(name)} is ignored`);
  assert.equal(saveConfig({ name: '' }).name, '', 'an empty field clears the name');
  assert.equal(saveConfig({ name: '   ' }).name, '', 'whitespace only is not a name');
});

test('agents.codex is the same switch as codex', () => {
  assert.equal(saveConfig({ agents: { codex: false } }).codex, false);
  assert.equal(loadConfig().agents.codex, false);
  assert.equal(saveConfig({ codex: true }).agents.codex, true);
});

test('checker: the key is write-only, an empty key keeps it, removeKey clears it', async () => {
  const { checkerKey } = await import('../bridge/config.js');
  const key = ['apikey', '0'.repeat(16), 'f'.repeat(16)].join('_'); // fake, built at run time so secret scanners don't flag it
  delete process.env.TYPESAFE_API_KEY;
  assert.deepEqual(loadConfig().checker, { mode: 'off', localUrl: 'http://127.0.0.1:8000', layaManaged: false, keySet: false, keyLast4: null, keyFrom: null });
  const config = saveConfig({ checker: { mode: 'cloud', jevKey: `  ${key}\n` } });
  assert.deepEqual(config.checker, { mode: 'cloud', localUrl: 'http://127.0.0.1:8000', layaManaged: false, keySet: true, keyLast4: 'ffff', keyFrom: 'settings' });
  assert.ok(!JSON.stringify(config).includes(key));
  assert.ok(!JSON.stringify(loadConfig()).includes(key));
  assert.equal(checkerKey(), key);
  assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).checker.jevKey, key);
  if (process.platform !== 'win32') assert.equal((await stat(join(home, 'config.json'))).mode & 0o777, 0o600);

  saveConfig({ checker: { jevKey: '' } });           // an empty field keeps the key
  saveConfig({ checker: { jevKey: 'has spaces in it' } }); // not a key: ignored
  assert.equal(checkerKey(), key);
  saveConfig({ sounds: false });                     // other settings leave it alone
  assert.equal(checkerKey(), key);
  assert.equal(saveConfig({ checker: { removeKey: true } }).checker.keySet, false);
  assert.equal(checkerKey(), null);

  // TYPESAFE_API_KEY works too, shown as such.
  process.env.TYPESAFE_API_KEY = key;
  assert.deepEqual([loadConfig().checker.keyFrom, loadConfig().checker.keyLast4], ['env', 'ffff']);
  assert.equal(checkerKey(), key);
  delete process.env.TYPESAFE_API_KEY;

  // Laya's address must be this computer; modes are only off/local/cloud.
  assert.equal(saveConfig({ checker: { mode: 'local', localUrl: 'http://localhost:9000/' } }).checker.localUrl, 'http://localhost:9000');
  assert.equal(saveConfig({ checker: { localUrl: 'https://laya.example.com' } }).checker.localUrl, 'http://localhost:9000');
  assert.equal(saveConfig({ checker: { mode: 'everywhere' } }).checker.mode, 'local');
  saveConfig({ checker: { mode: 'off' } });
});
