# pi-happ

[Русская версия](README.md)

An unofficial port of Happ's minimal functionality to pi: manage subscriptions, select a VPN location, and check your public IP directly in the TUI. This is not a full port of the Happ application: the extension launches Xray as a child process, without TUN or a system-wide VPN.

Linux, Node.js 22.19+, pi 1.6.0.

## Status: under development

Implemented:
- `/happ` TUI command: add, update, and remove subscriptions, and select a location;
- import HTTPS subscriptions containing an array of Xray JSON profiles;
- child-process Xray without TUN, sudo, happd, or a system proxy;
- public IP checks using `https://icanhazip.com`, strictly through the local HTTP proxy;
- Xray shutdown on normal session exit, `/reload`, and session replacement;
- private local subscription storage.

OpenAI, Anthropic, and Codex retain their built-in catalogs and authentication, with a protected transport. Requests go directly until you enable the VPN. Selecting a location enables protected VPN mode, which uses HTTP/SSE, including for Codex; WebSocket is forcibly disabled. Explicitly stopping via `/happ` → “Stop”, or cancelling connection setup with Esc, restores direct access. Connection failures, unexpected Xray/watchdog exits, and connectivity loss never trigger a direct fallback: requests fail until you reconnect or explicitly disable the VPN. Requests are also blocked during connection setup until the tunnel is ready. Stopping or changing the connection aborts requests and destroys the connection pool. A new session, including after `/reload`, starts without a connected VPN and allows direct access.

OAuth login/refresh uses an AsyncLocalStorage-scoped global fetch wrapper: only asynchronous work inside these providers' OAuth flows is routed through the proxy; other fetch calls are unchanged. Environment variables and system network settings are not modified. The external browser is not covered; localhost callbacks stay local. This is not a network sandbox: other providers, user tools, and arbitrary networking libraries are not protected.

## Getting started

A clean Linux VPS only needs Node.js 22.19+ and pi. Happ, curl, unzip, root access, and system services are not required.

Install the extension from GitHub and start pi:

```sh
pi install git:github.com/wrongnull/pi-happ
pi
```

If pi is already running, use `/reload` after installation.

Add a subscription and select a location in `/happ`. On the first connection, the extension downloads official Xray **26.11.9** (Linux x64/arm64), verifies the archive against the SHA-256 pinned in the source code, and installs only the binary into `~/.local/share/pi-happ/runtimes/`. Subsequent connections use the local cache after verifying the binary's hash. The initial download requires access to GitHub before connecting to the VPN.

You can prepare the runtime in advance using `/happ-runtime-install`, without starting the VPN. Installation is atomic; an archive that fails verification is never executed. Installation does not run automatically when the extension loads.

Runtime updates are tied to extension releases: the version and SHA-256 values in `src/runtime.mjs` must be updated; an arbitrary `latest` release is never downloaded. For offline installation or another Linux architecture, provide your own binary using `PI_HAPP_XRAY` (you are responsible for verifying its origin and integrity). If a cached version directory is damaged, delete it and retry installation.

`/happ-ip-check` checks your public IP through the active tunnel using `icanhazip.com`, without opening the menu. It shows the IP, location, HTTPS request duration in milliseconds (including connection/TLS setup and receiving the response; not an ICMP ping), and check time. Without a connected VPN, it returns an error rather than making a direct request.

Use `/happ` → “Add subscription”. Enter the secret URL in the dialog, not in a message to the model. To use a custom runtime:

```sh
PI_HAPP_XRAY=/path/to/xray pi
```

Cloning the repository and manually installing npm dependencies are not required for normal use.

## Cancellation and diagnostics

During runtime installation, subscription downloads, and connection setup, the TUI displays a cancellable loader: press Esc. Cancelling a connection stops Xray and its watchdog and removes the temporary configuration; the UI waits for cleanup to finish. In RPC mode, the same operation signal is aborted on session shutdown (interactive Esc cancellation is TUI-only).

`/happ-diagnostics` shows the runtime status and the last recognized error category. Raw Xray output is neither displayed nor written to a file, as it may contain keys and addresses. Recognized categories include configuration, port, permission, DNS, TLS/Reality, and VPN server connectivity errors. Diagnostics use a limited set of known patterns; no recognized category does not mean no error occurred.

## Headless OAuth on a VPS

First connect a location in `/happ`, then use `/login`:
- OpenAI Codex → **Device code login (headless)**: open the link on your own computer and confirm the code;
- Anthropic → **Copy code login (headless)**: open the link on your own computer and paste the resulting code into pi's login dialog.

These methods do not require a browser on the VPS or an SSH callback tunnel. Token exchanges and refresh requests on the VPS go through the child-process Xray; your computer's browser does not automatically use that VPN. Never paste codes or tokens into the model chat.

## Limitations and security

- Subscriptions are stored in `~/.config/pi-happ/subscriptions.json` (file mode 0600, newly created directory mode 0700). They contain plaintext secrets: do not publish or commit them.
- The extension does not add subscription URLs or contents to pi messages or sessions.
- Subscription downloads currently use a direct connection, with a 25-second timeout, no redirects, and a 4 MiB limit. Only JSON arrays are supported; URI/Base64, YAML, and happ:// imports are not supported yet.
- The first supported proxy outbound is the profile entry point; all reachable `proxySettings.tag` and `streamSettings.sockopt.dialerProxy` dependencies are retained. Missing/duplicate tags, cycles, and references to direct or unsupported outbounds are rejected. Original listeners, routing, DNS, and API settings are not used. Balancers, interface bindings, and arbitrary routing rules are not supported.
- Protocol support depends on the installed Xray runtime. Startup or IP-check failures never trigger a direct fallback.
- The local proxy listens only on 127.0.0.1, on a randomly allocated port, without authentication (other local processes can access it).
- Xray must pass a public IP check before the connection is declared ready. Startup can take about 40 seconds, plus the initial runtime download (120-second timeout, archive limit 80 MiB).
- On Linux, Xray remains a direct child of pi. A separate Node.js watchdog monitors a private pipe: if pi dies (including SIGKILL), the pipe closes, the watchdog sends SIGTERM to Xray, escalates to SIGKILL after 2 seconds if necessary, and then removes the temporary configuration. Checking the PID and `/proc` starttime guards against PID reuse. If the watchdog exits unexpectedly while pi remains alive, pi stops Xray and invalidates the transport.
- The watchdog requires Linux with accessible `/proc`. This is userspace protection: there is a short window between launching Xray and watchdog readiness. Simultaneous SIGKILL of both pi and the watchdog is not covered either. An absolute guarantee would require a Linux parent-death signal via a native launcher. A connection is not declared ready until the watchdog starts.
- Only use trusted subscriptions. Complete validation of nested outbound settings and network addresses has not been implemented.
- Loading the extension does not automatically start or connect the VPN or change system network settings.

## Development

```sh
npm test
npm run check
```

After cloning, run `npm ci --legacy-peer-deps` to install undici (HTTP CONNECT transport) and fflate (verified ZIP extraction without external utilities).

Tests run offline using synthetic profiles and a local CONNECT proxy. They cover routing, scoped OAuth fetch, signal cancellation, and the absence of a direct fallback after proxy failure. Watchdog tests launch a synthetic Xray process and cover parent SIGKILL, escalation for a process that ignores SIGTERM, watchdog failure, and normal shutdown, including configuration cleanup. Real subscriptions and accounts are not used in tests.

Extension loading has been checked using `pi -e ./src/extension.ts --list-models openai`. `npm run check` checks the TypeScript entry point against pi's API and parses the JavaScript modules (deep `checkJs` validation is currently disabled). CI runs type checking and tests on Node.js 22/24.

Separate tests use the real OpenAI, Anthropic, and Codex adapters against a local mock server. They verify CONNECT routing, successful text SSE responses, API error handling, and SSE interruption when the VPN changes. Active connection cancellation with process cleanup and proxy-chain validation are also covered. The full TUI and real OAuth accounts are not covered by automated tests yet.

## License

The extension's code is distributed under the [MIT License](LICENSE). Xray and third-party dependencies retain their own licenses; this project's MIT License does not apply to them.

## Next steps

1. Support WebSocket without forcing SSE. The external browser requires a separate solution; loopback callbacks must remain local.
2. Support additional subscription formats and more complex profiles with balancers/routing.
3. Search and favorites. The watchdog, bulk subscription updates, and transport invalidation on runtime failure are already implemented.
