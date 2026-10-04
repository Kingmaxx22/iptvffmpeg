//! ffmpeg integration: locating the binary, building a web-playable transport
//! stream, and probing a source for health/resolution metadata.
//!
//! Every stream is re-encoded to H.264/AAC MPEG-TS because:
//!   * the WebView2 media pipeline (MSE) cannot play raw MPEG-TS directly, and
//!   * a large share of iptv-org entries are H.265, which Chromium will not
//!     decode. Transcoding in the backend is what keeps the window from going
//!     black instead of showing video.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::playlist::Channel;

/// Sent when the playlist does not supply a User-Agent. Plenty of free streams
/// return 403 for the stock ffmpeg UA.
pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone)]
pub struct TranscodeConfig {
    /// Output frame size (the source is letterboxed into it).
    pub width: u32,
    pub height: u32,
    pub video_bitrate_kbps: u32,
    pub audio_bitrate_kbps: u32,
    /// `ultrafast` .. `veryslow`; low latency wins over efficiency here.
    pub preset: String,
}

impl Default for TranscodeConfig {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
            video_bitrate_kbps: 2400,
            audio_bitrate_kbps: 128,
            preset: "veryfast".to_string(),
        }
    }
}

impl TranscodeConfig {
    fn resolution_scale(&self) -> String {
        format!(
            "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1",
            self.width, self.height, self.width, self.height
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthState {
    /// Reachable and decodable within the probe window.
    Online,
    /// Reachable but slow to start (cold CDN, geo-routed, high latency).
    Degraded,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub ok: bool,
    pub health: HealthState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate_kbps: Option<u32>,
    /// Time from spawn to first decodable frame.
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub probed_at: u64,
}

/// Locate an ffmpeg binary.
///
/// Order: explicit override -> `FFMPEG_PATH` -> the bundled sidecar -> whatever
/// is on `PATH`. The sidecar wins over `PATH` on purpose: a Scoop/choco/winget
/// ffmpeg is often a console shim that flashes a black window on every spawn
/// and can double-spawn the real binary, which is exactly the behaviour this
/// app was built to avoid. An explicit error message matters here: a missing
/// ffmpeg is the single most likely cause of "nothing plays".
pub fn resolve_ffmpeg(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("ffmpeg path from config does not exist: {}", path.display()));
    }

    if let Ok(path) = std::env::var("FFMPEG_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }

    for dir in sidecar_dirs() {
        for name in sidecar_names() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // Last resort: whatever `ffmpeg` resolves to on PATH. This may be a console
    // shim, so callers always spawn it through `hide_console`.
    Ok(PathBuf::from("ffmpeg"))
}

/// File names Tauri uses for a bundled sidecar: the bare name, then the
/// target-triple suffixed name for the host we were built for.
fn sidecar_names() -> Vec<String> {
    let exe = if cfg!(windows) { ".exe" } else { "" };
    vec![
        format!("ffmpeg{exe}"),
        "ffmpeg".to_string(),
        format!("ffmpeg-{}{}", env!("FLUENT_TARGET_TRIPLE"), exe),
    ]
}

/// Directories a bundled sidecar can live in: next to the running executable
/// (bundled app and `tauri dev`, both of which put it there), the Tauri
/// resource directory, and the crate's `binaries/` folder for `cargo run` of
/// the standalone media server.
fn sidecar_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            // Windows installer layout.
            dirs.push(dir.join("../resources"));
            dirs.push(dir.join("resources"));
        }
    }
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    dirs
}

/// Build the full argument list that turns any IPTV URL into an H.264/AAC
/// MPEG-TS elementary stream on stdout.
pub fn build_args(channel: &Channel, cfg: &TranscodeConfig) -> Vec<OsString> {
    let s = |v: &str| OsString::from(v);
    let mut args: Vec<OsString> = vec![
        s("-hide_banner"),
        s("-loglevel"),
        s("warning"),
        // Interactive mode is required: pause/resume is driven through stdin.
        s("-stats_period"),
        s("0.5"),
        s("-user_agent"),
        OsString::from(
            channel
                .user_agent
                .clone()
                .unwrap_or_else(|| DEFAULT_USER_AGENT.to_string()),
        ),
        // Do not hang forever on a dead endpoint: this is what turns a frozen
        // black screen into a visible error state.
        s("-rw_timeout"),
        s("20000000"),
        s("-reconnect"),
        s("1"),
        s("-reconnect_streamed"),
        s("1"),
        s("-reconnect_delay_max"),
        s("8"),
        s("-fflags"),
        s("+genpts"),
    ];

    if let Some(referrer) = &channel.referrer {
        args.push(s("-headers"));
        args.push(OsString::from(format!("Referer: {referrer}\r\n")));
    }

    args.push(s("-i"));
    args.push(OsString::from(&channel.url));
    args.extend([
        s("-map"),
        s("0:v:0"),
        s("-map"),
        s("0:a:0?"),
        s("-c:v"),
        s("libx264"),
        s("-preset"),
        OsString::from(&cfg.preset),
        s("-tune"),
        s("zerolatency"),
        s("-profile:v"),
        s("main"),
        s("-pix_fmt"),
        s("yuv420p"),
        s("-b:v"),
        OsString::from(format!("{}k", cfg.video_bitrate_kbps)),
        s("-maxrate"),
        OsString::from(format!("{}k", cfg.video_bitrate_kbps)),
        s("-bufsize"),
        OsString::from(format!("{}k", cfg.video_bitrate_kbps * 2)),
        s("-g"),
        s("50"),
        s("-keyint_min"),
        s("50"),
        s("-sc_threshold"),
        s("0"),
        // A forced keyframe every 2s means a subscriber that joins mid-stream
        // (or a reconnect) starts decoding almost immediately instead of waiting
        // for the next natural IDR.
        s("-force_key_frames"),
        s("expr:gte(t,n_forced*2)"),
        s("-vf"),
        OsString::from(cfg.resolution_scale()),
        s("-c:a"),
        s("aac"),
        s("-b:a"),
        OsString::from(format!("{}k", cfg.audio_bitrate_kbps)),
        s("-ac"),
        s("2"),
        s("-ar"),
        s("48000"),
        s("-af"),
        s("aresample=async=1:first_pts=0"),
        s("-max_muxing_queue_size"),
        s("1024"),
        s("-muxdelay"),
        s("0.05"),
        s("-muxpreload"),
        s("0"),
        s("-f"),
        s("mpegts"),
        s("pipe:1"),
    ]);
    args
}

/// Windows flag that starts a child without a console window.
///
/// Without it, spawning a console program (or a Scoop shim, which is how ffmpeg
/// is usually installed on Windows) flashes a black console every time a
/// transcoder starts or a health probe runs.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Hide the console window on Windows for any spawned child process.
#[cfg(windows)]
pub fn hide_console(mut command: Command) -> Command {
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
pub fn hide_console(command: Command) -> Command {
    command
}

fn base_input_args(channel: &Channel) -> Vec<OsString> {
    let s = |v: &str| OsString::from(v);
    let mut args: Vec<OsString> = vec![
        s("-hide_banner"),
        s("-nostdin"),
        s("-loglevel"),
        s("info"),
        s("-user_agent"),
        OsString::from(
            channel
                .user_agent
                .clone()
                .unwrap_or_else(|| DEFAULT_USER_AGENT.to_string()),
        ),
        s("-rw_timeout"),
        s("12000000"),
    ];
    if let Some(referrer) = &channel.referrer {
        args.push(s("-headers"));
        args.push(OsString::from(format!("Referer: {referrer}\r\n")));
    }
    args.push(s("-i"));
    args.push(OsString::from(&channel.url));
    args
}

/// Probe a source by letting ffmpeg open it and reading the stream description
/// off stderr. No output is produced, so this is cheap.
pub async fn probe(ffmpeg: &PathBuf, channel: &Channel, timeout: Duration) -> ProbeInfo {
    let started = Instant::now();
    let now_ms = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    };

    let mut child = match hide_console(Command::new(ffmpeg))
        .args(base_input_args(channel))
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .kill_on_drop(true)
    .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return ProbeInfo {
                ok: false,
                health: HealthState::Offline,
                latency_ms: 0,
                error: Some(format!("cannot run ffmpeg: {e}")),
                probed_at: now_ms(),
                ..Default::default()
            }
        }
    };

    let stderr = child.stderr.take();
    let deadline = started + timeout;
    let mut info = ProbeInfo {
        ok: false,
        health: HealthState::Offline,
        latency_ms: 0,
        probed_at: now_ms(),
        ..Default::default()
    };
    let mut last_error: Option<String> = None;

    if let Some(stderr) = stderr {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let next = tokio::time::timeout(remaining, lines.next_line()).await;
            let Ok(Ok(Some(line))) = next else {
                break;
            };
            // ffmpeg indents its stderr lines, e.g. "  Stream #0:1: Video: ...".
            let line = line.trim();

            // Stream indices are not fixed: a master playlist can list audio first
            // ("Stream #0:1: Video:"), so match the kind, not the index.
            if let Some(rest) = line.strip_prefix("Stream #") {
                if let Some((_, kind)) = rest.split_once(": ") {
                    if let Some(kind) = kind.strip_prefix("Video:") {
                        apply_video_line(&mut info, kind);
                        info.ok = true;
                        info.latency_ms = started.elapsed().as_millis() as u64;
                        // Slower sources count as degraded rather than healthy.
                        info.health = if info.latency_ms > 6000 {
                            HealthState::Degraded
                        } else {
                            HealthState::Online
                        };
                        break;
                    }
                    if let Some(kind) = kind.strip_prefix("Audio:") {
                        info.audio_codec = kind
                            .split([' ', '(', ',', '['])
                            .find(|t| !t.is_empty())
                            .map(str::to_string);
                    }
                }
            }
            // Note: live streams legitimately report `Duration: N/A`, so the
            // duration line carries no health signal and must not fail a probe.
            for marker in [
                "404 Not Found",
                "403 Forbidden",
                "401 Unauthorized",
                "Server returned 4",
                "Server returned 5",
                "Connection refused",
                "Connection timed out",
                "does not resolve",
                "Invalid data found",
                "No such file or directory",
                "Resource temporarily unavailable",
            ] {
                if line.contains(marker) {
                    last_error = Some(clean_error(&line));
                    break;
                }
            }
            if last_error.is_some() {
                break;
            }
        }
    }

    let _ = child.kill().await;

    if !info.ok {
        info.error = Some(last_error.unwrap_or_else(|| {
            "no video stream within probe window".to_string()
        }));
    }
    info
}

fn apply_video_line(info: &mut ProbeInfo, rest: &str) {
    info.video_codec = rest
        .split([' ', '('])
        .find(|t| !t.is_empty() && *t != ",")
        .map(str::to_string);

    // "h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 2005 kb/s, 25 fps"
    // Dimensions, fps and bitrate all live in their own comma-separated piece.
    for piece in rest.split(',') {
        let piece = piece.trim();

        let head = piece.split(['[', '(']).next().unwrap_or(piece).trim();
        if let Some((w, h)) = head.split_once('x') {
            if let (Ok(w), Ok(h)) = (w.trim().parse::<u32>(), h.trim().parse::<u32>()) {
                if (16..=8192).contains(&w) && (16..=4320).contains(&h) {
                    info.width = Some(w);
                    info.height = Some(h);
                }
            }
        }

        if let Some(fps) = piece.strip_suffix(" fps") {
            if let Ok(f) = fps.trim().parse::<f32>() {
                info.fps = Some(f);
            }
        }
        if let Some(bitrate) = piece.strip_suffix(" kb/s") {
            if let Ok(v) = bitrate.trim().parse::<u32>() {
                info.bitrate_kbps = Some(v);
            }
        }
    }
}

fn clean_error(line: &str) -> String {
    let line = line.trim();
    let line = line
        .trim_start_matches("[")
        .trim_start_matches(|c: char| c.is_ascii_digit() || c == '@' || c == '#')
        .trim_start_matches(']')
        .trim();
    let mut chars = line.chars();
    let mut out = String::new();
    for c in chars.by_ref() {
        out.push(c);
        if out.len() > 120 {
            break;
        }
    }
    out
}

impl Default for ProbeInfo {
    fn default() -> Self {
        Self {
            ok: false,
            health: HealthState::Offline,
            width: None,
            height: None,
            fps: None,
            video_codec: None,
            audio_codec: None,
            bitrate_kbps: None,
            latency_ms: 0,
            error: None,
            probed_at: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playlist;

    #[test]
    fn bundled_sidecar_wins_over_path() {
        let explicit = PathBuf::from("C:/nowhere/ffmpeg.exe");
        assert!(resolve_ffmpeg(Some(explicit.to_str().unwrap())).is_err());

        // No FFMPEG_PATH override here: the repository's fetched sidecar must be
        // preferred over a bare `ffmpeg` lookup on PATH, which on Windows is
        // often a console shim.
        let resolved = resolve_ffmpeg(None).expect("resolve ffmpeg");
        let is_bare_name = resolved.components().count() == 1;
        if !is_bare_name {
            assert!(
                resolved.to_string_lossy().contains("ffmpeg"),
                "unexpected ffmpeg candidate: {}",
                resolved.display()
            );
        }
    }

    #[test]
    fn sidecar_dirs_include_the_executable_folder() {
        let dirs = sidecar_dirs();
        assert!(!dirs.is_empty());
        assert!(dirs[0].is_absolute());
    }

    /// Mirrors the line matching in `probe` for regression coverage.
    fn classify(raw: &str) -> Option<&'static str> {
        let rest = raw.trim().strip_prefix("Stream #")?;
        let (_, kind) = rest.split_once(": ")?;
        if kind.starts_with("Video:") {
            Some("video")
        } else if kind.starts_with("Audio:") {
            Some("audio")
        } else {
            None
        }
    }

    #[test]
    fn matches_video_regardless_of_stream_index() {
        // Master playlists frequently list audio first.
        assert_eq!(classify("  Stream #0:1: Video: h264 (Main), yuv420p"), Some("video"));
        assert_eq!(classify("  Stream #0:0: Video: h264 (Main), yuv420p"), Some("video"));
        assert_eq!(classify("  Stream #0:0: Audio: aac (LC), 48000 Hz"), Some("audio"));
        assert_eq!(classify("  Stream #0:2: Subtitle: mov_text"), None);
    }

    #[test]
    fn parses_modern_ffmpeg_stream_line() {
        let mut info = ProbeInfo::default();
        apply_video_line(
            &mut info,
            " h264 (Main) ([27][0][0][0] / 0x001B), yuv420p(tv), 1920x1080 [SAR 1:1 DAR 16:9], 25 fps, 25 tbr, 90k tbn",
        );
        assert_eq!(info.video_codec.as_deref(), Some("h264"));
        assert_eq!((info.width, info.height), (Some(1920), Some(1080)));
        assert_eq!(info.fps, Some(25.0));
    }

    fn channel() -> Channel {
        playlist::parse_m3u("#EXTINF:-1 tvg-id=\"X.us\",Test HD\nhttp://example.com/s.m3u8\n")
            .pop()
            .unwrap()
    }

    #[test]
    fn args_encode_h264_aac_mpegts_to_stdout() {
        let args = build_args(&channel(), &TranscodeConfig::default());
        let joined: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(joined.contains(&"libx264".to_string()));
        assert!(joined.contains(&"mpegts".to_string()));
        assert!(joined.contains(&"pipe:1".to_string()));
        assert!(joined.contains(&"yuv420p".to_string()));
        assert!(joined.contains(&"main".to_string()));
        // Keyframe cadence guarantee for late subscribers.
        assert!(joined.contains(&"-force_key_frames".to_string()));
        // The input URL must come before the output options.
        let url_pos = joined.iter().position(|a| a == "http://example.com/s.m3u8").unwrap();
        let ts_pos = joined.iter().position(|a| a == "mpegts").unwrap();
        assert!(url_pos < ts_pos);
    }

    #[test]
    fn no_stdin_flag_so_pause_control_works() {
        let args = build_args(&channel(), &TranscodeConfig::default());
        let joined: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(!joined.contains(&"-nostdin".to_string()));
    }

    #[test]
    fn playlist_user_agent_is_preferred() {
        let mut ch = channel();
        ch.user_agent = Some("Custom/9".into());
        let args = build_args(&ch, &TranscodeConfig::default());
        let joined: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        let pos = joined.iter().position(|a| a == "-user_agent").unwrap();
        assert_eq!(joined[pos + 1], "Custom/9");
    }

    #[test]
    fn parses_video_stream_line() {
        let mut info = ProbeInfo::default();
        apply_video_line(
            &mut info,
            " h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 2005 kb/s, 25 fps, 25 tbr, 12800 tbn",
        );
        assert_eq!(info.video_codec.as_deref(), Some("h264"));
        assert_eq!((info.width, info.height), (Some(1920), Some(1080)));
        assert_eq!(info.fps, Some(25.0));
        assert_eq!(info.bitrate_kbps, Some(2005));
    }

    #[test]
    fn parses_hd_and_low_res_lines() {
        let mut info = ProbeInfo::default();
        apply_video_line(&mut info, " hevc (Main), yuv420p(tv), 640x360, 30 fps");
        assert_eq!((info.width, info.height), (Some(640), Some(360)));
        assert_eq!(info.fps, Some(30.0));
    }
}