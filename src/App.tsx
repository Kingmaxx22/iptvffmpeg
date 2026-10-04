import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavBar, type NavKey } from './components/NavBar'
import { CommandBar, type SortKey } from './components/CommandBar'
import { PivotTabs, type PivotItem } from './components/PivotTabs'
import { ChannelGrid } from './components/ChannelGrid'
import { Player } from './components/Player'
import { SettingsView } from './components/SettingsView'
import { usePlaylist } from './hooks/usePlaylist'
import { useFavorites } from './hooks/useFavorites'
import { probeChannels } from './lib/api'
import { formatCount, primaryGroup } from './lib/format'
import type { Channel, ProbeInfo } from './lib/types'

/** How many visible cards get a live health probe (each probe is one ffmpeg). */
const PROBE_WINDOW = 12
/** Upper bound on probes per session, so the encoder count can never run away. */
const PROBE_BUDGET = 36
const MAX_PIVOTS = 10
/** Starter channels considered when picking what to play on launch. */
const AUTOPLAY_CANDIDATES = 4

type NavVariant = 'bar' | 'rail' | 'pane'

function useNavVariant(): NavVariant {
  const [variant, setVariant] = useState<NavVariant>(() =>
    typeof window === 'undefined' ? 'pane' : variantFor(window.innerWidth),
  )
  useEffect(() => {
    const onResize = () => setVariant(variantFor(window.innerWidth))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return variant
}

function variantFor(width: number): NavVariant {
  if (width < 640) return 'bar'
  if (width <= 1024) return 'rail'
  return 'pane'
}

export default function App() {
  const { meta, channels, status, message, error, ready, reload } = usePlaylist()
  const { favorites, toggle, isFavorite } = useFavorites()
  const navVariant = useNavVariant()

  const [nav, setNav] = useState<NavKey>('live')
  const [query, setQuery] = useState('')
  const [country, setCountry] = useState('')
  const [tab, setTab] = useState('starter')
  const [sort, setSort] = useState<SortKey>('name')
  const [hideOffline, setHideOffline] = useState(true)
  const [probes, setProbes] = useState<Record<string, ProbeInfo>>({})
  const [playing, setPlaying] = useState<Channel | null>(null)
  const [autoplay, setAutoplay] = useState(true)
  const [reloading, setReloading] = useState(false)

  const autoplayDone = useRef(false)
  const switchedRef = useRef(false)
  const mountedRef = useRef(true)
  const playingRef = useRef<Channel | null>(null)
  playingRef.current = playing

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /* ------------------------------------------------------------ pivots */

  const pivots = useMemo<PivotItem[]>(() => {
    if (nav === 'favorites') {
      return [
        { key: 'all', label: 'All favourites', count: favorites.length },
      ]
    }

    const counts = new Map<string, number>()
    let starterCount = 0
    for (const channel of channels) {
      if (channel.featured) starterCount += 1
      if (country && channel.country !== country) continue
      for (const group of channel.group.split(';')) {
        const name = group.trim()
        // The upstream playlist has literal "Undefined" groups.
        if (!name || /^(undefined|vod|other)$/i.test(name)) continue
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }

    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PIVOTS)
      .map(([key, count]) => ({ key, label: key, count }))

    return [
      { key: 'starter', label: 'Starter', count: starterCount },
      { key: 'all', label: 'All channels', count: channels.length },
      ...top,
    ]
  }, [channels, country, favorites.length, nav])

  /* ---------------------------------------------------------- filtering */

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()

    let list = channels
    if (nav === 'favorites') {
      list = list.filter((channel) => favorites.includes(channel.id))
    }
    if (country) {
      list = list.filter((channel) => channel.country === country)
    }
    if (tab === 'starter') {
      list = list.filter((channel) => channel.featured)
    } else if (tab !== 'all') {
      list = list.filter((channel) => channel.group.split(';').some((g) => g.trim() === tab))
    }
    if (needle) {
      list = list.filter((channel) =>
        [channel.name, channel.country, channel.group, channel.language, channel.tvgId]
          .filter(Boolean)
          .some((field) => field!.toLowerCase().includes(needle)),
      )
    }
    // Offline channels are hidden by default: half the playlist is down at any
    // moment, and a dead card is noise. Only probed channels are affected.
    if (hideOffline) {
      list = list.filter((channel) => probes[channel.id]?.health !== 'offline')
    }

    const sorted = [...list]
    if (sort === 'country') {
      sorted.sort((a, b) => (a.country ?? '').localeCompare(b.country ?? '') || a.name.localeCompare(b.name))
    } else if (sort === 'health') {
      const rank = (channel: Channel) => {
        const probe = probes[channel.id]
        if (!probe) return 2
        return probe.health === 'online' ? 0 : probe.health === 'degraded' ? 1 : 3
      }
      sorted.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name))
    }
    return sorted
  }, [channels, nav, favorites, country, tab, query, sort, probes, hideOffline])

  /** Probed channels known to be dead, for the "Hide offline" counter. */
  const offlineCount = useMemo(
    () => Object.values(probes).filter((probe) => !probe.ok).length,
    [probes],
  )

  const countries = useMemo(() => {
    const counts = new Map<string, number>()
    for (const channel of channels) {
      if (!channel.country) continue
      counts.set(channel.country, (counts.get(channel.country) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([code, count]) => ({ code, count }))
  }, [channels])

  /* -------------------------------------------------------- health probes */

  /**
   * Channels eligible for a health probe.
   *
   * Deliberately derived from the raw filters only — never from `probes` or
   * `hideOffline`. Those change as results arrive, which used to shift the
   * visible window and keep kicking off new probe rounds (each one an ffmpeg
   * process) long after the user had stopped scrolling.
   */
  const probeTargets = useMemo(() => {
    const needle = query.trim().toLowerCase()
    let list = channels
    if (nav === 'favorites') list = list.filter((channel) => favorites.includes(channel.id))
    if (country) list = list.filter((channel) => channel.country === country)
    if (tab === 'starter') list = list.filter((channel) => channel.featured)
    else if (tab !== 'all') list = list.filter((channel) => channel.group.split(';').some((g) => g.trim() === tab))
    if (needle) {
      list = list.filter((channel) =>
        [channel.name, channel.country, channel.group, channel.language, channel.tvgId]
          .filter(Boolean)
          .some((field) => field!.toLowerCase().includes(needle)),
      )
    }
    return list
  }, [channels, nav, favorites, country, tab, query])

  const probedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (probedRef.current.size >= PROBE_BUDGET) return
    const unknown = probeTargets
      .slice(0, PROBE_WINDOW)
      .map((channel) => channel.id)
      .filter((id) => !probedRef.current.has(id))
      .slice(0, PROBE_BUDGET - probedRef.current.size)
    if (unknown.length === 0) return

    // Mark before the request so a re-render mid-flight cannot queue the same
    // channel twice.
    unknown.forEach((id) => probedRef.current.add(id))

    let cancelled = false
    const timer = window.setTimeout(() => {
      probeChannels(unknown)
        .then((results) => {
          if (!cancelled) setProbes((current) => ({ ...current, ...results }))
        })
        .catch((error) => {
          // Allow a retry if the request itself failed.
          unknown.forEach((id) => probedRef.current.delete(id))
          console.warn('[probe] failed', error)
        })
    }, 650)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [probeTargets])

  const probeCount = Object.keys(probes).length
  const healthyCount = Object.values(probes).filter((p) => p.ok).length

  /* ------------------------------------------------------------ playback */

  const openPlayer = useCallback((channel: Channel) => {
    setPlaying(channel)
  }, [])

  // Start on a verified channel so the app opens on video, not an empty grid.
  //
  // Roughly half of the community playlist is offline at any moment, and probing
  // takes seconds. Waiting for the probe would delay the first frame, so instead
  // playback starts immediately on the first candidate and the probe result is
  // used to switch to a reachable channel if the first one is dead.
  useEffect(() => {
    if (autoplayDone.current || !autoplay || !ready || channels.length === 0) return
    autoplayDone.current = true

    const starters = channels.filter((channel) => channel.featured)
    const pool = (starters.length > 0 ? starters : channels).slice(0, AUTOPLAY_CANDIDATES)
    const mounted = mountedRef.current

    setPlaying(pool[0] ?? null)

    void (async () => {
      let results: Record<string, ProbeInfo> = {}
      try {
        results = await probeChannels(pool.map((channel) => channel.id))
      } catch (error) {
        console.warn('[autoplay] probe failed', error)
        return
      }
      if (!mounted || switchedRef.current) return

      const healthy = pool.find((channel) => results[channel.id]?.ok)
      const firstIsDead = !results[pool[0]?.id ?? '']?.ok
      // Only swap if the auto-picked channel is still on screen: the user may
      // have chosen or closed something in the meantime, and yanking the player
      // back would be hostile.
      const stillOnAutoPick = playingRef.current?.id === pool[0]?.id
      if (healthy && firstIsDead && stillOnAutoPick) {
        switchedRef.current = true
        setPlaying(healthy)
      }
    })()
  }, [autoplay, ready, channels])

  const suggestions = useMemo(() => {
    if (!playing) return []
    const index = filtered.findIndex((channel) => channel.id === playing.id)
    const pool = index >= 0 ? filtered.slice(index + 1) : filtered
    return [playing, ...pool].slice(0, 13)
  }, [filtered, playing])

  const handleReload = useCallback(async () => {
    setReloading(true)
    try {
      await reload()
    } finally {
      setReloading(false)
    }
  }, [reload])

  const emptyMessage =
    nav === 'favorites' && favorites.length === 0
      ? 'No favourites yet. Tap the heart on any channel card.'
      : status === 'loading'
        ? 'Loading the channel guide…'
        : 'No channels match these filters.'

  const starterHint = channels.length === 0 && status === 'loading'

  return (
    <div className="app" data-nav={navVariant}>
      <NavBar
        active={nav}
        onChange={setNav}
        variant={navVariant}
        favoriteCount={favorites.length}
      />

      <main className="app__main">
        {error && (
          <div className="banner banner--error" role="alert">
            <strong>The backend is not reachable.</strong> {error}
          </div>
        )}

        {meta && !meta.ffmpegOk && (
          <div className="banner banner--error" role="alert">
            <strong>ffmpeg was not found.</strong> Install it and restart, or set the
            FFMPEG_PATH environment variable to the binary.
          </div>
        )}

        {status === 'fallback' && (
          <div className="banner banner--warn" role="status">
            <strong>Using the bundled channel list.</strong> {message ?? 'The iptv-org playlist could not be downloaded.'}
          </div>
        )}

        {nav === 'settings' ? (
          <SettingsView
            meta={meta}
            channels={channels}
            probeCount={probeCount}
            healthyCount={healthyCount}
            autoplay={autoplay}
            onAutoplayChange={setAutoplay}
            onReloadPlaylist={handleReload}
            reloading={reloading}
          />
        ) : (
          <>
            <CommandBar
              query={query}
              onQuery={setQuery}
              country={country}
              onCountry={(value) => {
                setCountry(value)
                setTab('all')
              }}
              sort={sort}
              onSort={setSort}
              countries={countries}
              total={nav === 'favorites' ? favorites.length : channels.length}
              shown={filtered.length}
              loading={status === 'loading' || reloading}
              onRefresh={handleReload}
              hideOffline={hideOffline}
              onHideOffline={setHideOffline}
              offlineCount={offlineCount}
            />

            {nav === 'live' && <PivotTabs items={pivots} active={tab} onChange={setTab} />}

            {starterHint ? (
              <div className="loading">
                <span className="spinner" aria-hidden="true" />
                <p>Fetching the iptv-org guide…</p>
              </div>
            ) : (
              <ChannelGrid
                channels={filtered}
                probes={probes}
                activeId={playing?.id ?? null}
                favorites={favorites}
                nowPlayingId={playing?.id ?? null}
                onPlay={openPlayer}
                onToggleFavorite={(channel) => toggle(channel.id)}
                emptyMessage={emptyMessage}
              />
            )}

            <footer className="app__footer">
              <span>
                {formatCount(channels.length)} channels · {formatCount(healthyCount)} of{' '}
                {formatCount(probeCount)} probed channels reachable
              </span>
              <span>{channels[0] ? primaryGroup('Fluent IPTV') : ''}</span>
            </footer>
          </>
        )}
      </main>

      {playing && (
        <Player
          channel={playing}
          probe={probes[playing.id]}
          favorite={isFavorite(playing.id)}
          onToggleFavorite={(channel) => toggle(channel.id)}
          onClose={() => setPlaying(null)}
          onSelect={openPlayer}
          suggestions={suggestions}
        />
      )}
    </div>
  )
}