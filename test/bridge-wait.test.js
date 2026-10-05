// desktop/main.js never runs a bridge in its own process while the one it started is alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayStartHere } from '../desktop/bridge-wait.js';

const sleep = async () => {};

test('a bridge process that answers in time: nothing starts here', async () => {
  let polls = 0;
  const ok = await mayStartHere({ up: async () => ++polls > 3, running: () => true, stop: async () => assert.fail('not stopped'), sleep });
  assert.equal(ok, false);
});

test('a bridge process that is alive but never answers is stopped before one starts here', async () => {
  let alive = true;
  let stopped = 0;
  const ok = await mayStartHere({ up: async () => false, running: () => alive, stop: async () => { stopped++; alive = false; return true; }, polls: 5, sleep });
  assert.equal(stopped, 1);
  assert.equal(ok, true);
});

test('a bridge process that will not exit: nothing starts here, so two never share the port', async () => {
  const ok = await mayStartHere({ up: async () => false, running: () => true, stop: async () => false, polls: 5, sleep });
  assert.equal(ok, false);
});

test('a bridge process that already died: one starts here right away', async () => {
  let polls = 0;
  const ok = await mayStartHere({ up: async () => { polls++; return false; }, running: () => false, stop: async () => assert.fail('nothing to stop'), sleep });
  assert.equal(ok, true);
  assert.equal(polls, 2);
});
