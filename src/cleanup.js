'use strict';

/*
 * Post step: stop the two processes src/index.js leaves running in the
 * background — xray-knife's SOCKS5 listener and the HTTP relay in front of it.
 * A self-hosted runner must not keep a proxy (and its subscription
 * credentials) alive between jobs.
 */

const { spawnSync } = require('child_process');

function stop(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return result.status === 0;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') return false; // already gone
    throw error;
  }

  // Give it a moment, then make sure it is really gone.
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return true;
    }
    Atomics.wait(buffer, 0, 0, 200);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    /* already exited */
  }
  return true;
}

const targets = [
  ['http relay', process.env.STATE_relay_pid],
  ['xray-knife proxy', process.env.STATE_pid],
];

let handled = 0;
for (const [label, rawPid] of targets) {
  const pid = Number.parseInt(rawPid || '', 10);
  if (!Number.isFinite(pid)) continue;
  handled += 1;
  try {
    if (stop(pid)) {
      process.stdout.write(`Stopped ${label} (pid ${pid}).\n`);
    } else {
      process.stdout.write(`${label} (pid ${pid}) already exited.\n`);
    }
  } catch (error) {
    process.stdout.write(`::warning::could not stop ${label} (pid ${pid}): ${error.message}\n`);
  }
}

if (!handled) process.stdout.write('No proxy process was left running.\n');
