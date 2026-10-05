// desktop/main.js: wait for the bridge process it started, and say whether the app may run
// a bridge of its own. Never while that process is still alive: both would fight for the port.

/**
 * `up()`: the bridge answers. `running()`: the process we started is still alive.
 * `stop()`: kill it; resolves true once it has exited (false if it didn't in time).
 * Resolves true when it's safe to start a bridge in this process (nothing answers, nothing runs).
 */
export async function mayStartHere({ up, running, stop, polls = 60, every = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let i = 0; i < polls && running(); i++) {
    if (await up()) return false;
    await sleep(every);
  }
  if (await up()) return false;
  // Alive but never answered: stop it first, so only one bridge ever has the port.
  if (running() && !(await stop())) return false;
  return !(await up());
}
