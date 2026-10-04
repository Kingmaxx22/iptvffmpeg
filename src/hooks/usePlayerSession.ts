import { useCallback, useEffect, useRef, useState } from 'react'
import { sendControl, startPlayback, websocketUrl } from '../lib/api'
import { useStatusFeed } from './useStatusFeed'
import type { Channel, PlaybackState, PlayResponse } from '../lib/types'

export type BackendPhase = 'idle' | PlaybackState

export interface PlayerSession {
  session: PlayResponse | null
  wsUrl: string | null
  backendPhase: BackendPhase
  message?: string
  attempt: number
  /** Bumped to make the media engine rebuild its pipeline. */
  reloadToken: number
  retry: () => void
  stop: () => void
}

/**
 * Owns the ffmpeg session for the active channel.
 *
 * The backend restarts ffmpeg on its own when a stream dies, and the relay
 * survives that, but Media Source needs a fresh buffer after the source is
 * replaced — so a `reconnecting` status schedules an engine reload.
 */
export function usePlayerSession(channel: Channel | null): PlayerSession {
  const [session, setSession] = useState<PlayResponse | null>(null)
  const [wsUrl, setWsUrl] = useState<string | null>(null)
  const [backendPhase, setBackendPhase] = useState<BackendPhase>('idle')
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const [reloadToken, setReloadToken] = useState(0)

  const sessionRef = useRef<PlayResponse | null>(null)
  const channelRef = useRef<Channel | null>(channel)
  channelRef.current = channel
  const channelId = channel?.id ?? null

  const stop = useCallback(() => {
    const current = sessionRef.current
    if (current) {
      void sendControl(current.sessionId, 'stop').catch(() => undefined)
    }
    sessionRef.current = null
    setSession(null)
    setWsUrl(null)
    setBackendPhase('idle')
    setMessage(undefined)
  }, [])

  const begin = useCallback(async (target: Channel) => {
    setBackendPhase('starting')
    setMessage(undefined)
    setAttempt(0)
    try {
      const next = await startPlayback(target.id)
      sessionRef.current = next
      setSession(next)
      setWsUrl(await websocketUrl(next.wsPath))
    } catch (error) {
      setBackendPhase('error')
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const retry = useCallback(() => {
    const target = channelRef.current
    if (!target) return
    setReloadToken((token) => token + 1)
    void begin(target)
  }, [begin])

  useEffect(() => {
    if (!channel) {
      stop()
      return
    }
    void begin(channel)
    return () => {
      const current = sessionRef.current
      if (current) void sendControl(current.sessionId, 'stop').catch(() => undefined)
    }
    // A new channel means a new session; restarting on identity is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  const reloadTimer = useRef<number | undefined>(undefined)

  useStatusFeed((event) => {
    if (!sessionRef.current || event.sessionId !== sessionRef.current.sessionId) return

    setAttempt(event.attempt)
    switch (event.state) {
      case 'starting':
      case 'buffering':
        setBackendPhase('buffering')
        setMessage(undefined)
        // A restarted ffmpeg emits a new byte stream; MSE has to be re-primed.
        if (event.attempt > 0) {
          setReloadToken((token) => token + 1)
        }
        break
      case 'paused':
        setBackendPhase('paused')
        break
      case 'reconnecting':
        setBackendPhase('reconnecting')
        setMessage(event.message)
        // If ffmpeg does not come back promptly, rebuild the pipeline anyway.
        window.clearTimeout(reloadTimer.current)
        reloadTimer.current = window.setTimeout(() => {
          setReloadToken((token) => token + 1)
        }, 3500)
        break
      case 'error':
        setBackendPhase('error')
        setMessage(event.message ?? 'The stream could not be played.')
        break
      case 'stopped':
        setBackendPhase('idle')
        break
    }
  })

  useEffect(() => () => window.clearTimeout(reloadTimer.current), [])

  return { session, wsUrl, backendPhase, message, attempt, reloadToken, retry, stop }
}