/**
 * Playback engine.
 *
 * The backend hands us a live MPEG-TS feed over a WebSocket. Chromium cannot
 * play MPEG-TS natively, so mpegts.js transmuxes it to fragmented MP4 and feeds
 * Media Source Extensions.
 *
 * The one rule that matters here: never present an empty video element. The
 * engine reports when a frame has actually been decoded (`onFirstFrame`), and the
 * UI keeps its designed backdrop visible until then.
 */
import mpegts from 'mpegts.js'
import type { PlayerPhase, PlayerStats } from './types'

export interface EngineEvents {
  onPhase: (phase: PlayerPhase, message?: string) => void
  onFirstFrame: () => void
  onStats: (stats: PlayerStats) => void
}

/**
 * Playback cushion, in bytes of demuxed input.
 *
 * The backend transcodes in real time, so the decoder can never be more than a
 * fraction of a second ahead of the network. The cushion therefore lives in the
 * demuxer's input stash: keeping ~2 MB queued (roughly 6-8s at the default
 * bitrate) absorbs segment jitter without adding latency the user can feel.
 */
const STASH_INITIAL_BYTES = 2 * 1024 * 1024
const BUFFER_TARGET_SECONDS = 8
const BUFFER_MAX_SECONDS = 20
const BUFFER_MIN_REMAIN_SECONDS = 2

const EMPTY_STATS: PlayerStats = {
  width: 0,
  height: 0,
  bufferedSeconds: 0,
  bitrateKbps: null,
  fps: null,
  droppedFrames: 0,
}

/**
 * Whether the page has seen a real user gesture.
 *
 * Browsers refuse to start *audible* playback without one, so the engine starts
 * muted until the user interacts rather than surfacing a blocking gate.
 */
let userGestureSeen = false
if (typeof window !== 'undefined') {
  const markGesture = () => {
    userGestureSeen = true
  }
  window.addEventListener('pointerdown', markGesture, { capture: true, once: true })
  window.addEventListener('keydown', markGesture, { capture: true, once: true })
  window.addEventListener('touchstart', markGesture, { capture: true, once: true })
}

export function hasUserGesture(): boolean {
  return userGestureSeen
}

export function engineSupported(): boolean {
  try {
    return mpegts.isSupported()
  } catch {
    return false
  }
}

export class StreamEngine {
  private player: mpegts.Player | null = null
  private url: string | null = null
  private statsTimer: number | null = null
  private firstFrameSent = false
  private destroyed = false
  private mutedFallback = false

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly events: EngineEvents,
  ) {
    this.video.autoplay = true
    this.video.playsInline = true
    this.video.controls = false
    this.video.preload = 'auto'
    this.video.addEventListener('loadeddata', this.handleLoadedData)
    this.video.addEventListener('playing', this.handlePlaying)
    this.video.addEventListener('waiting', this.handleWaiting)
    this.video.addEventListener('error', this.handleVideoError)
  }

  private handleLoadedData = () => {
    if (this.video.videoWidth > 0 && !this.firstFrameSent) {
      this.firstFrameSent = true
      this.events.onFirstFrame()
    }
  }

  private handlePlaying = () => {
    this.handleLoadedData()
    this.events.onPhase('playing')
  }

  private handleWaiting = () => {
    if (!this.video.paused && !this.video.ended) {
      this.events.onPhase('buffering')
    }
  }

  private handleVideoError = () => {
    const code = this.video.error?.code
    const message =
      code === 4
        ? 'This stream uses a codec WebView2 cannot decode (ffmpeg should have converted it).'
        : `The media element failed (code ${code ?? 'unknown'}).`
    this.events.onPhase('error', message)
  }

  load(url: string): void {
    this.destroyPlayer()
    this.url = url
    this.firstFrameSent = false

    if (!engineSupported()) {
      this.events.onPhase('error', 'Media Source Extensions are unavailable in this webview.')
      return
    }

    const player = mpegts.createPlayer(
      {
        type: 'mpegts',
        isLive: true,
        url,
      },
      {
        // A dedicated worker is awkward under the Tauri custom protocol, and
        // the transmuxer is not the bottleneck here.
        enableWorker: false,
        // Deep buffer: this is what stops playback cutting out on jittery
        // community streams.
        enableStashBuffer: true,
        stashInitialSize: STASH_INITIAL_BYTES,
        lazyLoad: false,
        autoCleanupSourceBuffer: true,
        autoCleanupMinBackwardDuration: 30,
        autoCleanupMaxBackwardDuration: 60,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: BUFFER_MAX_SECONDS,
        liveBufferLatencyMinRemain: BUFFER_MIN_REMAIN_SECONDS,
        // Nudge playback rate slightly when the buffer drifts, instead of
        // stalling when it runs dry.
        liveSync: true,
        liveSyncTargetLatency: BUFFER_TARGET_SECONDS,
        liveSyncPlaybackRate: 1.1,
        liveSyncMaxLatency: BUFFER_MAX_SECONDS,
      },
    )

    player.attachMediaElement(this.video)
    player.on(mpegts.Events.ERROR, (type, detail, info) => {
      const fatal = Boolean(info && typeof info === 'object' && info.fatal)
      const text =
        (info && typeof info === 'object' && 'msg' in info && String(info.msg)) ||
        String(detail || type || 'stream error')
      this.events.onPhase(fatal ? 'error' : 'buffering', text)
    })

    player.load()
    this.player = player
    this.startStats()
    this.events.onPhase('connecting')
    void this.play()
  }

  /** Recreate the pipeline against the same session (recovery after a stall). */
  reload(): void {
    if (this.url) this.load(this.url)
  }

  async play(): Promise<void> {
    // Without a gesture the browser refuses audible playback, so start muted
    // straight away instead of provoking a rejection.
    const canPlayWithSound = userGestureSeen && !this.video.muted
    if (!canPlayWithSound) {
      this.video.muted = true
      this.mutedFallback = true
    }
    try {
      await this.video.play()
    } catch {
      // Chrome refuses to start audible playback without a gesture. Muted
      // playback is still real video, so fall back to that before treating the
      // situation as a failure.
      this.video.muted = true
      this.mutedFallback = true
      try {
        await this.video.play()
      } catch {
        // Not an error state: the UI shows a play button instead of an alarm.
        this.events.onPhase('paused', 'Press play to start watching')
      }
    }
  }

  /** True while playback started muted because autoplay was blocked. */
  get startedMuted(): boolean {
    return this.mutedFallback && this.video.muted
  }

  /** Restore sound after a user gesture. */
  unmute(): void {
    this.mutedFallback = false
    this.video.muted = false
  }

  pause(): void {
    this.video.pause()
    this.events.onPhase('paused')
  }

  setMuted(muted: boolean): void {
    if (!muted) this.mutedFallback = false
    this.video.muted = muted
  }

  setVolume(volume: number): void {
    this.video.volume = Math.min(1, Math.max(0, volume))
  }

  get isPaused(): boolean {
    return this.video.paused
  }

  get currentTime(): number {
    return this.video.currentTime
  }

  private startStats(): void {
    this.stopStats()
    this.statsTimer = window.setInterval(() => {
      const video = this.video
      if (video.readyState === 0) return
      const buffered = video.buffered
      let bufferedSeconds = 0
      if (buffered.length > 0) {
        bufferedSeconds = Math.max(0, buffered.end(buffered.length - 1) - video.currentTime)
      }
      const quality = video.getVideoPlaybackQuality?.()
      this.events.onStats({
        ...EMPTY_STATS,
        width: video.videoWidth,
        height: video.videoHeight,
        bufferedSeconds,
        droppedFrames: quality?.droppedVideoFrames ?? 0,
      })
    }, 1000)
  }

  private stopStats(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer)
      this.statsTimer = null
    }
  }

  private destroyPlayer(): void {
    this.stopStats()
    if (this.player) {
      try {
        this.player.pause()
        this.player.unload()
        this.player.detachMediaElement()
        this.player.destroy()
      } catch {
        /* tearing down a dead player is best-effort */
      }
      this.player = null
    }
    this.video.removeAttribute('src')
    // Guarantees the next render starts from a clean decoder.
    this.video.load()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.video.removeEventListener('loadeddata', this.handleLoadedData)
    this.video.removeEventListener('playing', this.handlePlaying)
    this.video.removeEventListener('waiting', this.handleWaiting)
    this.video.removeEventListener('error', this.handleVideoError)
    this.destroyPlayer()
  }
}