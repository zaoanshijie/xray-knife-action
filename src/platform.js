'use strict';

/*
 * Maps a runner's platform/arch to the archive name published by
 * https://github.com/lilendian0x00/xray-knife/releases.
 *
 * Kept in its own module so the mapping can be unit tested without executing
 * the action entry point.
 */

const ASSETS = {
  // linux
  'linux-x64': 'Xray-knife-linux-64.zip',
  'linux-arm64': 'Xray-knife-linux-arm64-v8a.zip',
  'linux-arm': 'Xray-knife-linux-arm32-v7a.zip',
  // windows
  'win32-x64': 'Xray-knife-windows-64.zip',
  'win32-arm64': 'Xray-knife-windows-arm64-v8a.zip',
  // macOS
  'darwin-x64': 'Xray-knife-macos-64.zip',
  'darwin-arm64': 'Xray-knife-macos-arm64-v8a.zip',
};

// process.arch values that mean the same build.
const ARCH_ALIASES = {
  x64: ['x64', 'x86_64', 'amd64'],
  arm64: ['arm64', 'aarch64'],
  arm: ['arm', 'armv7l', 'armv6l'],
  ia32: ['ia32', 'x86', 'i686'],
};

function normalizeArch(arch) {
  for (const [canonical, aliases] of Object.entries(ARCH_ALIASES)) {
    if (aliases.includes(arch)) return canonical;
  }
  return arch;
}

/**
 * @param {string} platform Node's process.platform (linux, win32, darwin).
 * @param {string} arch     Node's process.arch (x64, arm64, arm, ia32).
 * @returns {string} release archive name.
 */
function resolveAsset(platform, arch) {
  const key = `${platform}-${normalizeArch(arch)}`;
  const asset = ASSETS[key];
  if (!asset) {
    throw new Error(
      `unsupported runner platform "${platform}/${arch}". ` +
        `Supported: ${Object.keys(ASSETS).join(', ')}`
    );
  }
  return asset;
}

module.exports = { resolveAsset, normalizeArch, ASSETS };
