# Steam Deck development and debugging

These helpers use the existing production builds, CommonJS backend and endpoints.
They do not enable debug listeners, change dependencies or alter runtime behavior.
Run commands from the repository root. Python 3.9+, Node.js, pnpm, OpenSSH (`ssh`
and `scp`) are required locally. The Deck needs Decky Loader, Python 3, curl, tar,
and systemd. On Windows use `python` instead of `python3` if necessary.

## One-time device setup (manual)

1. In Desktop Mode, enable SSH on the Deck (`sudo systemctl enable --now sshd`).
   Set a local sudo password with `passwd` if necessary. Use SSH keys or your SSH
   agent; the helpers never store or pipe passwords. Check the first connection's
   host fingerprint on the Deck; do not disable host-key verification.
2. Configure an alias in your workstation's `~/.ssh/config`, for example:

   ```sshconfig
   Host steamdeck
       HostName steamdeck.local
       User deck
   ```

   If `.local` resolution does not work, use the Deck's LAN address. Put a custom
   SSH port, key path or proxy configuration in this file, not in repository files.
   Test with `ssh steamdeck`. Sudo prompts use the terminal on the device session.
3. Install a normal, complete plugin ZIP via Decky's developer install UI first.
   Verify the installed directory, including `bin/node` and `bin/yt-dlp`. The SSH
   development deploy deliberately requires an existing installation.
4. Stay in Gaming Mode for frontend testing. Use the plugin's network trust
   control to trust the test network. The phone and Deck must share a network
   that permits multicast discovery. A healthy HTTP server alone does not mean
   the receiver is advertising.

All remote commands accept `--host` and `--plugin-path`. Defaults are SSH alias
`steamdeck` and `/home/deck/homebrew/plugins/YouTube Cast Receiver`. You can also
set `DECK_SSH_HOST` and `DECK_PLUGIN_PATH` in your shell. Flags override environment
values. Quote paths with spaces:

```sh
python3 scripts/deck-dev.py status --host deck@192.168.1.42
python3 scripts/deck-dev.py deploy --host steamdeck --plugin-path '/home/deck/homebrew/plugins/YouTube Cast Receiver'
```

## Build and package

```sh
pnpm install --frozen-lockfile
python3 scripts/deck-dev.py build
python3 -m unittest discover -s scripts/tests -v
```

`build` runs `pnpm run build`, `pnpm run build:backend`, and `pnpm test`, stopping
on failure. It produces `dist/index.js` and `backend/out/server.cjs`. It does not
install or update dependencies. Install pnpm on PATH before using this helper.
The separate Python helper tests use `sh` and `tar` to exercise the remote shell
locally; run those on macOS/Linux or in WSL/Git Bash on Windows.

For a complete installable ZIP on macOS, Windows or Linux:

```sh
pnpm run package
```

This calls `scripts/package.mjs`, installs from the frozen lockfile, builds both
bundles, and produces `youtube-cast-receiver.zip`. The host needs Node.js 20+,
pnpm and `tar` with gzip support. macOS and most Linux distributions include tar;
on Windows 10/11 the packager uses `%SystemRoot%/System32/tar.exe`. Older Windows
versions without it are not supported. No PowerShell, Python or external ZIP tool
is required for this packaging command. `build.ps1` is a compatibility wrapper.
Run tests separately; packaging does not run them.
The packaging command passes Rollup's `--forceExit` flag for its one-shot frontend
build because the existing TypeScript plugin can retain file watchers after
emitting output. This does not change bundle contents or the normal build script.

Downloads always target **Linux x86_64**, independently of your workstation's OS
or CPU. Node remains pinned to v20.18.3; yt-dlp uses the upstream latest standalone
`yt-dlp_linux` release (glibc x86_64), stored as `bin/yt-dlp`. This replaces the old
generic Python zipapp download and avoids depending on SteamOS's Python version.
See the upstream [release asset descriptions](https://github.com/yt-dlp/yt-dlp#release-files).
Both assets are checked against published SHA-256 sums, then validated as ELF64
x86_64 executables. A failed transfer is retried up to three times with a
five-minute timeout per attempt.

Verified binaries are cached with hashes in `bin/.package-binaries.json`. Repeated
builds reuse this cache (including the same yt-dlp release); deleting that metadata
file forces a fresh download on the next package run. Preexisting binaries without
matching metadata, corrupt binaries, or host executables are replaced. Neither
the cache metadata nor download archives enter the plugin ZIP. The Linux binaries
are never executed on the build host.

For packaging artifacts that have already been built:

```sh
pnpm run package --skip-build
```

This skips dependency installation and builds, but still validates/downloads the
Linux binaries as necessary and checks all required files. The earlier Python
`deck-dev.py package` remains an artifact-only helper for custom output paths;
it neither downloads nor validates binary architecture. Prefer the Node packager
for installable builds.

The ZIP has a `YouTube Cast Receiver/` top-level folder and executable permission
bits for `bin/*`, including when packaged on Windows. It contains bundles, XML,
Python launcher, metadata, license, and the two binaries. Local config, scripts,
dependencies and stale `server.js` files are excluded. A validated replacement ZIP
is written in a unique temporary directory and renamed into place, preserving the
previous ZIP on failure; temporary files are removed in `finally` blocks. Abrupt
process termination or power loss can leave `.package-*` directories; with no
packager running, remove these manually before retrying. Install the ZIP using
Decky's developer installer for an end-to-end check. Windows/Linux host behavior
and on-device execution still require validation on those platforms.
Run one packaging command at a time; the build outputs and binary cache are shared.

## Deploy a code update over SSH

```sh
python3 scripts/deck-dev.py build
python3 scripts/deck-dev.py deploy
python3 scripts/deck-dev.py status
```

Deploy uploads an allowlisted code archive to a unique `/tmp/ytcast-dev.*`
directory, validates the installed plugin identity and binaries, and saves a
`previous-code.tar.gz` backup there. It then stops **only**
`plugin_loader.service`, overlays the code, checks `server.cjs` with the installed
Node binary, and starts Decky Loader again. This briefly interrupts **all Decky
plugins**; finish any active cast first. Steam, gamescope and Steam webhelper are
not restarted. SSH/sudo authentication is interactive when necessary.

The backup captures the installed `backend/out/` directory as it exists, so
upgrading an older `server.js` installation is supported. It also preserves any
old nested `package.json` override for rollback; the new launcher uses `server.cjs`
explicitly. Backup failures stop deployment before Decky is stopped or code is
overwritten.

The deploy leaves `bin/`, settings and pairing data untouched. Settings currently
live at `/home/deck/homebrew/settings/youtube-cast-receiver/`, independent of the
configured plugin path. It does not install a second copy or change the plugin
name/version. Reopen the Quick Access/Decky panel after deployment and verify the
new UI and backend; there is no automatic frontend hot reload or added runtime
debug instrumentation. The existing Rollup source maps are preserved.

Deploy is a development overlay, not an atomic installation. On failure the
script attempts to start Decky again, but does not automatically roll back code.
The printed remote staging directory is retained for recovery. If SSH disconnects
or extraction fails, inspect `sudo systemctl status plugin_loader.service` on the
Deck. To restore, open an interactive SSH shell, set the actual paths below, and
run manually:

```sh
PLUGIN_PATH='/home/deck/homebrew/plugins/YouTube Cast Receiver'
BACKUP='/tmp/ytcast-dev.REPLACE/previous-code.tar.gz'
sudo systemctl stop plugin_loader.service
sudo tar -xzf "$BACKUP" -C "$PLUGIN_PATH" --no-same-owner
sudo systemctl start plugin_loader.service
```

Alternatively reinstall a known working ZIP using Decky. Backups in `/tmp` are
temporary and disappear after reboot; copy a backup off-device if needed. After
verification, remove only the printed staging directory manually. A new full ZIP
install is required when changing bundled binaries; SSH deploy does not update
the staged `/tmp/youtube-cast-receiver` binaries.

## Backend health, advertising and journal

```sh
python3 scripts/deck-dev.py status
python3 scripts/deck-dev.py logs
```

`status` runs a health GET request **on the Deck**, where the backend listens only on
`127.0.0.1:39281`, with five-second timeouts, followed by recent YTCast journal
entries from the current boot. An HTTP failure produces a nonzero exit status;
the journal is still shown. Private state/network/pairing reads now require the
Decky frontend capability, so the SSH helper does not fetch or print them.
Inspect those through the authorized frontend/CEF session. `logs` follows the full Decky Loader journal; Ctrl+C
ends the viewer without stopping the service.

Interpret the evidence together:

| Evidence | Meaning |
| --- | --- |
| `/api/health` returns `{"ready":true}` | HTTP handler is alive; it is not a discovery or playback test. |
| `/api/network/current` has `name` and `trusted:true` | Current network is eligible for advertising; startup can still fail. |
| `READY` in the journal | Startup reached readiness, including an idle receiver on an untrusted network. |
| `Cast receiver advertising` or `Cast receiver advertising. ...` | Receiver start succeeded at that timestamp. |
| `stopped advertising`, `idle`, reconcile/fetch errors | Receiver stopped or could not start; inspect later retries as well. |
| `/api/state` has `connected:true` | A sender connection exists; it is distinct from advertising. |

There is no live `advertising` field in the HTTP API. Journal entries are
historical: consider the latest start/stop/rebind/error and process restart,
not an old successful message. Verify discovery from a phone on the same LAN,
then cast a track to test extraction, audio and progress. If available, capture
SSDP on the Deck with `sudo tcpdump -ni any udp port 1900` while toggling the
plugin's network trust control or opening the phone's cast picker. Installing
tcpdump is optional and is not performed by these scripts.

## Frontend debugging with Steam CEF DevTools

### TV-code pairing verification on the Deck

Pairing uses `GET /api/pairing`, `POST /api/pairing/start` and
`POST /api/pairing/stop`. Each returns an in-memory snapshot with `status`
(`idle`, `loading`, `ready`, `error`), `code`, `error` and `expiresAt` (Unix
milliseconds, or null). Changes arrive as WebSocket `{event: "pairing", data: ...}`
messages. GET is read-only and does not start generation. Do not capture real
pairing codes in debug logs or saved API transcripts.

All private HTTP routes require `Authorization: Bearer <capability>`. `main.py`
generates 256 random bits at each launch, supplies the capability to Node through
`YTCAST_API_TOKEN`, and exposes `get_api_token` only through Decky RPC. Node removes
that variable from its environment before spawning yt-dlp. Missing capabilities
fail closed at startup. There is no plugin-local bootstrap endpoint or on-disk
token. Reconnects discard cached frontend capabilities and obtain the current one
via Decky; pending RPC/HTTP/socket work from an old session is ignored.

The backend accepts the exact Host `127.0.0.1:39281`. Browser requests must use the
exact origin `https://steamloopback.host`; null, foreign and lookalike origins are
rejected even with a valid capability. Native requests with no Origin still need
the capability. CORS allows only that Steam origin and the required headers,
never `*`. Sensitive responses use `Cache-Control: no-store`. WebSocket upgrades
validate the same source policy and use two request subprotocols: `ytcast-v1` and
`ytcast-auth.<capability>`. The response selects only `ytcast-v1`; no secret goes in
a URL or is echoed as the negotiated protocol. Unauthenticated sockets never join
the broadcast client set. This also protects existing playback/queue endpoints.

Trust boundary: Decky's RPC/CEF session and other code controlling it are
privileged. Upstream Decky's localhost `/auth/token` bootstrap is readable by
native clients; a process able to use that to control Decky can call plugin RPC
as well. Plugin-local capabilities do not isolate the plugin from such a process,
from other privileged Decky plugins, or from root. Do not treat Origin alone as
native-client authentication or weaken this policy to debug a connection.

The idle check uses the existing ten-second network poll. It releases manual mode
only after generation is inactive, initialization/fetch/drain work has finished,
the latest numeric SDK response is at least five minutes plus 30 seconds old, and
the SDK reports no connected senders and the player is not playing. No issued
code means no pairing-window delay. On a trusted network automatic discovery must
run anyway, so prior manual intent is retained without extra resources or a
restart. Eligibility is rechecked when the receiver becomes manual-only, using
the then-current sender/playback state. No new polling interval is added.

The installed SDK schedules its five-minute refresh immediately after emitting
`response`; `stop()` is a no-op when its status is already STOPPED. The manager
therefore defers stopping an in-flight fetch until a microtask after its event
returns. It also serializes the same service's public start/stop methods used by
SDK session recovery. A canceled generation never exposes a late code or starts
overlapping fetches. Disposal waits for settlement before normal receiver teardown;
the existing bounded shutdown/process exit remains the fallback for a hung fetch.
Tests exercise the actual installed SDK service, not only a mock of these timings.

Local tests cover the pairing manager, REST/WebSocket transitions, client state
resynchronization, and the installed SDK's address-filter behavior with fake UDP
sockets. The following still need real-device verification:

- With **Trust this network** off, generate a code in Pairing and link from the
  YouTube mobile app, including from a different network. Confirm playback,
  queue, progress and volume work. The SDK still opens its DIAL HTTP listener
  (default port 3000), which must be free even in manual mode.
- Keep the tab open for more than five minutes to verify code refreshes. Close
  and reopen the panel, then break/restore the WebSocket connection: there should
  be one continuing code-generation service and the latest state should return.
- Stop during a request, retry after an internet error, and restart the backend.
  Stopped/expired codes must disappear; late replies must not resurrect them.
  The SDK's fetch cannot be canceled through its public API, so a retry waits for
  a previous in-flight fetch to settle instead of starting overlapping requests.
- Toggle network trust while a manually linked phone is playing. Allow up to
  15 seconds for the SDK's interface scan; verify SSDP is restricted on untrusted
  networks and resumes on trusted ones without interrupting the manual session.
  Also test ordinary automatic discovery without generating a TV code.
- Check Pairing tab focus/scroll behavior with the gamepad and confirm pairing
  codes are absent from the backend journal and settings files. Existing session
  identifiers and network trust preferences still persist normally.
- Restart/redeploy the backend with the panel open: capability rotation must
  reconnect automatically, and normal playback controls and queue jumps must
  still work. Confirm the real CEF Origin is the allowlisted Steam origin; do not
  add wildcard CORS if it differs. From an ordinary localhost client, private
  HTTP and unauthenticated WebSocket access must fail while health still works.
- Stop generation with and without an active phone. The active phone must keep
  playing; an unused manual-only receiver should stop after the defined pairing
  window and the next network poll. Verify restarting generation reactivates it.

### Attach Steam CEF DevTools

1. On the Deck, enable Steam Developer Mode in Settings → System, then enable
   **CEF Remote Debugging** under Developer settings. Labels vary by SteamOS
   version. Apply any Steam-requested restart manually after saving your work;
   the scripts do not restart Steam. Decky's upstream setup instructions also
   describe this [developer setting](https://github.com/SteamDeckHomebrew/decky-loader#installation).
2. Open the plugin panel in Gaming Mode and start a loopback-only SSH tunnel:

   ```sh
   python3 scripts/deck-dev.py devtools
   # If your device uses another CEF port:
   python3 scripts/deck-dev.py devtools --cef-port 8081 --local-port 18080
   ```

   The default remote port is 8080, matching Decky's
   [CEF injector](https://github.com/SteamDeckHomebrew/decky-loader/blob/main/backend/decky_loader/injector.py).
   `DECK_CEF_PORT` also overrides it. Port 8081 may be a Decky forwarding port on
   some setups; use the actual listening endpoint. You do not need to expose a
   debugging port to the LAN or enable Decky's network forwarding when using SSH.
3. In desktop Chrome, open `chrome://inspect/#devices`, enable network target
   discovery, click **Configure**, and add `127.0.0.1:18080`. Select **inspect** on
   the Steam Gamepad UI/Quick Access target containing the plugin (often titled
   `SP` or `SharedJSContext`; identify it by opening the plugin panel). The plugin
   is injected into Steam UI, not a standalone webpage. You can check discovery
   separately at `http://127.0.0.1:18080/json`.
4. Use Console for frontend errors; use Network to inspect local requests to
   port 39281 and WebSocket frames. Enable JavaScript source maps in DevTools
   settings. In Sources, search for `audioManager` or the plugin name; the existing
   Rollup maps use `decky://decky/plugin/...` paths. If maps do not resolve,
   pretty-print the generated bundle and set breakpoints there.
   Enable Preserve log before reproducing panel close/reopen, queue and playback
   behavior. Evaluate `fetch('http://127.0.0.1:39281/api/health').then(r => r.json())`
   in the **Deck's target context**, not your workstation browser console.
5. After a deploy, reopen the panel and reconnect DevTools if its target changed.
   If the frontend still appears stale, use Decky's available plugin reload UI;
   do not reload the entire Steam page while a game or cast is active. Rebuild and
   deploy again for source edits; editing Sources alone is temporary.
6. Close the SSH tunnel with Ctrl+C and disable CEF Remote Debugging when finished.
   DevTools controls the Steam UI session; keep it on a trusted development device.

If no targets appear, confirm Gaming Mode, the developer toggle, the selected
remote port and SSH configuration (use `--host` on the helper, or
`ssh steamdeck` directly). A tunnel that starts successfully only confirms that
the local port was bound; inspect `/json` to verify the remote CEF listener.
