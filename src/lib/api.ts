/**
 * Client for the Rust media server.
 *
 * In the Tauri shell the backend asks for its own loopback base URL. In browser
 * dev mode the Vite proxy forwards `/api` and `/ws` to the standalone server, so
 * the base is simply the page origin.
 */
import type { ChannelsResponse, Meta, PlayResponse, ProbeInfo, StatusEvent } from './types'

export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

/**
 * Default loopback port. The backend prefers this port and only falls back to
 * an ephemeral one when it is taken, so this is a reliable last resort when the
 * IPC lookup is unavailable.
 */
const FALLBACK_BASE = 'http://127.0.0.1:8787'

let basePromise: Promise<string> | null = null
/** Last known base, so synchronous helpers (logo URLs) can use it. */
let resolvedBase = ''

/**
 * Route channel logos through the backend.
 *
 * The upstream playlist has many dead logo URLs and some hosts rate limit
 * aggressively; proxying keeps the page free of network errors and lets the UI
 * fall back to its monogram quietly.
 */
export function logoSrc(logo: string): string {
  return `${resolvedBase}/api/logo?url=${encodeURIComponent(logo)}`
}

export function mediaBase(): Promise<string> {
  if (!basePromise) {
    basePromise = (async () => {
      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const base = await invoke<string>('media_base')
          return base.replace(/\/$/, '')
        } catch (error) {
          console.warn('[api] media_base command unavailable, using the default port', error)
          return FALLBACK_BASE
        }
      }

      // Inside the packaged app the origin is the custom `tauri://` scheme, so
      // relative URLs cannot reach the backend at all.
      const protocol = window.location.protocol
      if (protocol !== 'http:' && protocol !== 'https:') return FALLBACK_BASE
      // Browser dev mode: same origin, Vite proxies /api and /ws.
      return ''
    })()
  }
  return basePromise.then((base) => {
    resolvedBase = base
    return base
  })
}

export async function absolute(path: string): Promise<string> {
  return `${await mediaBase()}${path}`
}

export async function websocketUrl(path: string): Promise<string> {
  const base = await mediaBase()
  if (!base) {
    // Same origin, but the browser needs an absolute ws(s) URL.
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}${path}`
  }
  return `${base.replace(/^http/, 'ws')}${path}`
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(await absolute(path), { signal })
  if (!response.ok) {
    throw new Error(`${path} failed: HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

async function postJson<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(await absolute(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${path} failed: HTTP ${response.status} ${detail}`)
  }
  return (await response.json()) as T
}

export function getMeta(signal?: AbortSignal): Promise<Meta> {
  return getJson<Meta>('/api/meta', signal)
}

export function getChannels(signal?: AbortSignal): Promise<ChannelsResponse> {
  return getJson<ChannelsResponse>('/api/channels', signal)
}

export function refreshPlaylist(): Promise<string> {
  return postJson<string>('/api/playlist/refresh')
}

export function probeChannels(ids: string[]): Promise<Record<string, ProbeInfo>> {
  return postJson<{ results: Record<string, ProbeInfo> }>('/api/probe', { ids }).then(
    (r) => r.results,
  )
}

export function startPlayback(channelId: string): Promise<PlayResponse> {
  return postJson<PlayResponse>('/api/play', { channelId })
}

export function sendControl(sessionId: string, action: 'play' | 'pause' | 'stop'): Promise<unknown> {
  return postJson('/api/control', { sessionId, action })
}

/** Server-sent playback status. Returns an unsubscribe function. */
export async function subscribeStatus(onEvent: (event: StatusEvent) => void): Promise<() => void> {
  const source = new EventSource(await absolute('/api/events'))
  const handler = (event: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(event.data) as StatusEvent)
    } catch {
      /* keepalive comments and partial frames are not fatal */
    }
  }
  source.addEventListener('status', handler as EventListener)
  return () => source.close()
}

/**
 * Report UI diagnostics to the backend.
 *
 * The packaged app has no devtools, so this is how startup failures and
 * uncaught errors become visible in the app's own log.
 */
export async function reportToBackend(level: string, message: string): Promise<void> {
  try {
    const base = await Promise.race([
      mediaBase(),
      new Promise<string>((resolve) => window.setTimeout(() => resolve(FALLBACK_BASE), 1500)),
    ])
    await fetch(`${base}/api/client-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level, message }),
      keepalive: true,
    })
  } catch {
    /* diagnostics must never throw */
  }
}

/** Install global error reporting once, at startup. */
export function installDiagnostics(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (event) => {
    void reportToBackend('error', `${event.message} @ ${event.filename}:${event.lineno}`)
  })
  window.addEventListener('unhandledrejection', (event) => {
    void reportToBackend('error', `unhandled rejection: ${String(event.reason)}`)
  })
  void mediaBase().then((base) => {
    void reportToBackend('info', `UI started, media base = ${base || '(same origin)'}`)
  })
}

/** Tauri-only window helpers; no-ops in the browser. */
export async function setFullscreen(on: boolean): Promise<void> {
  if (!isTauri()) {
    if (on) await document.documentElement.requestFullscreen?.().catch(() => undefined)
    else await document.exitFullscreen?.().catch(() => undefined)
    return
  }
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_fullscreen', { on })
}

export async function setAlwaysOnTop(on: boolean): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_always_on_top', { on }).catch(() => undefined)
}