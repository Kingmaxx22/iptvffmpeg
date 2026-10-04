//! Fluent IPTV — Tauri shell.
//!
//! The webview is a pure UI. All media work (playlist fetch, ffmpeg transcoding,
//! transport-stream relay) happens in this process and is reached over a
//! loopback HTTP/WebSocket server so the exact same code path can be exercised
//! by a headless browser during development.

pub mod ffmpeg;
pub mod fallback;
pub mod media_server;
pub mod playlist;
pub mod session;

use std::sync::Arc;

use tauri::{Manager, WindowEvent};

use crate::ffmpeg::TranscodeConfig;
use crate::media_server::AppState;

/// Everything the frontend needs to talk to the backend.
pub struct Backend {
    pub base_url: String,
    pub state: Arc<AppState>,
}

/// Base URL of the loopback media server, e.g. `http://127.0.0.1:51234`.
#[tauri::command]
fn media_base(backend: tauri::State<'_, Backend>) -> String {
    backend.base_url.clone()
}

/// Toggle (or explicitly set) fullscreen for the main window.
#[tauri::command]
fn set_fullscreen(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

/// Player chrome is easier to use when the window stays above other windows.
#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch exits here, before setup
        // runs, so it can never start a second media server or a second
        // ffmpeg transcoder.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            media_base,
            set_fullscreen,
            set_always_on_top
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Binds an ephemeral loopback port and spawns background tasks:
            // fast enough to do inline here.
            let (addr, state) = tauri::async_runtime::block_on(media_server::serve(
                None,
                None,
                None,
                TranscodeConfig::default(),
            ))
            .map_err(std::io::Error::other)?;

            let base_url = format!("http://{addr}");
            handle.manage(Backend {
                base_url: base_url.clone(),
                state: state.clone(),
            });
            eprintln!("[fluent-iptv] media server on {base_url}");

            if let Some(window) = app.get_webview_window("main") {
                let cleanup = state.clone();
                window.on_window_event(move |event| {
                    // Never leave an encoder running after the window is gone.
                    if matches!(event, WindowEvent::Destroyed) {
                        cleanup.sessions.stop_all();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Fluent IPTV");
}