import { useEffect, useRef, useState } from 'react'
import type { Channel, ProbeInfo } from '../lib/types'
import { ChannelCard } from './ChannelCard'

interface Props {
  channels: Channel[]
  probes: Record<string, ProbeInfo>
  activeId: string | null
  favorites: string[]
  nowPlayingId: string | null
  onPlay: (channel: Channel) => void
  onToggleFavorite: (channel: Channel) => void
  emptyMessage: string
}

/** Channels rendered per page; grows as the sentinel scrolls into view. */
const PAGE = 60;

/**
 * Virtualisation by paging.
 *
 * The playlist has ~11k channels; mounting them all would lock the webview up.
 * Cards are appended as the sentinel becomes visible, and CSS
 * `content-visibility` keeps off-screen cards cheap.
 */
export function ChannelGrid({
  channels,
  probes,
  activeId,
  favorites,
  nowPlayingId,
  onPlay,
  onToggleFavorite,
  emptyMessage,
}: Props) {
  const [limit, setLimit] = useState(PAGE)
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLimit(PAGE)
  }, [channels])

  useEffect(() => {
    const node = sentinel.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setLimit((current) => Math.min(current + PAGE, channels.length))
        }
      },
      { rootMargin: '1200px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [channels.length])

  if (channels.length === 0) {
    return (
      <div className="empty">
        <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
          <path
            d="M21 6h-7.6l3.3-3.3-1.4-1.4L9 7.6 5.7 1.3 4.3 2.7 7.6 6H3v12h18V6zm-2 10H5V8h14v8z"
            fill="currentColor"
          />
        </svg>
        <p>{emptyMessage}</p>
      </div>
    )
  }

  const visible = channels.slice(0, limit)

  return (
    <>
      <div className="grid">
        {visible.map((channel) => (
          <ChannelCard
            key={channel.id}
            channel={channel}
            probe={probes[channel.id]}
            active={channel.id === activeId}
            favorite={favorites.includes(channel.id)}
            nowPlaying={channel.id === nowPlayingId}
            onPlay={onPlay}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
      </div>
      <div ref={sentinel} className="grid__sentinel" aria-hidden="true">
        {limit < channels.length && (
          <span>Showing {visible.length} of {channels.length}</span>
        )}
      </div>
    </>
  )
}