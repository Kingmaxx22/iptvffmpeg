//! Local media server: the single surface the UI talks to.
//!
//! Routes (all bound to 127.0.0.1 on an ephemeral port):
//!   GET  /api/meta            runtime info (ffmpeg path/version, port, counts)
//!   GET  /api/channels        parsed playlist
//!   POST /api/playlist/refresh re-download the playlist
//!   POST /api/probe           health/resolution probe for a set of channel ids
//!   POST /api/play            start (or attach to) a session for a channel
//!   POST /api/control         pause / play / stop a session
//!   GET  /api/events          SSE: playback status notifications
//!   GET  /ws/stream/:id       MPEG-TS relay over WebSocket (MSE source)
//!   GET  /stream/:id          same bytes over chunked HTTP (debug/CLI use)
//!
//! Going through HTTP/WS instead of Tauri IPC keeps the media path identical
//! inside the app and in a plain browser, which is what makes the pipeline
//! testable end to end.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use futures_util::stream::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Semaphore};
use tokio_stream::wrappers::BroadcastStream;
use tower_http::cors::CorsLayer;

use crate::fallback::FALLBACK_M3U;
use crate::ffmpeg::{self, ProbeInfo, TranscodeConfig};
use crate::playlist::{self, Channel};
use crate::session::{Session, SessionManager, SessionSnapshot};

const PROBE_TTL: Duration = Duration::from_secs(600);
/// Probing spawns a real ffmpeg per channel, so it is deliberately cheap:
/// a short window, few at a time, and a hard cap on the batch.
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_PROBE_BATCH: usize = 24;
const PROBE_CONCURRENCY: usize = 3;
/// Logo cache: bounded so a long session cannot grow without limit.
const LOGO_CACHE_MAX: usize = 512;
const LOGO_TIMEOUT: Duration = Duration::from_secs(6);
const LOGO_MAX_BYTES: usize = 2 * 1024 * 1024;

/// 1x1 transparent PNG: returned when a logo URL is dead, so the page never
/// logs a network error and the UI can fall back to its monogram.
const BLANK_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

pub struct PlaylistCache {
    pub status: &'static str,
    pub message: Option<String>,
    pub channels: Vec<Channel>,
    pub index: HashMap<String, usize>,
    pub fetched_at: Option<u64>,
    pub source: String,
}

pub struct AppState {
    pub ffmpeg: PathBuf,
    pub ffmpeg_version: Mutex<Option<String>>,
    pub playlist_url: String,
    pub playlist: Mutex<PlaylistCache>,
    pub sessions: Arc<SessionManager>,
    probes: Mutex<HashMap<String, (ProbeInfo, Instant)>>,
    logos: Mutex<HashMap<String, (Vec<u8>, &'static str)>>,
    logo_client: reqwest::Client,
    pub port: AtomicU64,
    started_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl AppState {
    fn channel_by_id(&self, id: &str) -> Option<Channel> {
        let playlist = self.playlist.lock();
        playlist
            .index
            .get(id)
            .and_then(|i| playlist.channels.get(*i))
            .cloned()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetaResponse {
    version: &'static str,
    port: u16,
    ffmpeg_path: String,
    ffmpeg_version: Option<String>,
    ffmpeg_ok: bool,
    playlist_url: String,
    playlist_status: &'static str,
    playlist_message: Option<String>,
    channel_count: usize,
    featured_count: usize,
    started_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelsResponse {
    status: &'static str,
    message: Option<String>,
    total: usize,
    fetched_at: Option<u64>,
    source: String,
    channels: Vec<Channel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeRequest {
    ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResponse {
    results: HashMap<String, ProbeInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlayRequest {
    channel_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayResponse {
    session_id: String,
    channel_id: String,
    channel_name: String,
    ws_path: String,
    http_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlRequest {
    session_id: String,
    action: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientLog {
    level: String,
    message: String,
}

/// Probe a batch of channels concurrently, caching recent results.
async fn probe_batch(state: &Arc<AppState>, ids: Vec<String>) -> HashMap<String, ProbeInfo> {
    let semaphore = Arc::new(Semaphore::new(PROBE_CONCURRENCY));
    let jobs: Vec<(String, Channel)> = ids
        .into_iter()
        .take(MAX_PROBE_BATCH)
        .filter_map(|id| state.channel_by_id(&id).map(|channel| (id, channel)))
        .collect();

    let futures = jobs.into_iter().map(|(id, channel)| {
        let state = state.clone();
        let semaphore = semaphore.clone();
        async move {
            let _permit = semaphore.acquire_owned().await;

            let cached = {
                let probes = state.probes.lock();
                probes
                    .get(&id)
                    .filter(|(_, at)| at.elapsed() < PROBE_TTL)
                    .map(|(info, _)| info.clone())
            };
            if let Some(info) = cached {
                return (id, info);
            }

            let info = ffmpeg::probe(&state.ffmpeg, &channel, PROBE_TIMEOUT).await;
            state.probes.lock().insert(id.clone(), (info.clone(), Instant::now()));
            (id, info)
        }
    });

    let results: Vec<(String, ProbeInfo)> = futures_util::stream::iter(futures)
        .buffer_unordered(PROBE_CONCURRENCY)
        .collect()
        .await;

    results.into_iter().collect()
}

/// Download + parse the upstream playlist, falling back to the bundled set.
pub async fn refresh_playlist(state: Arc<AppState>) {
    let outcome: Result<Vec<Channel>, String> = match reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(ffmpeg::DEFAULT_USER_AGENT)
        .build()
    {
        Ok(client) => match client.get(&state.playlist_url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.text().await {
                Ok(text) => {
                    let channels = playlist::parse_m3u(&text);
                    if channels.is_empty() {
                        Err("playlist was empty".to_string())
                    } else {
                        Ok(channels)
                    }
                }
                Err(e) => Err(format!("playlist download failed: {e}")),
            },
            Ok(resp) => Err(format!("playlist returned HTTP {}", resp.status())),
            Err(e) => Err(format!("playlist request failed: {e}")),
        },
        Err(e) => Err(format!("http client unavailable: {e}")),
    };

    let (channels, message) = match outcome {
        Ok(channels) => (channels, None),
        // Never leave the UI with an empty screen: fall back to the small set of
        // verified channels and say so loudly.
        Err(err) => (playlist::parse_m3u(FALLBACK_M3U), Some(err)),
    };

    let total = channels.len();
    let mut playlist = state.playlist.lock();
    playlist.status = if message.is_some() { "fallback" } else { "ready" };
    playlist.message = message;
    playlist.fetched_at = Some(now_ms());
    playlist.source = state.playlist_url.clone();
    playlist.index = channels
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id.clone(), i))
        .collect();
    playlist.channels = channels;
    drop(playlist);
    eprintln!("[media-server] playlist ready: {total} channels");
}

async fn check_ffmpeg(state: &Arc<AppState>) {
    use tokio::process::Command;

    let result = tokio::time::timeout(
        Duration::from_secs(8),
        crate::ffmpeg::hide_console(Command::new(&state.ffmpeg))
            .arg("-version")
            .stdin(Stdio::null())
            .output(),
    )
    .await;

    let version = match result {
        Ok(Ok(out)) if out.status.success() => Some(
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("ffmpeg")
                .trim()
                .to_string(),
        ),
        Ok(Ok(out)) => Some(format!("ffmpeg exited with {}", out.status)),
        Ok(Err(e)) => Some(format!("cannot execute ffmpeg: {e}")),
        Err(_) => Some("ffmpeg -version timed out".to_string()),
    };
    *state.ffmpeg_version.lock() = version;
}

/// Default loopback port for the media server.
///
/// Both the app shell and the standalone binary try this first so the port is
/// predictable and the UI can fall back to it without any IPC round trip. When
/// it is taken, an ephemeral port is used instead.
pub const DEFAULT_PORT: u16 = 8787;

/// Start the server and return the bound address.
///
/// `bind_port` is only used by the standalone binary (the Vite dev proxy needs a
/// known port); the Tauri shell passes `None`, which still prefers
/// [`DEFAULT_PORT`] before falling back to an ephemeral port.
pub async fn serve(
    bind_port: Option<u16>,
    ffmpeg_path: Option<String>,
    playlist_url: Option<String>,
    cfg: TranscodeConfig,
) -> Result<(SocketAddr, Arc<AppState>), String> {
    let ffmpeg = ffmpeg::resolve_ffmpeg(ffmpeg_path.as_deref())?;
    let sessions = Arc::new(SessionManager::new(ffmpeg.clone(), cfg));

    let state = Arc::new(AppState {
        ffmpeg,
        ffmpeg_version: Mutex::new(None),
        playlist_url: playlist_url.unwrap_or_else(|| playlist::DEFAULT_PLAYLIST_URL.to_string()),
        playlist: Mutex::new(PlaylistCache {
            status: "loading",
            message: None,
            channels: Vec::new(),
            index: HashMap::new(),
            fetched_at: None,
            source: String::new(),
        }),
        sessions,
        probes: Mutex::new(HashMap::new()),
        logos: Mutex::new(HashMap::new()),
        logo_client: reqwest::Client::builder()
            .timeout(LOGO_TIMEOUT)
            .user_agent(ffmpeg::DEFAULT_USER_AGENT)
            .build()
            .map_err(|e| format!("http client unavailable: {e}"))?,
        port: AtomicU64::new(0),
        started_at: now_ms(),
    });

    {
        let state = state.clone();
        tokio::spawn(async move { check_ffmpeg(&state).await });
    }
    {
        let state = state.clone();
        tokio::spawn(async move { refresh_playlist(state).await });
    }
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(10));
            loop {
                ticker.tick().await;
                state.sessions.reap_idle();
            }
        });
    }

    let app = router(state.clone());
    let preferred = bind_port.unwrap_or(DEFAULT_PORT);
    let listener = match TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, preferred))).await {
        Ok(listener) => listener,
        Err(_) if preferred != 0 => {
            // Port in use: fall back to an ephemeral one and let the UI discover
            // it over IPC.
            eprintln!("[media-server] port {preferred} busy, using an ephemeral port");
            TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
                .await
                .map_err(|e| format!("cannot bind loopback port: {e}"))?
        }
        Err(e) => return Err(format!("cannot bind port {preferred}: {e}")),
    };
    let local = listener.local_addr().map_err(|e| e.to_string())?;
    state.port.store(u64::from(local.port()), Ordering::Relaxed);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[media-server] stopped: {e}");
        }
    });

    Ok((local, state))
}

fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/meta", get(api_meta))
        .route("/api/channels", get(api_channels))
        .route("/api/playlist/refresh", post(api_refresh))
        .route("/api/probe", post(api_probe))
        .route("/api/play", post(api_play))
        .route("/api/control", post(api_control))
        .route("/api/sessions", get(api_sessions))
        .route("/api/client-log", post(api_client_log))
        .route("/api/logo", get(api_logo))
        .route("/api/events", get(api_events))
        .route("/ws/stream/{session_id}", get(ws_stream))
        .route("/stream/{session_id}", get(http_stream))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn api_meta(State(state): State<Arc<AppState>>) -> Json<MetaResponse> {
    let ffmpeg_version = state.ffmpeg_version.lock().clone();
    let (status, message, count, featured) = {
        let playlist = state.playlist.lock();
        (
            playlist.status,
            playlist.message.clone(),
            playlist.channels.len(),
            playlist.channels.iter().filter(|c| c.featured).count(),
        )
    };
    Json(MetaResponse {
        version: env!("CARGO_PKG_VERSION"),
        port: state.port.load(Ordering::Relaxed) as u16,
        ffmpeg_path: state.ffmpeg.display().to_string(),
        ffmpeg_ok: ffmpeg_version.is_some(),
        ffmpeg_version,
        playlist_url: state.playlist_url.clone(),
        playlist_status: status,
        playlist_message: message,
        channel_count: count,
        featured_count: featured,
        started_at: state.started_at,
    })
}

async fn api_channels(State(state): State<Arc<AppState>>) -> Json<ChannelsResponse> {
    let playlist = state.playlist.lock();
    Json(ChannelsResponse {
        status: playlist.status,
        message: playlist.message.clone(),
        total: playlist.channels.len(),
        fetched_at: playlist.fetched_at,
        source: playlist.source.clone(),
        channels: playlist.channels.clone(),
    })
}

async fn api_refresh(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    tokio::spawn(async move { refresh_playlist(state).await });
    (StatusCode::ACCEPTED, "refreshing")
}

async fn api_probe(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ProbeRequest>,
) -> Json<ProbeResponse> {
    Json(ProbeResponse {
        results: probe_batch(&state, req.ids).await,
    })
}

async fn api_play(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PlayRequest>,
) -> Result<Json<PlayResponse>, (StatusCode, String)> {
    let channel = state
        .channel_by_id(&req.channel_id)
        .ok_or((StatusCode::NOT_FOUND, "unknown channel".to_string()))?;

    let session = state
        .sessions
        .start(channel.clone())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(PlayResponse {
        session_id: session.id.clone(),
        channel_id: channel.id,
        channel_name: channel.name,
        ws_path: format!("/ws/stream/{}", session.id),
        http_path: format!("/stream/{}", session.id),
    }))
}

async fn api_control(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ControlRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let session = state
        .sessions
        .get(&req.session_id)
        .ok_or((StatusCode::NOT_FOUND, "unknown session".to_string()))?;

    match req.action.as_str() {
        "pause" => session.set_paused(true),
        "play" | "resume" => session.set_paused(false),
        "stop" => session.stop(),
        other => return Err((StatusCode::BAD_REQUEST, format!("unknown action: {other}"))),
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Channel logo proxy.
///
/// Roughly a fifth of the upstream logo URLs are dead and several hosts rate
/// limit hard, which floods the page with network errors. The backend fetches
/// them once, caches them, and answers with a 1x1 PNG when a logo is gone, so
/// the UI can show its monogram without a single console error.
async fn api_logo(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
) -> Response {
    let blank = || {
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "public, max-age=86400")
            .body(axum::body::Body::from(BLANK_PNG))
            .expect("valid blank png response")
    };

    let Some(url) = params.get("url") else {
        return blank();
    };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return blank();
    }

    if let Some((bytes, content_type)) = state.logos.lock().get(url) {
        let bytes = bytes.clone();
        let content_type = *content_type;
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "public, max-age=86400")
            .body(axum::body::Body::from(bytes))
            .expect("valid cached logo response");
    }

    let mut fetched: Option<(&'static str, bytes::Bytes)> = None;
    if let Ok(response) = state.logo_client.get(url).send().await {
        if response.status().is_success() {
            let content_type = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.starts_with("image/"))
                .map(|value| {
                    if value.starts_with("image/png") {
                        "image/png"
                    } else if value.starts_with("image/svg") {
                        "image/svg+xml"
                    } else {
                        "image/jpeg"
                    }
                });
            if let (Some(content_type), Ok(bytes)) = (content_type, response.bytes().await) {
                fetched = Some((content_type, bytes));
            }
        }
    }

    let Some((content_type, bytes)) = fetched else {
        // Cache the miss as a blank so a dead logo is only fetched once.
        state.logos.lock().insert(
            url.to_string(),
            (BLANK_PNG.to_vec(), "image/png"),
        );
        return blank();
    };

    if bytes.len() > LOGO_MAX_BYTES {
        state
            .logos
            .lock()
            .insert(url.to_string(), (BLANK_PNG.to_vec(), "image/png"));
        return blank();
    }

    let content_type: &'static str = content_type;
    let bytes = bytes.to_vec();
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(axum::body::Body::from(bytes.clone()))
        .expect("valid logo response");

    let mut cache = state.logos.lock();
    if cache.len() >= LOGO_CACHE_MAX {
        cache.clear();
    }
    cache.insert(url.to_string(), (bytes, content_type));

    response
}

/// Frontend diagnostics.
///
/// The packaged app has no devtools, so the UI reports startup and uncaught
/// errors here. This is what makes "the window is blank" diagnosable.
async fn api_client_log(Json(entry): Json<ClientLog>) -> StatusCode {
    eprintln!("[ui] {}: {}", entry.level, entry.message);
    StatusCode::NO_CONTENT
}

/// Diagnostics: what the app is currently feeding to a webview.
async fn api_sessions(State(state): State<Arc<AppState>>) -> Json<Vec<SessionSnapshot>> {
    Json(
        state
            .sessions
            .summaries()
            .iter()
            .map(|session| session.snapshot())
            .collect(),
    )
}

async fn api_events(
    State(state): State<Arc<AppState>>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, std::io::Error>>> {
    let stream = BroadcastStream::new(state.sessions.events()).filter_map(|item| async move {
        item.ok()
            .and_then(|event| serde_json::to_string(&event).ok())
            .map(|data| Ok(Event::default().event("status").data(data)))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn ws_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Response {
    let Some(session) = state.sessions.get(&session_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    ws.on_upgrade(move |socket| ws_relay(socket, session))
}

async fn ws_relay(mut socket: WebSocket, session: Arc<Session>) {
    let _detach = DetachOnDrop(session.clone());

    // Hand the new subscriber the tail of the stream so it lands on an IDR
    // keyframe quickly instead of waiting for the next forced one.
    let buffered = session.buffered();
    if !buffered.is_empty() && socket.send(Message::Binary(buffered)).await.is_err() {
        return;
    }

    let mut rx = session.subscribe();
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
            chunk = rx.recv() => match chunk {
                Ok(bytes) => {
                    if socket.send(Message::Binary(bytes)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!("[media-server] ws subscriber lagged {skipped} chunks, resyncing");
                    let resync = session.buffered();
                    if !resync.is_empty()
                        && socket.send(Message::Binary(resync)).await.is_err()
                    {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
    }
}

/// Keeps the subscriber count correct for the idle reaper.
struct DetachOnDrop(Arc<Session>);

impl Drop for DetachOnDrop {
    fn drop(&mut self) {
        self.0.subscriber_detach();
    }
}

async fn http_stream(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Response {
    let Some(session) = state.sessions.get(&session_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let _detach = DetachOnDrop(session.clone());

    let initial = session.buffered();
    let rx = session.subscribe();

    // `unfold` owns the guard in its state, so dropping the response body (i.e.
    // closing the tab) releases the subscriber slot.
    let live = futures_util::stream::unfold(
        (DetachOnDrop(session.clone()), rx),
        |(guard, mut rx)| async move {
            match rx.recv().await {
                Ok(bytes) => Some((Ok::<Bytes, std::io::Error>(bytes), (guard, rx))),
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    Some((Ok(guard.0.buffered()), (guard, rx)))
                }
                Err(broadcast::error::RecvError::Closed) => None,
            }
        },
    );

    let body = futures_util::stream::once(async move { Ok::<Bytes, std::io::Error>(initial) }).chain(live);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp2t")
        .header(header::CACHE_CONTROL, "no-store, no-cache, must-revalidate")
        .header("X-Accel-Buffering", "no")
        .body(axum::body::Body::from_stream(body))
        .expect("valid stream response")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with(channels: Vec<Channel>) -> AppState {
        let index = channels
            .iter()
            .enumerate()
            .map(|(i, c)| (c.id.clone(), i))
            .collect();
        AppState {
            ffmpeg: PathBuf::from("ffmpeg"),
            ffmpeg_version: Mutex::new(None),
            playlist_url: String::new(),
            playlist: Mutex::new(PlaylistCache {
                status: "ready",
                message: None,
                channels,
                index,
                fetched_at: None,
                source: String::new(),
            }),
            sessions: Arc::new(SessionManager::new(
                PathBuf::from("ffmpeg"),
                TranscodeConfig::default(),
            )),
            probes: Mutex::new(HashMap::new()),
            logos: Mutex::new(HashMap::new()),
            logo_client: reqwest::Client::new(),
            port: AtomicU64::new(0),
            started_at: 0,
        }
    }

    #[test]
    fn channel_lookup_works_by_id() {
        let channels = playlist::parse_m3u(
            "#EXTINF:-1 tvg-id=\"A.us\",Alpha\nhttp://a/1\n#EXTINF:-1 tvg-id=\"B.us\",Beta\nhttp://b/1\n",
        );
        let alpha_id = channels[0].id.clone();
        let beta_id = channels[1].id.clone();
        let state = state_with(channels);

        assert!(state.channel_by_id("missing").is_none());
        assert_eq!(state.channel_by_id(&alpha_id).unwrap().name, "Alpha");
        assert_eq!(state.channel_by_id(&beta_id).unwrap().name, "Beta");
    }

    #[tokio::test]
    async fn fallback_playlist_parses_into_channels() {
        let channels = playlist::parse_m3u(FALLBACK_M3U);
        assert!(channels.len() >= 10, "fallback should be populated");
        assert!(channels.iter().all(|c| c.url.starts_with("http")));
        assert!(channels.iter().any(|c| c.featured));
    }
}