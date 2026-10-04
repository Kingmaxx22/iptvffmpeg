//! Standalone media server (no Tauri).
//!
//! Used two ways:
//!   * `npm run dev:server` — runs the UI in a plain browser via the Vite proxy,
//!     which is how the playback pipeline is verified with Playwright.
//!   * debugging the relay by hand, e.g.
//!     `curl -N http://127.0.0.1:8787/stream/<sessionId>`.

use fluent_iptv_lib::ffmpeg::TranscodeConfig;
use fluent_iptv_lib::media_server;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let mut port: Option<u16> = Some(8787);
    let mut ffmpeg: Option<String> = None;
    let mut playlist: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                port = args.get(i).and_then(|v| v.parse().ok());
            }
            "--ffmpeg" => {
                i += 1;
                ffmpeg = args.get(i).cloned();
            }
            "--playlist" => {
                i += 1;
                playlist = args.get(i).cloned();
            }
            "-h" | "--help" => {
                println!("usage: media-server [--port N] [--ffmpeg PATH] [--playlist URL]");
                return;
            }
            other => eprintln!("ignoring unknown argument: {other}"),
        }
        i += 1;
    }

    let cfg = TranscodeConfig::default();
    match media_server::serve(port, ffmpeg, playlist, cfg).await {
        Ok((addr, state)) => {
            eprintln!("[media-server] listening on http://{addr}");
            eprintln!("[media-server] ffmpeg: {}", state.ffmpeg.display());
            eprintln!("[media-server] playlist: {}", state.playlist_url);
        }
        Err(e) => {
            eprintln!("[media-server] failed to start: {e}");
            std::process::exit(1);
        }
    }

    // Park forever; the server runs on its own task.
    futures_util::future::pending::<()>().await;
}