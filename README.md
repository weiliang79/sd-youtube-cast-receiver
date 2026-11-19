# YouTube Cast Receiver for Steam Deck

A [Decky Loader](https://decky.xyz/) plugin that turns your Steam Deck into a YouTube Cast receiver. Cast music and videos from the YouTube or YouTube Music app on your phone and control playback from the Decky panel.

## Features

- Cast audio from YouTube / YouTube Music on your phone to your Steam Deck
- Player tab with album art, track info, progress bar, and playback controls (play/pause/next/prev)
- Queue tab showing upcoming tracks with metadata
- Pairing tab with a TV code for manual linking when automatic discovery is unavailable
- Volume control from the Deck panel
- Persistent pairing — pair once, auto-reconnects on plugin load
- Audio-only playback (works like a Chromecast Audio)

## How to Use

1. Install the plugin via Decky Loader (developer mode, install from ZIP)
2. Open the Decky panel and enable **Trust this network** in Player to allow automatic discovery
3. On your phone, open YouTube or YouTube Music
4. Tap the **Cast** icon and select your Steam Deck (shown by its hostname)
5. Play a song — audio plays through the Steam Deck

### Automatic discovery

The plugin uses DIAL/SSDP for automatic discovery on trusted networks. Your phone
and Steam Deck must be on the same LAN and your router must allow multicast
between them. Previously linked phones can reconnect while the receiver is running.

### Manual pairing: Link with TV code

1. On the Deck, open **YouTube Cast → Pairing → Generate TV code**.
2. On your phone, open the **YouTube** app, tap **Cast → Add a device**
   (or **Link with TV code**, depending on the app version). Older versions expose
   code entry under **Settings → General → Watch on TV**.
3. Enter the code displayed on the Deck and tap **Link**. Select the linked
   **YouTube on <Deck hostname>** receiver and start playback.

See [YouTube's TV-code instructions](https://support.google.com/youtube/answer/7640706?hl=en)
for current app labels. TV-code entry uses the mobile app, not a desktop browser.

Both devices need internet access, but they can be on different networks. Manual
pairing does not require enabling **Trust this network** or multicast discovery.
The library initializes a YouTube session for manual pairing; LAN SSDP advertising
stays disabled unless the current network is trusted. The library's DIAL HTTP
listener still exists while that session runs; this is not a separate pairing
protocol or a second receiver.

Codes refresh automatically about every five minutes. Use the latest displayed
code; the old code is hidden while refreshing. Close/reopen the panel without
losing an active request, and use **Retry** if generation fails. A backend
reconnection reloads the current state. A backend restart clears the displayed
code and stops generation; generate again when you need a code or to reactivate
a manual-only session. Codes are neither logged nor saved to disk.

**Stop generating codes** hides the code and stops future refreshes. It does not
disconnect already linked phones or revoke a code that YouTube already issued.
The manually enabled YouTube session remains available until the plugin backend
stops, so linked phones can continue playing. Discovery changes preserve this
manual session; allow up to 15 seconds for the library to update its LAN discovery
interfaces after changing network trust.

TV-code entry is documented here for the YouTube app. YouTube Music's manual-link
UI varies by app/version; if it does not offer TV-code entry, use YouTube for this
flow or use automatic discovery for YouTube Music.

## Known Limitations

- **Queue is read-only** — The queue is managed by the YouTube app on your phone. You can view it in the Queue tab, but adding/removing tracks must be done from the phone. Tapping a queue item will attempt to jump to it.
- **Audio only** — Video content plays audio only. The plugin does not render video.
- **yt-dlp dependency** — Audio extraction relies on yt-dlp. If YouTube changes its anti-bot measures, playback may break until yt-dlp is updated. The plugin attempts to self-update yt-dlp on each load.

## Updating

To update the plugin, you must **uninstall the existing version first**, then install the new ZIP. Installing over an existing installation does not work because the running Node.js backend process holds the port and cannot be replaced in-place.

1. Open Decky settings
2. Uninstall "YouTube Cast Receiver"
3. Install the new ZIP via developer options

## Building from Source

Requires: Node.js 20+, pnpm, and `tar` (included with macOS, most Linux
distributions, and Windows 10/11). PowerShell is optional.

```sh
# Install dependencies
pnpm install --frozen-lockfile

# Build frontend + backend
pnpm run build
pnpm run build:backend

# Run tests
pnpm test

# Install locked dependencies, build both bundles, and package Linux x64 binaries
pnpm run package
```

The output `youtube-cast-receiver.zip` can be installed on the Steam Deck via Decky's developer install option.

Packaging works on macOS, Windows, and Linux, including ARM hosts. It always
targets Steam Deck's Linux x86_64 runtime: Node v20.18.3 and the standalone
`yt-dlp_linux` release asset. Downloads are checked against upstream SHA-256 sums
and cached in `bin/`. ZIP entries retain Unix executable permissions for both
binaries. `build.ps1` remains an optional wrapper for existing Windows workflows.
Tests are run separately; `pnpm run package --skip-build` packages existing build
artifacts without installing dependencies or rebuilding.

For the build/test loop, cross-platform development packaging, configurable SSH
deployment, Decky logs, backend/advertising checks, and Steam CEF DevTools, see
[the development workflow](docs/DEVELOPMENT.md).

## Architecture

- **Frontend**: React/TypeScript using Decky SDK (`@decky/ui`, `@decky/api`)
- **Backend**: Node.js with [yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver) for the cast protocol, [yt-dlp](https://github.com/yt-dlp/yt-dlp) for audio URL extraction
- **Communication**: HTTP REST for commands, WebSocket for real-time state sync
- **Process management**: Python `main.py` shim spawns the Node.js backend as a subprocess

## License

BSD-3-Clause
