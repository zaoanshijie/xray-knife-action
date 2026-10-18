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

// Put git's proxy settings back the way they were. A self-hosted runner keeps
// its ~/.gitconfig between jobs, so leaving http.proxy behind would silently
// route unrelated clones through a proxy that no longer exists.
if (process.env.STATE_git_proxy_set === '1') {
  const keys = [
    ['http.proxy', process.env.STATE_git_proxy_prev_http || ''],
    ['https.proxy', process.env.STATE_git_proxy_prev_https || ''],
  ];
  let hadPrevious = false;
  for (const [key, previous] of keys) {
    if (previous) hadPrevious = true;
    const args = previous
      ? ['config', '--global', key, previous]
      : ['config', '--global', '--unset-all', key];
    const result = spawnSync('git', args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    // `--unset-all` exits with 5 when the key was not set; that is fine.
    if (result.status !== 0 && result.status !== 5) {
      process.stdout.write(`::warning::could not restore git ${key}: ${(result.stderr || '').trim() || `exit ${result.status}`}\n`);
    }
  }
  process.stdout.write(
    hadPrevious ? 'Restored git proxy settings (previous values put back).\n' : 'Removed the git proxy settings.\n'
  );
}

