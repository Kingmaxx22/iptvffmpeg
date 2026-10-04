import { useCallback, useEffect, useRef, useState } from 'react'
import { getChannels, getMeta, refreshPlaylist } from '../lib/api'
import type { Channel, Meta, PlaylistStatus } from '../lib/types'

/**
 * Loads the playlist from the backend.
 *
 * The backend downloads the 2.5 MB upstream file asynchronously, so the first
 * requests legitimately return `loading` with zero channels; this polls until
 * the playlist is ready instead of showing an empty grid.
 */
export function usePlaylist() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [status, setStatus] = useState<PlaylistStatus>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const attempts = useRef(0)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await getChannels(signal)
      setChannels(response.channels)
      setStatus(response.status)
      setMessage(response.message ?? null)
      setError(null)
      attempts.current = 0
      if (response.status !== 'loading' || response.channels.length > 0) {
        setReady(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    let cancelled = false

    const tick = async () => {
      await load(controller.signal)
      if (cancelled) return
      getMeta(controller.signal)
        .then((m) => !cancelled && setMeta(m))
        .catch(() => undefined)

      attempts.current += 1
      // Keep asking while the backend is still downloading.
      if (attempts.current < 90 && !ready) {
        timer = window.setTimeout(tick, 1200)
      }
    }

    void tick()
    return () => {
      cancelled = true
      controller.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [load, ready])

  const reload = useCallback(async () => {
    setStatus('loading')
    try {
      await refreshPlaylist()
      // The backend reloads asynchronously; poll until the new list lands.
      let tries = 0
      await new Promise<void>((resolve) => {
        const poll = async () => {
          await load()
          tries += 1
          if (tries < 60 && status === 'loading') window.setTimeout(poll, 800)
          else resolve()
        }
        void poll()
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [load, status])

  return { meta, channels, status, message, error, ready, reload }
}