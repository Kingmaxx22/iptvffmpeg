# Fluent IPTV 0.1.0

A live TV player for the [iptv-org](https://github.com/iptv-org/iptv) playlist (~11,000 free
international channels): a Tauri 2 desktop app with an ffmpeg media backend, styled after the
Fluent / WinUI 3 design system.

```
webview (React)  ──HTTP/SSE──▶  Rust media server  ──stdin/stdout──▶  ffmpeg  ──▶  source
      ▲                                │
      └────────── WebSocket (MPEG-TS) ──┘
```

Every source is re-encoded to **H.264/AAC MPEG-TS** in the backend, because WebView2 cannot play
MPEG-TS natively and refuses to decode the H.265 that many playlist entries use.

## Downloads

| Asset | Use |
| --- | --- |
| `FluentIPTV-0.1.0-portable.zip` | **Recommended.** Unzip anywhere and run `FluentIPTV.exe`. Nothing to install. |
| `FluentIPTV-0.1.0-x64-setup.exe` | NSIS installer. |

Both carry a bundled static **ffmpeg 9.0.2** (GPL-2.0-or-later; licence text in
`binaries/FFMPEG-LICENSE.txt`), so no ffmpeg install is required and no system ffmpeg is ever used.

**Requirements:** Windows 10 1809+ 64-bit and the Microsoft Edge **WebView2 Runtime**
(preinstalled on Windows 11). Windows 10 may need the Evergreen bootstrapper once.

## Diagnostics

The app runs a local media server on `127.0.0.1:8787` (or the next free port):

```bash
curl http://127.0.0.1:8787/api/meta       # ffmpeg path/version, playlist status
curl http://127.0.0.1:8787/api/sessions   # what is streaming right now, and any fatal error
```

---

## Known problems

### Source reliability (by far the biggest source of bad experiences)

1. **Roughly half the playlist is offline at any moment.** The upstream list is crowd-sourced and
   constantly changing. Probing the 24 featured channels on this machine typically returned 4
   online, 15 degraded, 5 offline.
2. **Some CDNs serve expired playlist tokens.** Amagi multi-variant masters in particular hand out
   variant URLs under a short-lived token; once it rolls over ffmpeg reports
   `parse_playlist error Invalid data found` and then
   `Error opening output files: Invalid argument`, producing zero bytes. No client-side fix
   exists — the source itself is dead. Reproduced on *Fox (United States) WJBK (720p/1080p)*.
3. **A cold or busy CDN can exceed the 6 s probe window**, so a channel may be reported
   `degraded` even though it plays fine. `degraded` means "not confirmed in time", not "broken".
4. **`Error number -138` / connection resets** are common on US affiliate streams and are genuinely
   upstream failures.

### Playback

5. **Stalls are possible on jittery sources.** A 15 s watchdog kills and restarts ffmpeg when bytes
   stop; the player's buffer drains during the restart (~2 MB stash, typically 6–15 s of cushion).
6. **Autoplay starts muted.** Browsers reject unmuted autoplay without a user gesture; a sound chip
   appears to unmute.
7. **No seeking.** These are live streams; playback starts at the live edge.
8. **One stream at a time.** Multi-view would need one ffmpeg per tile.

### Features not implemented

9. **No EPG.** The playlist advertises an XMLTV guide but it covers 2 of the 11k channels, so no
   now/next data is wired up.
10. **No favourites sync, no recording, no channel search beyond the text filter.**

### Packaging and platform

11. **The NSIS installer has not been validated by an actual silent install.** `webviewInstallMode`
    is `downloadBootstrapper`, and `/S` hung on the build machine. Interactive install is expected
    to work; bundle contents were verified by archive listing only.
12. **The installer and portable build are large** (~33 MiB and ~43 MiB zipped) because a static
    ffmpeg is bundled. A shared-library ffmpeg would shrink this but ships DLLs instead.
13. **Windows x64 only.** `resolve_ffmpeg` has non-Windows branches, but nothing else has been
    tested off Windows.
14. **GPL obligation.** ffmpeg is GPL-2.0-or-later; anyone redistributing the packaged app must
    keep the licence text (bundled) and the corresponding source offer intact.
15. **If port 8787 is taken, the app silently falls back to an ephemeral port.** Two instances can
    therefore coexist without an obvious warning. Single-instance locking prevents two *desktop*
    copies, but the standalone `media-server` binary has no such guard.

### Verification gaps

16. **The UI verification harness targets the vite dev server, not the packaged app.** Playback in
    the shipped binary was verified through its HTTP API (probe verdicts, session states, byte
    flow), not by driving the WebView of the installed build.
17. **No automated test drives the Tauri window.** `cargo test` covers the M3U parser, ffmpeg
    argument construction, probe classification, sidecar resolution and session bookkeeping;
    `verify-pipeline.mjs` and `verify-ui.mjs` cover the backend and browser respectively.

### Fixed in this release

18. A probe that merely **timed out was reported as `offline`** — the `degraded` branch was dead code
    (it required a latency above 6 s while the probe aborts at exactly 6 s), so slow CDNs were
    hidden by the default "hide offline" filter. A timeout is now `degraded`.
19. **Sessions gave up after ~7 s.** `MAX_RESTARTS` was 3 with `400 ms × attempt²` backoff. Now 6
    retries with gentler backoff (~40 s), so a token rollover can be ridden out.
20. **The guide could hide the channel you were watching.** It no longer does.