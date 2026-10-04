import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { setFullscreen } from '../lib/api'
import { StreamEngine, engineSupported } from '../lib/playerEngine'
import { countryFlag, countryName, formatBitrate, resolutionTier, supportsFlagEmoji } from '../lib/format'
import { usePlayerSession } from '../hooks/usePlayerSession'
import type { Channel, PlayerPhase, ProbeInfo } from '../lib/types'
import { ChannelLogo } from './ChannelLogo'

interface Props {
  channel: Channel | null
  probe?: ProbeInfo
  favorite: boolean
  onToggleFavorite: (channel: Channel) => void
  onClose: () => void
  onSelect: (channel: Channel) => void
  suggestions: Channel[]
}

const CHROME_IDLE_MS = 3600
/** No decoded frame within this window means the pipeline needs rebuilding. */
const FIRST_FRAME_TIMEOUT_MS = 18_000
const MAX_AUTORECOVERY = 3

export function Player({
  channel,
  probe,
  favorite,
  onToggleFavorite,
  onClose,
  onSelect,
  suggestions,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const engineRef = useRef<StreamEngine | null>(null)
  const recoveries = useRef(0)

  const [hasFrame, setHasFrame] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [playBlocked, setPlayBlocked] = useState(false)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [startedMuted, setStartedMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [chrome, setChrome] = useState(true)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [resolution, setResolution] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  })
  const [buffered, setBuffered] = useState(0)

  const { wsUrl, backendPhase, message, reloadToken, retry } = usePlayerSession(channel)

  const supported = useMemo(() => engineSupported(), [])

  /* ---------------------------------------------------------------- engine */

  // Rebuild the media pipeline whenever the session or the recovery token moves.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    setHasFrame(false)
    setStalled(false)
    setPlayBlocked(false)
    setResolution({ width: 0, height: 0 })

    if (!wsUrl) {
      engineRef.current?.destroy()
      engineRef.current = null
      return
    }

    const engine = new StreamEngine(video, {
      onFirstFrame: () => setHasFrame(true),
      onPhase: (phase: PlayerPhase, detail?: string) => {
        if (phase === 'error') setEngineError(detail ?? 'Playback failed.')
        if (phase === 'playing') {
          setEngineError(null)
          setPlayBlocked(false)
        }
        // A refused autoplay is a paused state, not a failure.
        if (phase === 'paused' && !hasFrame) setPlayBlocked(true)
      },
      onStats: (stats) => {
        if (stats.width && stats.height) setResolution({ width: stats.width, height: stats.height })
        setBuffered(stats.bufferedSeconds)
        setStartedMuted(engine.startedMuted)
      },
    })
    engineRef.current = engine
    engine.load(wsUrl)

    return () => {
      engine.destroy()
      engineRef.current = null
    }
  }, [wsUrl, reloadToken])

  // A slow or dead endpoint must not leave a permanently black rectangle.
  useEffect(() => {
    if (!wsUrl || hasFrame || backendPhase === 'error') return
    const timer = window.setTimeout(() => {
      if (engineRef.current && recoveries.current < MAX_AUTORECOVERY) {
        recoveries.current += 1
        retry()
      }
    }, FIRST_FRAME_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [wsUrl, hasFrame, backendPhase, retry, reloadToken])

  useEffect(() => {
    if (hasFrame) recoveries.current = 0
  }, [hasFrame])

  /* ------------------------------------------------------- stall detection */

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onWaiting = () => setStalled(true)
    const onPlaying = () => setStalled(false)
    const onTimeUpdate = () => setStalled(false)
    const onPause = () => setPaused(true)
    const onPlay = () => setPaused(false)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('pause', onPause)
    video.addEventListener('play', onPlay)
    return () => {
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('play', onPlay)
    }
  }, [channel?.id])

  /* -------------------------------------------------------------- controls */

  const togglePlay = useCallback(() => {
    const engine = engineRef.current
    if (!engine) return
    if (engine.isPaused) {
      setPlayBlocked(false)
      void engine.play()
    } else {
      engine.pause()
    }
  }, [])

  const restoreSound = useCallback(() => {
    engineRef.current?.unmute()
    setMuted(false)
  }, [])

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      engineRef.current?.setMuted(!current)
      return !current
    })
  }, [])

  const changeVolume = useCallback((next: number) => {
    setVolume(next)
    const engine = engineRef.current
    if (engine) {
      engine.setVolume(next)
      engine.setMuted(next === 0)
    }
    setMuted(next === 0)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    const stage = document.querySelector('.player__stage')
    if (!document.fullscreenElement && stage instanceof HTMLElement) {
      await stage.requestFullscreen().catch(() => undefined)
      return
    }
    await setFullscreen(false)
  }, [])

  // Chrome auto-hide once video is genuinely running.
  useEffect(() => {
    if (!channel) return
    setChrome(true)
    if (paused || !hasFrame) return
    const timer = window.setTimeout(() => setChrome(false), CHROME_IDLE_MS)
    return () => window.clearTimeout(timer)
  }, [channel, paused, hasFrame])

  // Keyboard shortcuts (the design targets keyboard/remote navigation).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!channel) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault()
          togglePlay()
          break
        case 'm':
          toggleMute()
          break
        case 'ArrowUp':
          event.preventDefault()
          changeVolume(Math.min(1, volume + 0.1))
          break
        case 'ArrowDown':
          event.preventDefault()
          changeVolume(Math.max(0, volume - 0.1))
          break
        case 'f':
          void toggleFullscreen()
          break
        case 'Escape':
          onClose()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [channel, togglePlay, toggleMute, changeVolume, toggleFullscreen, volume, onClose])

  /* ---------------------------------------------------------- phase model */

  const fatalError = engineError ?? (backendPhase === 'error' ? (message ?? 'Stream unavailable.') : null)

  const phase: PlayerPhase = fatalError
    ? 'error'
    : backendPhase === 'reconnecting'
      ? 'reconnecting'
      : hasFrame && !stalled
        ? paused
          ? 'paused'
          : 'playing'
        : backendPhase === 'idle'
          ? 'idle'
          : wsUrl
            ? 'buffering'
            : 'connecting'

  const phaseLabel: Record<Exclude<PlayerPhase, 'playing' | 'idle'>, string> = {
    connecting: 'Connecting to the stream',
    buffering: 'Buffering',
    paused: 'Paused',
    reconnecting: 'Reconnecting',
    error: 'This channel could not be played',
  }

  const liveTier = resolutionTier(resolution.width, resolution.height) ?? channel?.resolution ?? null
  const bitrate = formatBitrate(probe?.bitrateKbps) ?? (probe?.ok ? 'H.264' : null)
  const waitingHint =
    phase === 'connecting'
      ? 'Starting ffmpeg and requesting the source'
      : phase === 'buffering'
        ? `Decoding${message ? ` — ${message}` : ''}`
        : null

  if (!channel) return null

  return (
    <div
      className={`player${chrome && phase === 'playing' ? '' : ' player--chrome-hidden'}`}
      onMouseMove={() => setChrome(true)}
      onTouchStart={() => setChrome(true)}
    >
      <div className="player__stage">
        {/* Designed backdrop: visible until a real frame is decoded. */}
        <div className={`player__backdrop${hasFrame ? ' player__backdrop--hidden' : ''}`}>
          <div className="player__backdropGlow" />
          <ChannelLogo channel={channel.name} logo={channel.logo} className="player__logo" />
          {phase !== 'error' && !playBlocked && (
            <div className="player__status">
              <span className="spinner" aria-hidden="true" />
              <p>{waitingHint ?? phaseLabel[phase as keyof typeof phaseLabel] ?? 'Starting'}</p>
              {phase === 'reconnecting' && <small>The source dropped; retrying automatically.</small>}
            </div>
          )}

          {playBlocked && (
            <div className="player__gate">
              <button
                type="button"
                className="player__gateButton"
                onClick={togglePlay}
                aria-label="Start playback"
              >
                <svg viewBox="0 0 24 24" width="34" height="34">
                  <path d="M8 5v14l11-7z" fill="currentColor" />
                </svg>
              </button>
              <p>Press play to start watching.</p>
            </div>
          )}
        </div>

        <video
          ref={videoRef}
          className={`player__video${hasFrame ? ' is-visible' : ''}`}
          playsInline
          onClick={() => {
            togglePlay()
            // The first click is also the gesture that lets us restore sound.
            if (startedMuted) restoreSound()
          }}
        />

        {phase === 'error' && (
          <div className="player__error" role="alert">
            <div className="player__errorCard">
              <h2>{phaseLabel.error}</h2>
              <p>{fatalError}</p>
              {!supported && (
                <p className="player__errorHint">
                  Media Source Extensions are unavailable in this webview.
                </p>
              )}
              <div className="player__errorActions">
                <button type="button" className="button button--accent" onClick={retry}>
                  Retry
                </button>
                <button type="button" className="button" onClick={() => setSwitcherOpen(true)}>
                  Pick another channel
                </button>
                <button type="button" className="button" onClick={onClose}>
                  Back to guide
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Chrome */}
        <div className={`player__chrome${chrome ? ' player__chrome--on' : ''}`}>
          <div className="player__topbar">
            <button
              type="button"
              className="button button--icon button--onGlass"
              onClick={onClose}
              aria-label="Back to channel guide"
            >
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z" fill="currentColor" />
              </svg>
            </button>

            <div className="player__identity">
              <ChannelLogo channel={channel.name} logo={channel.logo} className="player__logoSm" />
              <div>
                <h2>{channel.name}</h2>
                <p>
                  {supportsFlagEmoji() && <span aria-hidden="true">{countryFlag(channel.country)} </span>}
                  {countryName(channel.country)}
                  {channel.group ? ` · ${channel.group.split(';')[0]}` : ''}
                </p>
              </div>
            </div>

            <div className="player__badges">
              <span className="live-pill">
                <span className="live-pill__dot" />
                LIVE
              </span>
              {liveTier && <span className="badge">{liveTier}</span>}
              {bitrate && <span className="badge badge--muted">{bitrate}</span>}
              <button
                type="button"
                className={`button button--icon button--onGlass${favorite ? ' is-favorite' : ''}`}
                onClick={() => onToggleFavorite(channel)}
                aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
              >
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <path
                    d="M12 20.3l-1.1-1C6 14.9 3 12.2 3 8.9 3 6.2 5.1 4 7.8 4c1.5 0 3 .7 4.2 2 1.2-1.3 2.7-2 4.2-2C18.9 4 21 6.2 21 8.9c0 3.3-3 6-7.9 10.4z"
                    fill={favorite ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                </svg>
              </button>
            </div>
          </div>

          {channel.now && (
            <div className="player__nowPlaying">
              <span className="label-sm">Now playing</span>
              <span className="player__nowPlayingTitle">{channel.now.title}</span>
            </div>
          )}

          {startedMuted && hasFrame && (
            <button type="button" className="player__soundChip" onClick={restoreSound}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  d="M4 9v6h4l5 4V5L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"
                  fill="currentColor"
                />
              </svg>
              Sound is off — tap to enable
            </button>
          )}

          <div className="transport">
            <button
              type="button"
              className="transport__button"
              onClick={togglePlay}
              aria-label={paused ? 'Play' : 'Pause'}
            >
              {paused ? (
                <svg viewBox="0 0 24 24" width="22" height="22">
                  <path d="M8 5v14l11-7z" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="22" height="22">
                  <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" />
                </svg>
              )}
            </button>

            <div className="transport__volume">
              <button
                type="button"
                className="transport__button"
                onClick={toggleMute}
                aria-label={muted ? 'Unmute' : 'Mute'}
              >
                {muted || volume === 0 ? (
                  <svg viewBox="0 0 24 24" width="20" height="20">
                    <path
                      d="M4 9v6h4l5 4V5L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 2v2a8 8 0 0 1 0 16v2a10 10 0 0 0 0-20z"
                      fill="currentColor"
                    />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20">
                    <path
                      d="M3 9v6h4l5 4V5L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"
                      fill="currentColor"
                    />
                  </svg>
                )}
              </button>
              <input
                className="transport__slider"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Volume"
                onChange={(event) => changeVolume(Number(event.target.value))}
              />
            </div>

            <div className="transport__status">
              {phase === 'playing' ? (
                <span className="transport__live">
                  <span className="live-pill__dot" />
                  Live
                  {buffered > 0 && (
                    <span className="transport__buffer" title="Seconds of media buffered ahead">
                      {buffered.toFixed(0)}s buffer
                    </span>
                  )}
                </span>
              ) : (
                <span className="transport__hint">
                  {phase === 'buffering'
                    ? 'Buffering'
                    : phase === 'reconnecting'
                      ? 'Reconnecting'
                      : phase === 'paused'
                        ? 'Paused'
                        : 'Starting'}
                  {buffered > 0.2 ? ` · ${buffered.toFixed(1)}s` : ''}
                </span>
              )}
            </div>

            <div className="transport__right">
              <button
                type="button"
                className="transport__button"
                onClick={() => setSwitcherOpen((open) => !open)}
                aria-label="Switch channel"
                aria-expanded={switcherOpen}
              >
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path
                    d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"
                    fill="currentColor"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="transport__button"
                onClick={() => void toggleFullscreen()}
                aria-label="Fullscreen"
              >
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path
                    d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {switcherOpen && (
          <div className="flyout flyout--switcher" role="dialog" aria-label="Channel switcher">
            <div className="flyout__header">
              <h3>Switch channel</h3>
              <button
                type="button"
                className="button button--icon"
                onClick={() => setSwitcherOpen(false)}
                aria-label="Close channel switcher"
              >
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" fill="currentColor" />
                </svg>
              </button>
            </div>
            <ul className="flyout__list">
              {suggestions.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`flyout__item${item.id === channel.id ? ' is-active' : ''}`}
                    onClick={() => {
                      setSwitcherOpen(false)
                      if (item.id !== channel.id) onSelect(item)
                    }}
                  >
                    <ChannelLogo channel={item.name} logo={item.logo} className="flyout__logo" />
                    <span className="flyout__name">{item.name}</span>
                    <span className="flyout__meta">{item.country ?? 'INT'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}