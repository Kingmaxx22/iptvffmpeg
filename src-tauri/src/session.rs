//! Per-channel ffmpeg process supervision.
//!
//! One `Session` == one ffmpeg process == one channel being watched. Session
//! output is fanned out over a `broadcast` channel and mirrored into a small
//! ring buffer so that a WebSocket subscriber which attaches mid-stream still
//! receives data (and therefore an IDR keyframe) immediately.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use bytes::{Buf, Bytes, BytesMut};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{broadcast, mpsc};

use crate::ffmpeg::{build_args, TranscodeConfig};
use crate::playlist::Channel;

const READ_CHUNK: usize = 64 * 1024;
/// Recent output kept so late subscribers do not start from nothing.
const RING_CAPACITY: usize = 2 * 1024 * 1024;
/// No bytes for this long while somebody is watching == stalled stream.
const STALL_TIMEOUT: Duration = Duration::from_secs(15);
/// Nobody watching and untouched for this long == shut ffmpeg down.
const IDLE_TIMEOUT: Duration = Duration::from_secs(45);
/// A dead endpoint must not respawn ffmpeg forever, but a live source whose
/// playlist token merely rolled over needs more than a couple of tries: the
/// three-retry budget expired in ~6 s and declared working channels dead while
/// the CDN was still re-arming. The backoff below keeps the total cost small.
const MAX_RESTARTS: u32 = 6;
const MAX_LOG_LINES: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackState {
    /// ffmpeg spawned, no media yet.
    Starting,
    /// Bytes are flowing but the webview has not decoded a frame yet.
    Buffering,
    Paused,
    /// Process died (or stalled) and is being respawned.
    Reconnecting,
    /// Unrecoverable for this channel; the UI offers retry/next.
    Error,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub session_id: String,
    pub channel_id: String,
    pub channel_name: String,
    pub state: PlaybackState,
    pub attempt: u32,
    pub bytes: u64,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub at: u64,
}

/// Read-only view of a session, used by the diagnostics endpoint.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: String,
    pub channel_id: String,
    pub channel_name: String,
    pub bytes: u64,
    pub subscribers: usize,
    pub paused: bool,
    pub wanted: bool,
    pub fatal: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Default)]
struct Ring {
    buf: BytesMut,
}

impl Ring {
    fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
        if self.buf.len() > RING_CAPACITY {
            let excess = self.buf.len() - RING_CAPACITY;
            self.buf.advance(excess);
        }
    }

    fn snapshot(&self) -> Bytes {
        Bytes::copy_from_slice(&self.buf)
    }

    fn clear(&mut self) {
        self.buf.clear();
    }
}

struct Inner {
    kill_tx: Option<mpsc::Sender<()>>,
    generation: u64,
    /// Bumped every time the user asks for a stop, so a pending restart is a no-op.
    wanted: bool,
    paused: bool,
    restarts: u32,
    subscribers: usize,
    bytes: u64,
    last_bytes_at: Option<Instant>,
    last_touch: Instant,
    started_at: Instant,
    generation_started_at: Instant,
    stderr_tail: Vec<String>,
    fatal: Option<String>,
}

pub struct Session {
    pub id: String,
    pub channel: Channel,
    ffmpeg: PathBuf,
    cfg: TranscodeConfig,
    media: broadcast::Sender<Bytes>,
    events: broadcast::Sender<StatusEvent>,
    inner: Mutex<Inner>,
    /// ffmpeg's interactive stdin, used for the pause/resume hotkey.
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    ring: Mutex<Ring>,
}

impl Session {
    fn new(
        channel: Channel,
        ffmpeg: PathBuf,
        cfg: TranscodeConfig,
        events: broadcast::Sender<StatusEvent>,
    ) -> Self {
        let (media, _) = broadcast::channel(96);
        Self {
            id: format!("s_{}", uuid::Uuid::new_v4().simple()),
            channel,
            ffmpeg,
            cfg,
            media,
            events,
            inner: Mutex::new(Inner {
                kill_tx: None,
                generation: 0,
                wanted: true,
                paused: false,
                restarts: 0,
                subscribers: 0,
                bytes: 0,
                last_bytes_at: None,
                last_touch: Instant::now(),
                started_at: Instant::now(),
                generation_started_at: Instant::now(),
                stderr_tail: Vec::new(),
                fatal: None,
            }),
            ring: Mutex::new(Ring::default()),
            stdin: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    fn emit(&self, state: PlaybackState, message: Option<String>) {
        let (attempt, bytes) = {
            let inner = self.inner.lock();
            (inner.restarts, inner.bytes)
        };
        let _ = self.events.send(StatusEvent {
            session_id: self.id.clone(),
            channel_id: self.channel.id.clone(),
            channel_name: self.channel.name.clone(),
            state,
            attempt,
            bytes,
            elapsed_ms: self.inner.lock().started_at.elapsed().as_millis() as u64,
            message,
            at: now_ms(),
        });
    }

    /// Buffered bytes so a just-attached subscriber immediately gets a
    /// timestamp near "now".
    pub fn buffered(&self) -> Bytes {
        self.ring.lock().snapshot()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Bytes> {
        self.media.subscribe()
    }

    pub fn bytes(&self) -> u64 {
        self.inner.lock().bytes
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        let inner = self.inner.lock();
        SessionSnapshot {
            session_id: self.id.clone(),
            channel_id: self.channel.id.clone(),
            channel_name: self.channel.name.clone(),
            bytes: inner.bytes,
            subscribers: inner.subscribers,
            paused: inner.paused,
            wanted: inner.wanted,
            fatal: inner.fatal.clone(),
        }
    }

    pub fn is_fatal(&self) -> Option<String> {
        self.inner.lock().fatal.clone()
    }

    pub fn subscriber_attach(&self) {
        let mut inner = self.inner.lock();
        inner.subscribers += 1;
        inner.last_touch = Instant::now();
    }

    pub fn subscriber_detach(&self) {
        let mut inner = self.inner.lock();
        inner.subscribers = inner.subscribers.saturating_sub(1);
        inner.last_touch = Instant::now();
    }

    /// `true` when playback should be attempted right now.
    fn should_run(&self, generation: u64) -> bool {
        let inner = self.inner.lock();
        inner.wanted && inner.generation == generation
    }

    pub fn set_paused(&self, paused: bool) {
        let mut inner = self.inner.lock();
        if inner.paused == paused || !inner.wanted {
            return;
        }
        inner.paused = paused;
        drop(inner);
        // ffmpeg's interactive protocol toggles pause with a single "p".
        self.write_stdin(b"p\n" as &'static [u8]);
        self.emit(
            if paused {
                PlaybackState::Paused
            } else {
                PlaybackState::Buffering
            },
            None,
        );
    }

    /// Writes one command to ffmpeg's stdin.
    fn write_stdin(&self, cmd: &'static [u8]) {
        let handle = self.stdin.clone();
        tokio::spawn(async move {
            let mut guard = handle.lock().await;
            if let Some(stdin) = guard.as_mut() {
                let _ = stdin.write_all(cmd).await;
                let _ = stdin.flush().await;
            }
        });
    }

    pub fn stop(&self) {
        let kill = {
            let mut inner = self.inner.lock();
            inner.wanted = false;
            inner.generation += 1; // invalidate any pending restart
            inner.kill_tx.take()
        };
        if let Some(tx) = kill {
            let _ = tx.try_send(());
        }
        self.emit(PlaybackState::Stopped, None);
    }

    fn push_stderr(&self, line: String) {
        let mut inner = self.inner.lock();
        if inner.stderr_tail.len() >= MAX_LOG_LINES {
            inner.stderr_tail.remove(0);
        }
        inner.stderr_tail.push(line);
    }

    fn last_error(&self) -> Option<String> {
        self.inner
            .lock()
            .stderr_tail
            .iter()
            .rev()
            .find(|l| {
                l.contains("Error") || l.contains("404") || l.contains("403") || l.contains("refused")
            })
            .cloned()
    }
}



/// Sessions are addressable two ways: the UI holds a session id (for the
/// WebSocket relay) while playback requests arrive keyed by channel.
#[derive(Default)]
struct Sessions {
    by_channel: HashMap<String, Arc<Session>>,
    by_session: HashMap<String, Arc<Session>>,
}

impl Sessions {
    fn insert(&mut self, session: Arc<Session>) {
        self.by_channel
            .insert(session.channel.id.clone(), session.clone());
        self.by_session.insert(session.id.clone(), session);
    }

    fn remove(&mut self, session: &Session) {
        self.by_channel.remove(&session.channel.id);
        self.by_session.remove(&session.id);
    }

    fn all(&self) -> Vec<Arc<Session>> {
        self.by_session.values().cloned().collect()
    }
}

pub struct SessionManager {
    sessions: Mutex<Sessions>,
    events: broadcast::Sender<StatusEvent>,
    ffmpeg: PathBuf,
    cfg: TranscodeConfig,
}

impl SessionManager {
    pub fn new(ffmpeg: PathBuf, cfg: TranscodeConfig) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            sessions: Mutex::new(Sessions::default()),
            events,
            ffmpeg,
            cfg,
        }
    }

    pub fn events(&self) -> broadcast::Receiver<StatusEvent> {
        self.events.subscribe()
    }

    /// Start (or attach to) a session for `channel`.
    pub fn start(&self, channel: Channel) -> Result<Arc<Session>, String> {
        let mut sessions = self.sessions.lock();
        if let Some(existing) = sessions.by_channel.get(&channel.id) {
            let alive = existing.inner.lock().wanted;
            if alive {
                existing.inner.lock().last_touch = Instant::now();
                return Ok(existing.clone());
            }
        }

        let session = Arc::new(Session::new(
            channel,
            self.ffmpeg.clone(),
            self.cfg.clone(),
            self.events.clone(),
        ));
        sessions.insert(session.clone());

        let starter = session.clone();
        tokio::spawn(async move { starter.supervise(0).await });
        Ok(session)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().by_session.get(id).cloned()
    }

    pub fn ids(&self) -> Vec<String> {
        self.sessions.lock().by_session.keys().cloned().collect()
    }

    /// Snapshot of every known session, for diagnostics.
    pub fn summaries(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().all()
    }

    pub fn stop(&self, id: &str) {
        if let Some(session) = self.get(id) {
            session.stop();
        }
    }

    pub fn stop_all(&self) {
        for session in self.sessions.lock().all() {
            session.stop();
        }
    }

    /// Drop a finished session so its id stops being resolvable.
    pub fn reap(&self, id: &str) {
        let Some(session) = self.get(id) else {
            return;
        };
        let finished = !session.inner.lock().wanted || session.is_fatal().is_some();
        if finished {
            self.sessions.lock().remove(&session);
        }
    }

    /// Shut down sessions nobody is watching, so a closed player does not keep
    /// an encoder running in the background.
    pub fn reap_idle(&self) {
        let stale: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .all()
            .into_iter()
            .filter(|s| {
                let inner = s.inner.lock();
                inner.subscribers == 0 && inner.last_touch.elapsed() > IDLE_TIMEOUT && inner.wanted
            })
            .collect();
        for session in stale {
            session.stop();
        }
    }
}

impl Session {
    /// Owns one ffmpeg generation: spawn, relay output, restart on failure.
    ///
    /// Boxed because a generation may restart the next one; recursion in an
    /// `async fn` would otherwise need an infinitely sized future.
    fn supervise(
        self: &Arc<Self>,
        generation: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(self.clone().supervise_generation(generation))
    }

    async fn supervise_generation(self: Arc<Self>, generation: u64) {
        {
            let mut inner = self.inner.lock();
            inner.generation = generation;
            inner.generation_started_at = Instant::now();
            inner.last_bytes_at = None;
        }
        // A new ffmpeg means a new byte timeline: never hand out packets from
        // the process we just replaced.
        self.ring.lock().clear();
        self.emit(
            PlaybackState::Starting,
            if generation == 0 {
                None
            } else {
                Some(format!("reconnect attempt {generation}"))
            },
        );

        let args = build_args(&self.channel, &self.cfg);
        let mut child = match crate::ffmpeg::hide_console(Command::new(&self.ffmpeg))
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                self.inner.lock().fatal = Some(format!("cannot launch ffmpeg: {e}"));
                self.emit(
                    PlaybackState::Error,
                    Some(format!(
                        "cannot launch ffmpeg ({}). Set FFMPEG_PATH to a working binary.",
                        self.ffmpeg.display()
                    )),
                );
                return;
            }
        };

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let child_stdin = child.stdin.take();
        let (kill_tx, mut kill_rx) = mpsc::channel::<()>(4);
        {
            let mut inner = self.inner.lock();
            inner.kill_tx = Some(kill_tx);
        }
        *self.stdin.lock().await = child_stdin;

        let out_task = tokio::spawn(relay_stdout(self.clone(), stdout, generation));
        let err_task = tokio::spawn(relay_stderr(self.clone(), stderr, generation));

        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut exit: Option<String> = None;

        loop {
            tokio::select! {
                biased;
                _ = kill_rx.recv() => {
                    let _ = child.start_kill();
                    break;
                }
                status = child.wait() => {
                    exit = Some(match status {
                        Ok(s) if s.success() => "ffmpeg exited".to_string(),
                        Ok(s) => format!("ffmpeg exited with {s}"),
                        Err(e) => format!("ffmpeg wait failed: {e}"),
                    });
                    break;
                }
                _ = ticker.tick() => {
                    // Stall detection: bytes stopped while a viewer is present.
                    let (stalled, subscribers) = {
                        let inner = self.inner.lock();
                        let idle = inner
                            .last_bytes_at
                            .map(|t| t.elapsed() > STALL_TIMEOUT)
                            .unwrap_or(inner.generation_started_at.elapsed() > STALL_TIMEOUT);
                        (idle, inner.subscribers)
                    };
                    if stalled && subscribers > 0 {
                        exit = Some("stream stalled (no data)".to_string());
                        let _ = child.start_kill();
                        break;
                    }
                }
            }
        }

        let _ = child.wait().await;
        out_task.abort();
        err_task.abort();

        if !self.should_run(generation) {
            self.inner.lock().kill_tx = None;
            *self.stdin.lock().await = None;
            return;
        }

        // A user-requested pause is not a failure.
        if self.inner.lock().paused {
            self.inner.lock().kill_tx = None;
            *self.stdin.lock().await = None;
            return;
        }

        let detail = self
            .last_error()
            .or(exit)
            .unwrap_or_else(|| "stream ended".to_string());

        {
            let mut inner = self.inner.lock();
            inner.restarts += 1;
            inner.kill_tx = None;
        }
        let attempt = self.inner.lock().restarts;

        if attempt > MAX_RESTARTS {
            self.inner.lock().fatal = Some(detail.clone());
            self.emit(
                PlaybackState::Error,
                Some(format!("{detail} — gave up after {MAX_RESTARTS} attempts")),
            );
            return;
        }

        self.emit(PlaybackState::Reconnecting, Some(detail));
        // Back off so a dead endpoint does not spin the CPU, but keep retrying a
        // source long enough to ride out a CDN hiccup.
        let delay = Duration::from_millis(600 * u64::from(attempt).pow(2));
        tokio::time::sleep(delay.min(Duration::from_secs(5))).await;

        if self.should_run(generation) {
            self.supervise(generation + 1).await;
        }
    }
}

async fn relay_stdout(session: Arc<Session>, mut stdout: tokio::process::ChildStdout, generation: u64) {
    let mut buf = vec![0u8; READ_CHUNK];
    let mut emitted_first = false;
    loop {
        let n = match stdout.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        {
            let mut inner = session.inner.lock();
            if inner.generation != generation {
                return;
            }
            inner.bytes += n as u64;
            inner.last_bytes_at = Some(Instant::now());
        }
        session.ring.lock().push(&buf[..n]);
        let _ = session.media.send(Bytes::copy_from_slice(&buf[..n]));
        if !emitted_first {
            emitted_first = true;
            if !session.inner.lock().paused {
                session.emit(PlaybackState::Buffering, None);
            }
        }
    }
}

async fn relay_stderr(session: Arc<Session>, stderr: tokio::process::ChildStderr, generation: u64) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if session.inner.lock().generation != generation {
            return;
        }
        let line = line.trim();
        if !line.is_empty() {
            session.push_stderr(line.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playlist;

    fn channel(url: &str) -> Channel {
        playlist::parse_m3u(&format!("#EXTINF:-1 tvg-id=\"X.us\",Test\n{url}\n"))
            .pop()
            .unwrap()
    }

    #[test]
    fn ring_buffer_keeps_most_recent_bytes() {
        let mut ring = Ring::default();
        ring.push(&[1, 2, 3]);
        assert_eq!(&ring.snapshot()[..], &[1, 2, 3]);
        ring.push(&[4, 5]);
        assert_eq!(&ring.snapshot()[..], &[1, 2, 3, 4, 5]);
        ring.clear();
        assert!(ring.snapshot().is_empty());
    }

    #[tokio::test]
    async fn start_returns_reusable_session_per_channel() {
        let mgr = Arc::new(SessionManager::new(
            PathBuf::from("ffmpeg"),
            TranscodeConfig::default(),
        ));
        let ch = channel("http://127.0.0.1:9/dead.m3u8");
        let a = mgr.start(ch.clone()).unwrap();
        let b = mgr.start(ch).unwrap();
        assert_eq!(a.id, b.id, "same channel should reuse the running session");
        mgr.stop_all();
    }
}