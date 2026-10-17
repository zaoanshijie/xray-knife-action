'use strict';

/*
 * Post step: stop the proxy that src/index.js started in the background.
 * The process is killed when the job ends so a self-hosted runner never keeps
 * a proxy (and its subscription credentials) alive between jobs.
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

const pid = Number.parseInt(process.env.STATE_pid || '', 10);
if (!Number.isFinite(pid)) {
  process.stdout.write('No xray-knife proxy to stop.\n');
} else {
  try {
    const stopped = stop(pid);
    process.stdout.write(stopped ? `Stopped xray-knife proxy (pid ${pid}).\n` : `xray-knife proxy (pid ${pid}) already exited.\n`);
  } catch (error) {
    process.stdout.write(`::warning::could not stop xray-knife proxy (pid ${pid}): ${error.message}\n`);
  }
}
