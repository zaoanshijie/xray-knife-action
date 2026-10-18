'use strict';

/*
 * Xray Knife Subscription Proxy — main entry point.
 *
 * Downloads the official xray-knife release for the current runner, imports a
 * subscription link, tests its nodes and starts a local proxy backed by a
 * working node. Written with zero runtime dependencies on purpose: the action
 * runs straight from the repository without a build step.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { resolveAsset } = require('./platform');

const UPSTREAM = 'lilendian0x00/xray-knife';
const BIN_NAME = process.platform === 'win32' ? 'xray-knife.exe' : 'xray-knife';

// ---------------------------------------------------------------------------
// GitHub Actions plumbing (no @actions/core)
// ---------------------------------------------------------------------------

function getInput(name) {
  // GitHub exposes inputs as INPUT_<UPPERCASED NAME>. Spaces become
  // underscores, but hyphens are kept, so "test-url" arrives as
  // INPUT_TEST-URL. Accept both spellings so local runs (where a hyphen in an
  // env var name is impractical) behave identically.
  const upper = name.toUpperCase();
  for (const key of [`INPUT_${upper}`, `INPUT_${upper.replace(/[ -]/g, '_')}`]) {
    if (process.env[key] !== undefined) return String(process.env[key]).trim();
  }
  return '';
}

function getBoolInput(name, fallback) {
  const raw = getInput(name).toLowerCase();
  if (raw === '') return fallback;
  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;
  throw new Error(`input "${name}" must be a boolean, got "${raw}"`);
}

function intInput(name, fallback) {
  const raw = getInput(name);
  if (raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`input "${name}" must be a number, got "${raw}"`);
  return value;
}

function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

function describe(message) {
  process.stdout.write(`::group::${escapeData(message)}\n`);
}

function endDescribe() {
  process.stdout.write('::endgroup::\n');
}

function warn(message) {
  process.stdout.write(`::warning::${escapeData(message)}\n`);
}

function notice(message) {
  process.stdout.write(`::notice::${escapeData(message)}\n`);
}

function mask(value) {
  if (value) process.stdout.write(`::add-mask::${escapeData(value)}\n`);
}

function appendFile(file, content) {
  if (!file) return;
  try {
    fs.appendFileSync(file, content);
  } catch (error) {
    warn(`could not write to ${file}: ${error.message}`);
  }
}

function setOutput(name, value) {
  appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function setEnv(name, value) {
  appendFile(process.env.GITHUB_ENV, `${name}=${value}\n`);
}

function saveState(name, value) {
  appendFile(process.env.GITHUB_STATE, `${name}=${value}\n`);
}

function summary(markdown) {
  appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function shell(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'inherit', ...options });
}

function redact(args, secret) {
  return args.map((arg) => (secret && arg === secret ? '***' : arg));
}

function runXf(bin, args, secret) {
  log(`$ xray-knife ${redact(args, secret).join(' ')}`);
  return shell(bin, args, { stdio: ['ignore', 'inherit', 'inherit'] });
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function countLinks(file) {
  if (!file || !fs.existsSync(file)) return 0;
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')).length;
}

function readTail(file, lines = 20) {
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  return content.slice(-lines).filter(Boolean).join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  // Atomics.wait is the only synchronous sleep available in plain Node.
  const deadline = Date.now() + ms;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    Atomics.wait(buffer, 0, 0, Math.min(100, deadline - Date.now()));
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function assetName() {
  return resolveAsset(process.platform, process.arch);
}

function releaseUrl(version, asset) {
  const base = `https://github.com/${UPSTREAM}/releases`;
  if (!version || version === 'latest') return `${base}/latest/download/${asset}`;
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `${base}/download/${tag}/${asset}`;
}

function download(url, destination) {
  const args = [
    '-fsSL',
    '--retry', '2',
    '--retry-delay', '3',
    '--connect-timeout', '30',
    '--max-time', '900',
    '-o', destination,
    url,
  ];
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync('curl', args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (result.status === 0 && fs.existsSync(destination) && fs.statSync(destination).size > 1024) {
      return;
    }
    lastError = firstLine(result.stderr) || `curl exited with ${result.status}`;
    warn(`download attempt ${attempt}/3 failed: ${lastError}`);
    if (attempt < 3) sleepSync(2000);
  }
  throw new Error(`failed to download ${url} (${lastError})`);
}

function extract(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });

  if (process.platform === 'win32') {
    // bsdtar (shipped with Windows) reads zip files; Git-Bash's GNU tar does
    // not, so target the system binary explicitly and fall back to PowerShell.
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(systemTar) && shell(systemTar, ['-xf', archive, '-C', destination]).status === 0) return;
    const expand = `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`;
    if (shell('powershell', ['-NoProfile', '-NonInteractive', '-Command', expand]).status === 0) return;
    throw new Error(`failed to extract ${path.basename(archive)}`);
  }

  if (shell('unzip', ['-o', '-q', archive, '-d', destination]).status !== 0) {
    throw new Error(`failed to extract ${path.basename(archive)}`);
  }
}

function findBinary(directory) {
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name === BIN_NAME) return full;
    }
  }
  throw new Error(`${BIN_NAME} was not found inside the release archive`);
}

function install() {
  const requested = getInput('version') || 'bundled';
  const useBundled = requested.toLowerCase() === 'bundled';
  const asset = assetName();
  const root = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'xray-knife-action');
  const destination = path.join(root, useBundled ? 'bundled' : requested.replace(/[^\w.-]/g, '_') || 'latest');

  fs.mkdirSync(root, { recursive: true });

  describe(`Install xray-knife ${useBundled ? '(bundled)' : requested} (${asset})`);
  log(`Runner: ${process.platform}/${process.arch} -> ${asset}`);

  // Reuse an earlier extraction in the same job: no need to unpack 24 MB again.
  let binary = fs.existsSync(path.join(destination, BIN_NAME)) ? path.join(destination, BIN_NAME) : null;

  if (!binary) {
    let archive;
    if (useBundled) {
      const bundled = path.join(__dirname, '..', 'vendor', asset);
      if (fs.existsSync(bundled)) {
        archive = bundled;
        log(`Using the archive shipped with this action: vendor/${asset}`);
      } else {
        warn(`this action ships no archive for ${asset}; downloading from GitHub instead`);
      }
    }

    if (!archive) {
      const release = useBundled ? 'latest' : requested;
      const url = releaseUrl(release, asset);
      archive = path.join(root, asset);
      log(`Downloading ${url}`);
      download(url, archive);
    }

    extract(archive, destination);
    binary = findBinary(destination);
  }

  try {
    fs.chmodSync(binary, 0o755);
  } catch (error) {
    log(`chmod skipped: ${error.message}`);
  }

  const versionResult = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  const banner = firstLine(versionResult.stdout || versionResult.stderr);
  const match = banner.match(/(\d+\.\d+(?:\.\d+)?)/);
  const version = match ? match[1] : requested;

  appendFile(process.env.GITHUB_PATH, `${path.dirname(binary)}\n`);
  setOutput('version', version);
  setOutput('xray-knife-path', binary);
  saveState('binary', binary);
  log(`Installed xray-knife ${version} at ${binary}`);
  endDescribe();

  return { binary, version };
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

function fetchSubscription(binary, subscription, configsFile) {
  describe('Fetch subscription');
  const args = ['subs', 'fetch', '--url', subscription, '-o', configsFile];
  const userAgent = getInput('user-agent');
  const fetchProxy = getInput('fetch-proxy');
  if (userAgent) args.push('--user-agent', userAgent);
  if (fetchProxy) args.push('--proxy', fetchProxy);

  const result = runXf(binary, args, subscription);
  if (result.status !== 0) {
    endDescribe();
    throw new Error(
      `could not import the subscription (exit code ${result.status}). ` +
        'Check that the URL is reachable from the runner and that it returns a valid subscription.'
    );
  }

  const total = countLinks(configsFile);
  log(`Imported ${total} config link(s) to ${configsFile}`);
  endDescribe();
  return total;
}

// ---------------------------------------------------------------------------
// Testing
// ---------------------------------------------------------------------------

function testNodes(binary, configsFile, validFile) {
  describe('Test nodes');
  const args = [
    'http',
    '-f', configsFile,
    '-o', validFile,
    '--mdelay', String(intInput('max-delay', 3000)),
    '--threads', String(intInput('threads', 50)),
  ];
  const maxPassed = intInput('max-passed', 0);
  const retries = intInput('retries', 0);
  const testUrl = getInput('test-url');
  if (maxPassed > 0) args.push('--max-passed', String(maxPassed));
  if (retries > 0) args.push('--retries', String(retries));
  if (testUrl) args.push('--url', testUrl);

  const result = runXf(binary, args);
  const valid = countLinks(validFile);

  if (result.status === 3) {
    warn(`xray-knife reported that no node passed the test (${testUrl || 'default url'}).`);
  } else if (result.status !== 0) {
    endDescribe();
    throw new Error(`node testing failed with exit code ${result.status}`);
  }

  log(`Working nodes: ${valid}`);
  endDescribe();
  return valid;
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let finished = false;
    const retry = (error) => {
      if (finished) return;
      if (Date.now() > deadline) {
        finished = true;
        reject(error);
      } else {
        setTimeout(attempt, 500);
      }
    };
    const attempt = () => {
      if (finished) return;
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(2000);
      socket.once('connect', () => {
        finished = true;
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        retry(new Error(`nothing is listening on 127.0.0.1:${port} after ${timeoutMs / 1000}s`));
      });
      socket.once('timeout', () => {
        socket.destroy();
        retry(new Error(`timed out connecting to 127.0.0.1:${port}`));
      });
    };
    attempt();
  });
}

function curlThroughProxy(proxyUrl, targetUrl) {
  const result = spawnSync(
    'curl',
    ['-fsS', '-m', '20', '--proxy', proxyUrl, '-o', os.devNull, '-w', '%{http_code}', targetUrl],
    { encoding: 'utf8' }
  );
  const code = (result.stdout || '').trim();
  return {
    ok: result.status === 0,
    detail: result.status === 0 ? `HTTP ${code || 'ok'}` : firstLine(result.stderr) || `curl exited with ${result.status}`,
  };
}

async function verifyProxy(proxyUrl, targetUrl, label, attempts = 3) {
  let check = { ok: false, detail: 'not attempted' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    check = curlThroughProxy(proxyUrl, targetUrl);
    if (check.ok) return check;
    log(`${label} verification attempt ${attempt}/${attempts} failed: ${check.detail}`);
    await sleep(2000);
  }
  return check;
}

async function assertPortFree(port, label) {
  const inUse = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (inUse) {
    throw new Error(
      `127.0.0.1:${port} is already in use, so the ${label} could not start. ` +
        'Another proxy (for example a local xray-knife/clash) may own that port; ' +
        'pass a different "port" (and optionally "socks-port") input.'
    );
  }
}

async function startProxy(binary, poolFile, httpPort, socksPort, workdir) {
  const xrayLog = path.join(workdir, 'xray-knife-proxy.log');
  const relayLog = path.join(workdir, 'http-proxy.log');
  const startTimeout = intInput('start-timeout', 60) * 1000;

  describe('Start local proxy');
  await assertPortFree(httpPort, 'HTTP proxy');
  if (socksPort !== httpPort) await assertPortFree(socksPort, 'SOCKS5 listener');

  // 1. xray-knife's own listener: SOCKS5, no credentials.
  const core = (getInput('core') || 'xray').toLowerCase();
  if (!['xray', 'sing-box'].includes(core)) {
    throw new Error(`input "core" must be "xray" or "sing-box", got "${core}"`);
  }
  const xrayArgs = [
    'proxy', 'inbound',
    '-f', poolFile,
    '--core', core,
    '--inbound-config', `socks://127.0.0.1:${socksPort}#listener`,
    '--rotate', String(intInput('rotate', 0)),
  ];
  log(`$ xray-knife ${xrayArgs.join(' ')}`);
  const xrayFd = fs.openSync(xrayLog, 'a');
  const child = spawn(binary, xrayArgs, { detached: true, stdio: ['ignore', xrayFd, xrayFd], windowsHide: true });
  child.unref();
  saveState('pid', child.pid);

  try {
    await waitForPort(socksPort, startTimeout);
  } catch (error) {
    log(filteredLog(xrayLog));
    endDescribe();
    throw error;
  }
  log(`SOCKS5 listener ready on 127.0.0.1:${socksPort} (pid ${child.pid})`);

  // 2. HTTP front-end. xray-knife only guarantees SOCKS5: xray-core happens to
  // sniff HTTP on that port, but sing-box does not and the authenticated
  // default inbound speaks SOCKS only. The relay makes HTTP work for certain.
  const relayPath = path.join(__dirname, 'http-proxy.js');
  const relayArgs = [relayPath, '--listen-port', String(httpPort), '--socks-port', String(socksPort)];
  log(`$ node ${relayArgs.join(' ')}`);
  const relayFd = fs.openSync(relayLog, 'a');
  const relay = spawn(process.execPath, relayArgs, {
    detached: true,
    stdio: ['ignore', relayFd, relayFd],
    windowsHide: true,
  });
  relay.unref();
  saveState('relay_pid', relay.pid);

  try {
    await waitForPort(httpPort, startTimeout);
  } catch (error) {
    log(readTail(relayLog, 10));
    endDescribe();
    throw error;
  }
  log(`HTTP proxy ready on 127.0.0.1:${httpPort} (pid ${relay.pid})`);

  // 3. Prove both front doors actually reach the internet.
  const httpUrl = `http://127.0.0.1:${httpPort}`;
  const socksUrl = `socks5://127.0.0.1:${socksPort}`;
  const targetUrl = getInput('test-url') || 'https://cloudflare.com/cdn-cgi/trace';

  const httpCheck = await verifyProxy(httpUrl, targetUrl, 'HTTP');
  if (!httpCheck.ok) {
    log(filteredLog(xrayLog));
    log(readTail(relayLog, 10));
    endDescribe();
    throw new Error(`the HTTP proxy started but cannot reach ${targetUrl}: ${httpCheck.detail}`);
  }
  log(`HTTP proxy verified through ${targetUrl} (${httpCheck.detail})`);

  const socksCheck = await verifyProxy(`socks5h://127.0.0.1:${socksPort}`, targetUrl, 'SOCKS5');
  if (!socksCheck.ok) {
    warn(`the SOCKS5 listener did not answer a curl check (${socksCheck.detail}); the HTTP proxy is verified and working.`);
  } else {
    log(`SOCKS5 listener verified through ${targetUrl} (${socksCheck.detail})`);
  }

  endDescribe();
  return { httpUrl, socksUrl, pid: child.pid, relayPid: relay.pid, xrayLog, relayLog };
}

// The proxy log contains the node links (credentials), so only show the lines
// that describe the listener when reporting a failure.
function filteredLog(file, lines = 30) {
  const raw = readTail(file, lines * 3);
  const safe = raw
    .split(/\r?\n/)
    .filter((line) => line && !/:\/\//.test(line))
    .slice(-lines)
    .join('\n');
  return safe ? `--- proxy log (${file}) ---\n${safe}` : '';
}

// ---------------------------------------------------------------------------
// Git proxy
// ---------------------------------------------------------------------------

function gitConfigGet(key) {
  const result = spawnSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout || '').trim() : '';
}

/**
 * "git-proxy" accepts a boolean or an explicit proxy URL. A boolean true means
 * "use the proxy this action just started".
 */
function gitProxySetting(fallbackUrl) {
  const raw = getInput('git-proxy');
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(lower)) return fallbackUrl;
  if (['false', '0', 'no', 'n', 'off'].includes(lower)) return null;
  return raw;
}

function configureGitProxy(url) {
  const previous = { http: gitConfigGet('http.proxy'), https: gitConfigGet('https.proxy') };

  for (const key of ['http.proxy', 'https.proxy']) {
    const result = spawnSync('git', ['config', '--global', key, url], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      warn(`could not point git at the proxy (${key}): ${firstLine(result.stderr) || `git exited with ${result.status}`}`);
      return null;
    }
  }

  saveState('git_proxy_set', '1');
  saveState('git_proxy_prev_http', previous.http);
  saveState('git_proxy_prev_https', previous.https);
  setOutput('git-proxy', url);
  log(`git now uses ${url} (http.proxy + https.proxy); the previous values are restored after the job`);
  return url;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const subscription = getInput('subscription');
  mask(subscription);

  const workdir = path.resolve(getInput('workdir') || process.env.GITHUB_WORKSPACE || process.cwd());
  fs.mkdirSync(workdir, { recursive: true });

  const configsFile = path.join(workdir, 'configs.txt');
  const validFile = path.join(workdir, 'valid.txt');
  setOutput('proxy-available', 'false');

  const { binary, version } = install();

  if (!subscription) {
    notice('No subscription provided: xray-knife was installed and added to PATH, nothing else was done.');
    summary(
      [
        '### Xray Knife Subscription Proxy',
        '',
        '| item | value |',
        '| --- | --- |',
        `| version | \`${version}\` |`,
        `| binary | \`${binary}\` |`,
        '| subscription | _not provided (install only)_ |',
      ].join('\n')
    );
    return;
  }

  if (!/^https?:\/\//i.test(subscription)) {
    throw new Error('input "subscription" must be an http:// or https:// URL');
  }

  const total = fetchSubscription(binary, subscription, configsFile);
  setOutput('total-nodes', total);
  setOutput('configs-file', configsFile);
  if (total === 0) {
    endSummary(version, total, 0, '');
    throw new Error('the subscription did not contain any config link');
  }

  const runTests = getBoolInput('test', true);
  let valid = total;

  if (runTests) {
    valid = testNodes(binary, configsFile, validFile);
    setOutput('valid-nodes', valid);
    setOutput('valid-file', validFile);
  } else {
    fs.copyFileSync(configsFile, validFile);
    setOutput('valid-nodes', total);
    setOutput('valid-file', validFile);
    log('Node testing is disabled (test: false); every imported node is used as a candidate.');
  }

  const shouldStartProxy = getBoolInput('start-proxy', true);
  const allowEmpty = getBoolInput('allow-empty', false);
  const proxy = { httpUrl: '', socksUrl: '', pid: '', relayPid: '', gitUrl: '' };

  const httpPort = intInput('port', 10809);
  const socksPortInput = intInput('socks-port', 0);
  const socksPort = socksPortInput > 0 ? socksPortInput : httpPort + 1;
  if (socksPort === httpPort) {
    throw new Error('"port" and "socks-port" must differ: the HTTP relay and the SOCKS5 listener are separate processes');
  }
  if (socksPort > 65535) {
    throw new Error(`"socks-port" resolved to ${socksPort}, which is out of range; set it explicitly`);
  }

  if (valid > 0 && shouldStartProxy) {
    try {
      const started = await startProxy(binary, validFile, httpPort, socksPort, workdir);
      proxy.httpUrl = started.httpUrl;
      proxy.socksUrl = started.socksUrl;
      proxy.pid = String(started.pid);
      proxy.relayPid = String(started.relayPid);

      setOutput('proxy', started.httpUrl);
      setOutput('socks-proxy', started.socksUrl);
      setOutput('pid', String(started.pid));
      setOutput('relay-pid', String(started.relayPid));
      setOutput('log-file', started.xrayLog);
      setOutput('relay-log', started.relayLog);
      setOutput('proxy-available', 'true');

      if (getBoolInput('export-env', false)) {
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) setEnv(key, started.httpUrl);
        for (const key of ['ALL_PROXY', 'all_proxy']) setEnv(key, started.socksUrl);
        setEnv('NO_PROXY', 'localhost,127.0.0.1,::1');
        setEnv('no_proxy', 'localhost,127.0.0.1,::1');
        log('Exported proxy environment variables for the following steps.');
      }

      const gitUrl = gitProxySetting(started.httpUrl);
      if (gitUrl) proxy.gitUrl = configureGitProxy(gitUrl) || '';

      notice(`Proxy ready: ${started.httpUrl} (HTTP) / ${started.socksUrl} (SOCKS5), ${valid} working node(s)`);
    } catch (error) {
      setOutput('proxy-available', 'false');
      endSummary(version, total, valid, '', '', '');
      if (!allowEmpty) throw error;
      warn(`continuing without a proxy: ${error.message}`);
    }
  } else if (valid === 0) {
    warn('No working node was found, so no proxy was started.');
    if (!allowEmpty) {
      endSummary(version, total, 0, '', '', '');
      throw new Error(
        'none of the subscription nodes passed the test. ' +
          'Set "allow-empty: true" to continue anyway, raise "max-delay", or check the subscription.'
      );
    }
  }

  endSummary(version, total, valid, proxy.httpUrl, proxy.socksUrl, proxy.gitUrl);
}

function endSummary(version, total, valid, httpUrl, socksUrl, gitUrl) {
  const rows = [
    ['xray-knife', `\`${version}\``],
    ['imported nodes', String(total)],
    ['working nodes', String(valid)],
    ['http proxy', httpUrl ? `\`${httpUrl}\`` : '_not started_'],
    ['socks5 proxy', socksUrl ? `\`${socksUrl}\`` : '_not started_'],
    ['git proxy', gitUrl ? `\`${gitUrl}\`` : '_not configured_'],
  ];
  summary(
    ['### Xray Knife Subscription Proxy', '', '| item | value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n')
  );
}

main().catch((error) => {
  process.stdout.write(`::error::${escapeData(error.message)}\n`);
  process.exitCode = 1;
});
