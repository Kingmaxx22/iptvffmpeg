/** Types shared with the Rust media server (serde `camelCase`). */

export type HealthState = 'online' | 'degraded' | 'offline'

export interface ProbeInfo {
  ok: boolean
  health: HealthState
  width?: number
  height?: number
  fps?: number
  videoCodec?: string
  audioCodec?: string
  bitrateKbps?: number
  latencyMs: number
  error?: string
  probedAt: number
}

export interface Programme {
  title: string
  /** Epoch milliseconds (UTC). */
  start: number
  stop: number
}

export interface Channel {
  id: string
  name: string
  url: string
  logo?: string
  group: string
  country?: string
  language?: string
  tvgId?: string
  userAgent?: string
  referrer?: string
  resolution?: string
  featured: boolean
  /** From the optional XMLTV guide, when the source covers this channel. */
  now?: Programme | null
  next?: Programme | null
}

export type PlaylistStatus = 'loading' | 'ready' | 'fallback'

export interface ChannelsResponse {
  status: PlaylistStatus
  message?: string
  total: number
  fetchedAt?: number
  source: string
  channels: Channel[]
}

export interface Meta {
  version: string
  port: number
  ffmpegPath: string
  ffmpegVersion?: string
  ffmpegOk: boolean
  playlistUrl: string
  playlistStatus: PlaylistStatus
  playlistMessage?: string
  channelCount: number
  featuredCount: number
  startedAt: number
}

export type PlaybackState =
  | 'starting'
  | 'buffering'
  | 'paused'
  | 'reconnecting'
  | 'error'
  | 'stopped'

export interface StatusEvent {
  sessionId: string
  channelId: string
  channelName: string
  state: PlaybackState
  attempt: number
  bytes: number
  elapsedMs: number
  message?: string
  at: number
}

export interface PlayResponse {
  sessionId: string
  channelId: string
  channelName: string
  wsPath: string
  httpPath: string
}

/** What the UI actually renders, derived from the engine + backend status. */
export type PlayerPhase =
  | 'idle'
  | 'connecting'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'reconnecting'
  | 'error'

export interface PlayerStats {
  width: number
  height: number
  bufferedSeconds: number
  bitrateKbps: number | null
  fps: number | null
  droppedFrames: number
}