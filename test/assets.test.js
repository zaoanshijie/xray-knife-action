'use strict';

/*
 * Unit tests for the runner-platform -> release-asset mapping.
 * Run with: node test/assets.test.js
 */

const assert = require('assert');
const { resolveAsset, normalizeArch } = require('../src/platform');

const cases = {
  // required by the action's supported matrix
  'linux/x64': 'Xray-knife-linux-64.zip',
  'linux/arm64': 'Xray-knife-linux-arm64-v8a.zip',
  'win32/x64': 'Xray-knife-windows-64.zip',
  // extra coverage
  'linux/arm': 'Xray-knife-linux-arm32-v7a.zip',
  'win32/arm64': 'Xray-knife-windows-arm64-v8a.zip',
  'darwin/x64': 'Xray-knife-macos-64.zip',
  'darwin/arm64': 'Xray-knife-macos-arm64-v8a.zip',
  // arch aliases seen on self-hosted runners
  'linux/amd64': 'Xray-knife-linux-64.zip',
  'linux/aarch64': 'Xray-knife-linux-arm64-v8a.zip',
};

for (const [target, expected] of Object.entries(cases)) {
  const [platform, arch] = target.split('/');
  const actual = resolveAsset(platform, arch);
  assert.strictEqual(actual, expected, `${target} should map to ${expected}, got ${actual}`);
}

assert.strictEqual(normalizeArch('x86_64'), 'x64');
assert.strictEqual(normalizeArch('aarch64'), 'arm64');

assert.throws(() => resolveAsset('freebsd', 'x64'), /unsupported runner platform/);
assert.throws(() => resolveAsset('linux', 'mips'), /unsupported runner platform/);

console.log(`platform mapping ok (${Object.keys(cases).length} cases)`);
