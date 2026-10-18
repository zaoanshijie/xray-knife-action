# Bundled xray-knife archives

These are the **official, unmodified** prebuilt archives from
[`lilendian0x00/xray-knife` releases](https://github.com/lilendian0x00/xray-knife/releases),
committed here so the action never has to reach the release CDN at runtime.

| Archive | Runner | Upstream asset |
| --- | --- | --- |
| `Xray-knife-linux-64.zip` | Linux x86_64 | `Xray-knife-linux-64.zip` |
| `Xray-knife-linux-arm64-v8a.zip` | Linux arm64 | `Xray-knife-linux-arm64-v8a.zip` |
| `Xray-knife-linux-arm32-v7a.zip` | Linux armv7 | `Xray-knife-linux-arm32-v7a.zip` |
| `Xray-knife-windows-64.zip` | Windows x86_64 | `Xray-knife-windows-64.zip` |

Bundled version: **v11.4.0**.

No macOS archive is bundled — `darwin` runners fall back to downloading from the upstream release.
`version: latest` (or a pinned tag) also downloads, which is only useful on runners with decent access
to GitHub releases.

## Refreshing a bundled version

```bash
BASE=https://github.com/lilendian0x00/xray-knife/releases/download/v11.4.0
curl -fL -o vendor/Xray-knife-linux-64.zip          "$BASE/Xray-knife-linux-64.zip"
curl -fL -o vendor/Xray-knife-linux-arm64-v8a.zip   "$BASE/Xray-knife-linux-arm64-v8a.zip"
curl -fL -o vendor/Xray-knife-linux-arm32-v7a.zip   "$BASE/Xray-knife-linux-arm32-v7a.zip"
curl -fL -o vendor/Xray-knife-windows-64.zip        "$BASE/Xray-knife-windows-64.zip"
```

Then update the version asserted in `.github/workflows/test.yml` (`test "${{ steps.xk.outputs.version }}" = "11.4.0"`),
the table above, and the `version` row of the main README.

Sanity check after replacing the files — every archive must contain exactly `LICENSE`, `README.md` and
the `xray-knife` binary (or `xray-knife.exe` for Windows):

```bash
unzip -l vendor/Xray-knife-linux-64.zip
```
