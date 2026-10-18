# xray-knife-action

A GitHub Action that turns a **subscription link** into a **working local proxy** for the rest of your workflow.

It installs the official prebuilt [xray-knife](https://github.com/lilendian0x00/xray-knife) binary — shipped
in this repository, so no download — for the runner's OS/architecture, imports the subscription, tests
every node for real latency, then starts a local proxy backed by a node that actually works. Everything is
exposed through step outputs, so later steps can use it with `curl`, `git`, `npm`, or any HTTP client.

```yaml
- uses: zaoanshijie/xray-knife-action@v1
  id: proxy
  with:
    subscription: ${{ secrets.SUBSCRIPTION_URL }}

- run: curl -x ${{ steps.proxy.outputs.proxy }} https://api.ipify.org
```

## Two ports, and why

xray-knife only guarantees a **SOCKS5** listener. xray-core happens to answer plain HTTP requests on that
port too (it sniffs them), but that is incidental:

| xray-knife invocation | SOCKS5 | HTTP proxy |
| --- | --- | --- |
| xray core, `--inbound-config socks://…` (no auth) | ✅ | ✅ (by accident) |
| xray core, default inbound (random username/password) | ❌ needs auth | ❌ |
| sing-box core, unauthenticated socks | ✅ | ❌ connection reset |

So this action does not rely on it. It starts xray-knife's SOCKS5 listener on `socks-port` and puts a small
HTTP relay (`src/http-proxy.js`, no dependencies) in front of it on `port`:

```
http://127.0.0.1:10809  ->  [HTTP relay]  ->  socks5://127.0.0.1:10810  ->  xray-knife  ->  node
```

The relay handles absolute-URI requests and `CONNECT` tunneling, so HTTP, HTTPS, POST bodies and WebSocket
upgrades all work regardless of the core or inbound mode. Both ports are verified end to end before the step
is reported as successful.

## Why

A CI runner needs a specific, verified egress. A subscription contains hundreds of nodes, most of them dead.
This action does the boring part in one step:

1. install `xray-knife` from the archive shipped in this repository (`vendor/`) — **no download**;
2. `xray-knife subs fetch` the subscription into `configs.txt`;
3. `xray-knife http` test each node and keep the working ones in `valid.txt`;
4. `xray-knife proxy inbound` serve them on `127.0.0.1:<socks-port>` with health-check based failover;
5. a small HTTP relay in front of that SOCKS5 listener on `127.0.0.1:<port>`;
6. kill both processes when the job ends.

Because the binary is bundled, the action itself needs no access to GitHub's release CDN — which is exactly
the thing that tends to be blocked or flaky on the networks where you need a proxy in the first place.
The subscription is still fetched by the runner, and that is what the proxy is for.

## Usage

### Proxy + explicit use

```yaml
jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: zaoanshijie/xray-knife-action@v1
        id: net
        with:
          subscription: ${{ secrets.SUBSCRIPTION_URL }}
          port: 10809

      - run: |
          curl -fsS -x "${{ steps.net.outputs.proxy }}" https://api.ipify.org
          git -c http.proxy="${{ steps.net.outputs.proxy }}" clone https://github.com/foo/bar
```

### Proxy + automatic environment variables

```yaml
      - uses: zaoanshijie/xray-knife-action@v1
        with:
          subscription: ${{ secrets.SUBSCRIPTION_URL }}
          export-env: true      # sets HTTP_PROXY / HTTPS_PROXY / ALL_PROXY for later steps

      - run: curl -fsS https://api.ipify.org
```

`NO_PROXY` is set to `localhost,127.0.0.1,::1` so loopback traffic never enters the tunnel.

### Just the CLI (no proxy)

```yaml
      - uses: zaoanshijie/xray-knife-action@v1     # bundled binary, no download

      - run: |
          xray-knife --version
          xray-knife subs fetch --url "$SUB" -o configs.txt
```

With no `subscription` the action only installs the binary and puts it on `PATH`.

### Reuse the node list

```yaml
      - uses: zaoanshijie/xray-knife-action@v1
        id: net
        with:
          subscription: ${{ secrets.SUBSCRIPTION_URL }}
          start-proxy: false        # test only

      - uses: actions/upload-artifact@v4
        with:
          name: working-nodes
          path: ${{ steps.net.outputs.valid-file }}
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `subscription` | `''` | Subscription URL (`http://` / `https://`). Plain lists and base64 lists are both accepted. Empty = install only. |
| `version` | `bundled` | `bundled` uses the archive committed to `vendor/` (no network). `latest` or a tag such as `v11.4.0` downloads from upstream instead. |
| `user-agent` | `''` | User-Agent used to fetch the subscription (some panels require e.g. `clash`). |
| `fetch-proxy` | `''` | Proxy used **only** for downloading the subscription. |
| `test` | `true` | Test the nodes and drop dead ones. |
| `test-url` | `https://cloudflare.com/cdn-cgi/trace` | URL fetched through each node. |
| `max-delay` | `3000` | A node slower than this (ms) counts as dead. |
| `threads` | `50` | Concurrent node tests. |
| `max-passed` | `0` | Stop after N working nodes (`0` = test everything). |
| `retries` | `0` | Retries per node. |
| `start-proxy` | `true` | Start the local proxy and keep it for the rest of the job. |
| `core` | `xray` | `xray` or `sing-box`. sing-box runs node types xray-core cannot (hysteria2, tuic, …). |
| `port` | `10809` | HTTP proxy port (the relay). |
| `socks-port` | `0` | SOCKS5 port; `0` means `port + 1`. |
| `rotate` | `0` | Seconds between rotations (`0` = rotate only on health-check failure). |
| `start-timeout` | `60` | Seconds to wait for the listener. |
| `export-env` | `false` | Export `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` (and lowercase variants). |
| `allow-empty` | `false` | Do not fail when no working node is found. |
| `workdir` | workspace | Where `configs.txt`, `valid.txt` and the proxy log are written. |

## Outputs

| Output | Description |
| --- | --- |
| `version` | Installed xray-knife version, e.g. `11.4.0`. |
| `xray-knife-path` | Absolute path of the binary. |
| `total-nodes` | Links imported from the subscription. |
| `valid-nodes` | Nodes that passed the test. |
| `proxy` | `http://127.0.0.1:<port>` (HTTP relay). |
| `socks-proxy` | `socks5://127.0.0.1:<socks-port>`. |
| `proxy-available` | `true` / `false`. |
| `pid` | xray-knife SOCKS5 listener process id. |
| `relay-pid` | HTTP relay process id. |
| `configs-file` | Path of the imported links. |
| `valid-file` | Path of the working links. |
| `log-file` | Path of the xray-knife proxy log. |
| `relay-log` | Path of the HTTP relay log. |

## Supported runners

| Runner | `process.platform/arch` | Archive | Source | Tested in CI |
| --- | --- | --- | --- | --- |
| `ubuntu-latest` / `ubuntu-22.04` / `ubuntu-24.04` | `linux/x64` | `Xray-knife-linux-64.zip` | bundled | ✅ native |
| `ubuntu-24.04-arm` | `linux/arm64` | `Xray-knife-linux-arm64-v8a.zip` | bundled | ✅ native |
| `windows-latest` / `windows-2022` | `win32/x64` | `Xray-knife-windows-64.zip` | bundled | ✅ native |
| Linux `armv7` | `linux/arm` | `Xray-knife-linux-arm32-v7a.zip` | bundled | mapping only |
| `macos-latest` | `darwin/arm64` | `Xray-knife-macos-arm64-v8a.zip` | download | ✅ native |
| `macos-13` | `darwin/x64` | `Xray-knife-macos-64.zip` | download | mapping only |
| Windows on Arm | `win32/arm64` | `Xray-knife-windows-arm64-v8a.zip` | download | mapping only |

"mapping only" means `src/platform.js` resolves the right asset and the archive name is covered by a unit
test, but no CI runner of that architecture was available. Unknown platforms fail loudly with the list of
supported ones. macOS archives are not vendored (they would double the repository size for a platform this
action is rarely used on), so `darwin` runners download from the upstream release.

## Bundled binaries

`vendor/` contains the official v11.4.0 archives for Linux x64 / arm64 / armv7 and Windows x64. Nothing is
downloaded at runtime, so the action works even when `github.com/.../releases/download` is blocked or
flaky — which is usually the case on the networks that need a proxy. See `vendor/README.md` for the
provenance and for the commands that refresh them.

The price is repository size (~92 MB): the runner fetches the action once per job, so on a very slow link
that is heavier than a single 24 MB download. If your runners have good access to GitHub releases,
`version: latest` keeps using the smaller, per-platform download.

## Notes

- **Secrets.** Always pass the subscription through `secrets`; the action registers it with `::add-mask::`.
  Node links are never printed: on failure only the listener lines of the proxy log are shown.
- **Runner support.** Linux (x64/arm64/armv7) and Windows x64 run from the bundled archives; macOS
  downloads from upstream. The action itself runs on `node24`, which GitHub-hosted runners provide.
- **Test cost.** Testing is the slow part: roughly `max-delay` × list size / `threads`. On huge
  subscriptions set `max-passed: 5` to stop as soon as enough nodes work.
- **Ports.** `port` (HTTP) and `socks-port` (SOCKS5) must be free; if something already listens there — for
  example a local xray-knife or Clash using 10809/10808 — the action fails immediately and names the port
  instead of silently proxying through the wrong process. Set `port`/`socks-port` to pick different ones.
- **Self-hosted runners.** Both processes are detached and killed by the post step. If a job is hard-cancelled
  the post step may not run; kill the leftovers using the `pid` and `relay-pid` outputs.
- **Legality.** Use it only with subscriptions you are allowed to use, and respect the terms of the services
  you connect to.

## Development

The action is plain Node.js with no dependencies and no build step:

```bash
node --check src/index.js
node --check src/socks.js
node --check src/http-proxy.js
node test/assets.test.js      # runner platform -> release asset mapping
node test/socks.test.js       # SOCKS5 address encoding (IPv4 / IPv6 / domain)
```

`test/fixture-server.js` serves a base64 subscription plus a target page, so the end-to-end job needs no
account. The rest of `.github/workflows/test.yml` runs real end-to-end tests: an install job on native
`linux/x64`, `linux/arm64` (Arm64 runner), `win32/x64` and `darwin/arm64`, plus an end-to-end test that
starts a local Xray server and exercises the HTTP proxy (GET, POST, CONNECT), the SOCKS5 port, the exported
environment variables and the post-step cleanup.

To exercise **your own** subscription, add a repository secret named `SUBSCRIPTION_URL` and run the
`Test` workflow manually from the Actions tab: the `real subscription` job will import it, test it and
print the egress IP through the proxy.

## 中文说明

把订阅链接变成 CI 里可用的本地代理，用法与 `actions/checkout` 一样是 `uses:` 一行：

```yaml
- uses: zaoanshijie/xray-knife-action@v1
  id: net
  with:
    subscription: ${{ secrets.SUBSCRIPTION_URL }}   # 你的订阅链接
    export-env: true                                # 后续步骤自动走代理

- run: curl -fsS https://api.ipify.org
```

它会：直接用仓库内自带的 xray-knife 预编译包（`vendor/`，**不联网下载**）→ 拉取订阅 → 逐节点测速 → 用可用
节点在 `127.0.0.1:10810` 起 SOCKS5 监听 → 再在其前面套一层内置 HTTP 中转，对外提供
`http://127.0.0.1:10809` → 作业结束时自动关闭两个进程。
HTTP 不依赖 xray-knife 内核是否顺手支持（sing-box 内核下它是不支持的），所以两个端口都可用。

节点全部失效时会直接报错（可用 `allow-empty: true` 放宽）；端口被占用（比如本机已有 xray-knife 占用
10809/10808）会立刻报错并指出端口，换 `port` / `socks-port` 即可。

## License

MIT
