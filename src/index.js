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
  const requested = getInput('version') || 'latest';
  const asset = assetName();
  const url = releaseUrl(requested, asset);
  const root = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'xray-knife-action');
  const archive = path.join(root, asset);
  const destination = path.join(root, requested.replace(/[^\w.-]/g, '_') || 'latest');

  fs.mkdirSync(root, { recursive: true });

  describe(`Install xray-knife ${requested} (${asset})`);
  log(`Runner: ${process.platform}/${process.arch} -> ${asset}`);
  log(`Downloading ${url}`);
  download(url, archive);
  extract(archive, destination);

  const binary = findBinary(destination);
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
  return {
    ok: result.status === 0,
    detail: result.status === 0 ? `HTTP ${(result.stdout || '').trim()}` : firstLine(result.stderr) || `curl exited with ${result.status}`,
  };
}

async function startProxy(binary, poolFile, port, workdir) {
  const logFile = path.join(workdir, 'xray-knife-proxy.log');
  // A custom inbound link keeps the listener unauthenticated. xray's socks
  // inbound also answers plain HTTP proxy requests, so one port serves both
  // http:// and socks5:// clients.
  const args = [
    'proxy', 'inbound',
    '-f', poolFile,
    '--inbound-config', `socks://127.0.0.1:${port}#listener`,
    '--rotate', String(intInput('rotate', 0)),
  ];

  describe('Start local proxy');
  log(`$ xray-knife ${args.join(' ')}`);
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(binary, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  saveState('pid', child.pid);

  try {
    await waitForPort(port, intInput('start-timeout', 60) * 1000);
  } catch (error) {
    log(filteredLog(logFile));
    endDescribe();
    throw error;
  }
  log(`Proxy is listening on 127.0.0.1:${port} (pid ${child.pid})`);

  const proxyUrl = `http://127.0.0.1:${port}`;
  const targetUrl = getInput('test-url') || 'https://cloudflare.com/cdn-cgi/trace';
  let check = { ok: false, detail: 'not attempted' };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    check = curlThroughProxy(proxyUrl, targetUrl);
    if (check.ok) break;
    log(`proxy verification attempt ${attempt}/3 failed: ${check.detail}`);
    await sleep(2000);
  }

  if (!check.ok) {
    log(filteredLog(logFile));
    endDescribe();
    throw new Error(`the proxy started but cannot reach ${targetUrl}: ${check.detail}`);
  }

  log(`Proxy verified through ${targetUrl} (${check.detail})`);
  endDescribe();
  return { proxyUrl, pid: child.pid, logFile };
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
  const proxy = { proxyUrl: '', pid: '', logFile: '' };

  if (valid > 0 && shouldStartProxy) {
    try {
      const started = await startProxy(binary, validFile, intInput('port', 10809), workdir);
      proxy.proxyUrl = started.proxyUrl;
      proxy.pid = String(started.pid);
      proxy.logFile = started.logFile;
      setOutput('proxy', started.proxyUrl);
      setOutput('socks-proxy', started.proxyUrl.replace('http://', 'socks5://'));
      setOutput('pid', String(started.pid));
      setOutput('log-file', started.logFile);
      setOutput('proxy-available', 'true');

      if (getBoolInput('export-env', false)) {
        const socksUrl = started.proxyUrl.replace('http://', 'socks5://');
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
          setEnv(key, key.toLowerCase().includes('all') ? socksUrl : started.proxyUrl);
        }
        setEnv('NO_PROXY', 'localhost,127.0.0.1,::1');
        setEnv('no_proxy', 'localhost,127.0.0.1,::1');
        log('Exported proxy environment variables for the following steps.');
      }

      notice(`Proxy ready: ${started.proxyUrl} (${valid} working node(s))`);
    } catch (error) {
      setOutput('proxy-available', 'false');
      endSummary(version, total, valid, '');
      if (!allowEmpty) throw error;
      warn(`continuing without a proxy: ${error.message}`);
    }
  } else if (valid === 0) {
    warn('No working node was found, so no proxy was started.');
    if (!allowEmpty) {
      endSummary(version, total, 0, '');
      throw new Error(
        'none of the subscription nodes passed the test. ' +
          'Set "allow-empty: true" to continue anyway, raise "max-delay", or check the subscription.'
      );
    }
  }

  endSummary(version, total, valid, proxy.proxyUrl);
}

function endSummary(version, total, valid, proxyUrl) {
  const rows = [
    ['xray-knife', `\`${version}\``],
    ['imported nodes', String(total)],
    ['working nodes', String(valid)],
    ['proxy', proxyUrl ? `\`${proxyUrl}\`` : '_not started_'],
  ];
  summary(
    ['### Xray Knife Subscription Proxy', '', '| item | value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n')
  );
}

main().catch((error) => {
  process.stdout.write(`::error::${escapeData(error.message)}\n`);
  process.exitCode = 1;
});
