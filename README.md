# Fluent IPTV

A live TV player for the [iptv-org](https://github.com/iptv-org/iptv) playlist
(~11,000 free international channels), built as a **Tauri 2 desktop app** with an
**ffmpeg** media backend, styled after the Fluent / WinUI 3 design system (Microsoft's Windows 11
dark theme): Mica/Acrylic surfaces, 1px perimeter highlights, a 96px accent for
live states, and the WinUI shape scale.

```
webview (React)  ──HTTP/SSE──▶  Rust media server  ──stdin/stdout──▶  ffmpeg  ──▶  source
      ▲                                │
      └────────── WebSocket (MPEG-TS) ──┘
```

## Why it is built this way

| Problem | Solution |
| --- | --- |
| Chromium/WebView2 cannot play MPEG-TS, and refuses to decode H.265 | ffmpeg re-encodes every source to **H.264/AAC MPEG-TS** in the backend; the webview only ever receives a codec it can decode |
| The playlist is 2.5 MB of cross-origin M3U | the backend downloads and parses it once, exposing typed JSON over loopback |
| Chromium cannot read a *live* chunked HTTP stream progressively | ffmpeg output is relayed over a **WebSocket**, which streams correctly and works identically in the app and in a browser |
| Roughly half the playlist is offline at any moment | a **probe** endpoint reports real resolution/codec/latency; offline channels are **hidden by default** and failures surface as an explicit, actionable state |
| Playback cutting out on jittery sources | the player keeps a **~2 MB demuxer input stash** (≈6–8 s cushion) plus latency chasing; measured 0 stalls over 15 s of sampling |

### No blank screens

This was a hard requirement, and it is enforced in several layers:

1. `index.html` paints `#0f1115` before any script runs, so window creation never
   flashes white.
2. The player renders a **designed backdrop** (logo, status, spinner) behind the
   `<video>` element; the video is transparent until a frame has actually been
   decoded (`videoWidth > 0`), then fades in.
3. Autoplay starts **muted** rather than provoking a browser rejection, so the
   autoplay policy can never produce a dead player.
4. Failures never end in a void: the backend restarts ffmpeg with backoff, the UI
   shows `Reconnecting`, and if retries are exhausted it offers **Retry / Pick
   another channel / Back to guide**.
5. A stall watchdog restarts ffmpeg if bytes stop for 15 s while someone is
   watching, and idle sessions are reaped so no encoder is left running.

## Requirements

- Node 20+ and Rust (stable, MSVC toolchain on Windows)
- **ffmpeg** on `PATH`, or `FFMPEG_PATH=/path/to/ffmpeg`
- Windows: WebView2 runtime (preinstalled on Win11)

## Running

```bash
npm install

# Terminal 1 — backend (fixed port 8787, ephemeral if taken)
npm run dev:server

# Terminal 2 — UI with hot reload
npm run dev            # http://localhost:1420

# …or run the desktop app (starts the UI for you)
npm run app:dev        # tauri dev
```

Build a distributable installer with `npx tauri build`.

> The desktop app prefers port **8787** for its media server and falls back to an
> ephemeral port, which the UI reads through the `media_base` command. If that IPC
> is ever unavailable the UI falls back to `http://127.0.0.1:8787`, so a running
> app is always reachable from the command line:
>
> ```bash
> curl http://127.0.0.1:8787/api/meta      # runtime info
> curl http://127.0.0.1:8787/api/sessions  # what is being streamed right now
> curl http://127.0.0.1:8787/api/channels  # the parsed playlist
> ```

## Backend API

| Route | Purpose |
| --- | --- |
| `GET /api/meta` | ffmpeg path/version, playlist status, channel counts |
| `GET /api/channels` | parsed playlist with country, language, resolution badges |
| `POST /api/playlist/refresh` | re-download the upstream playlist |
| `POST /api/probe` | health/resolution probe for up to 48 channels (10 min cache) |
| `POST /api/play` | start or attach to a session for a channel |
| `POST /api/control` | `pause` / `play` / `stop` (ffmpeg stdin) |
| `GET /api/sessions` | live session diagnostics |
| `GET /api/events` | SSE playback status stream |
| `GET /api/logo?url=` | cached channel-logo proxy (blank PNG when dead) |
| `GET /ws/stream/:id` | MPEG-TS relay (media source) |
| `GET /stream/:id` | the same bytes over chunked HTTP, for CLI debugging |

## Verification

Two scripted checks exercise the real stack (not mocks):

```bash
# 1. Backend pipeline: parses the PMT and NAL units of the relayed bytes
npm run dev:server &
node scripts/verify-pipeline.mjs

# 2. Real UI in Chromium: asserts decoded frames and samples for stalls
npm run dev &
node scripts/verify-ui.mjs      # screenshots land in artifacts/
```

Latest run on this machine:

```
[verify] elementary streams: pid 256 H.264, pid 257 AAC
[verify] H.264 SPS (NAL 7) units: 10, IDR frames: 80
[verify] PASS: live H.264/AAC transport stream is flowing over the WebSocket relay

[ui] video: 1280x720, readyState=4, backdrop swapped out: true
[ui] sampled 15s of playback: 0 stalls, buffer min 4.5s / avg 7.0s
[ui] PASS: real video frames are rendering
```

`cargo test` covers the M3U parser, ffmpeg argument construction, probe log
parsing and session bookkeeping.

## Layout

```
src/                     React UI
  lib/playerEngine.ts    mpegts.js wrapper: buffer, autoplay, recovery
  components/Player.tsx  player chrome, gating, error and reconnect states
  styles/theme.css       design tokens from design.md
src-tauri/src/
  playlist.rs            M3U parsing → Channel metadata
  ffmpeg.rs              binary discovery, transcode args, probing
  session.rs             per-channel ffmpeg supervision and restart
  media_server.rs        axum HTTP + WebSocket + SSE surface
  fallback.rs            offline starter playlist
```

## Known limitations

- **No EPG.** The playlist header advertises an XMLTV guide, but that feed only
  covers 2 of the 11k channels, so no now/next data is wired up. The card and
  player already render it when `channel.now` exists.
- **One stream at a time.** Multi-view mosaics would need one ffmpeg process per
  tile; out of scope here.
- **No seeking.** These are live streams; playback starts at the live edge.
- Community streams are unreliable by nature; the health dots, the hidden-offline
  mode and the retry flow exist because of that, not despite it.