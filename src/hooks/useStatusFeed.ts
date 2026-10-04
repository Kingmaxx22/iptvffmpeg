import { useEffect, useRef } from 'react'
import { subscribeStatus } from '../lib/api'
import type { StatusEvent } from '../lib/types'

/**
 * Server-sent playback status for the active session.
 *
 * The handler is kept in a ref so re-renders never tear down the EventSource.
 */
export function useStatusFeed(onEvent: (event: StatusEvent) => void) {
  const handler = useRef(onEvent)
  handler.current = onEvent

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    let cancelled = false

    subscribeStatus((event) => {
      if (!cancelled) handler.current(event)
    })
      .then((fn) => {
        if (cancelled) fn()
        else unsubscribe = fn
      })
      .catch((error) => {
        console.error('[status] SSE subscription failed', error)
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])
}