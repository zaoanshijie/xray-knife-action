# xray-knife-action

A GitHub Action that turns a **subscription link** into a **working local proxy** for the rest of your workflow.

It installs the official prebuilt [xray-knife](https://github.com/lilendian0x00/xray-knife) binary for the
runner's OS/architecture, imports the subscription, tests every node for real latency, then starts a local
proxy backed by a node that actually works. Everything is exposed through step outputs, so later steps can
use it with `curl`, `git`, `npm`, or any HTTP client.

```yaml
- uses: zaoanshijie/xray-knife-action@v1
  id: proxy
  with:
    subscription: ${{ secrets.SUBSCRIPTION_URL }}

- run: curl -x ${{ steps.proxy.outputs.proxy }} https://api.ipify.org
```

## Why

A CI runner needs a specific, verified egress. A subscription contains hundreds of nodes, most of them dead.
This action does the boring part in one step:

1. download and install `xray-knife` from its official GitHub releases (no Go toolchain, no build);
2. `xray-knife subs fetch` the subscription into `configs.txt`;
3. `xray-knife http` test each node and keep the working ones in `valid.txt`;
4. `xray-knife proxy inbound` serve them on `127.0.0.1:<port>` (HTTP **and** SOCKS5 on the same port),
   with health-check based failover;
5. kill the proxy automatically when the job ends.

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
      - uses: zaoanshijie/xray-knife-action@v1
        with:
          version: v11.4.0

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
| `version` | `latest` | Release to install: `latest`, `v11.4.0` or `11.4.0`. |
| `user-agent` | `''` | User-Agent used to fetch the subscription (some panels require e.g. `clash`). |
| `fetch-proxy` | `''` | Proxy used **only** for downloading the subscription. |
| `test` | `true` | Test the nodes and drop dead ones. |
| `test-url` | `https://cloudflare.com/cdn-cgi/trace` | URL fetched through each node. |
| `max-delay` | `3000` | A node slower than this (ms) counts as dead. |
| `threads` | `50` | Concurrent node tests. |
| `max-passed` | `0` | Stop after N working nodes (`0` = test everything). |
| `retries` | `0` | Retries per node. |
| `start-proxy` | `true` | Start the local proxy and keep it for the rest of the job. |
| `port` | `10809` | Local port; serves HTTP and SOCKS5 at once. |
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
| `proxy` | `http://127.0.0.1:<port>`. |
| `socks-proxy` | `socks5://127.0.0.1:<port>`. |
| `proxy-available` | `true` / `false`. |
| `pid` | Proxy process id. |
| `configs-file` | Path of the imported links. |
| `valid-file` | Path of the working links. |
| `log-file` | Path of the proxy log. |

## Notes

- **Secrets.** Always pass the subscription through `secrets`; the action registers it with `::add-mask::`.
  Node links are never printed: on failure only the listener lines of the proxy log are shown.
- **Runner support.** Linux (x64/arm64/armv7), macOS (Intel/Apple Silicon) and Windows (x64/arm64) are
  covered by the upstream release assets. The action itself runs on `node24`, which GitHub-hosted
  runners provide.
- **Test cost.** Testing is the slow part: roughly `max-delay` × list size / `threads`. On huge
  subscriptions set `max-passed: 5` to stop as soon as enough nodes work.
- **Self-hosted runners.** The proxy is detached and killed by the post step. If a job is hard-cancelled the
  post step may not run; kill the leftover process by the `pid` output.
- **Legality.** Use it only with subscriptions you are allowed to use, and respect the terms of the services
  you connect to.

## Development

The action is plain Node.js with no dependencies and no build step:

```bash
node --check src/index.js
node --check src/cleanup.js
```

`npm test` style unit tests are intentionally absent; `.github/workflows/test.yml` runs a real end-to-end
test against a local Xray server it starts itself, so no external subscription is needed.

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

它会：下载 xray-knife 官方预编译包 → 拉取订阅 → 逐节点测速 → 用可用节点在 `127.0.0.1:10809` 起一个
同时支持 HTTP 与 SOCKS5 的本地代理 → 作业结束时自动关闭。节点全部失效时会直接报错（可用
`allow-empty: true` 放宽），所有输出见上表。

## License

MIT
