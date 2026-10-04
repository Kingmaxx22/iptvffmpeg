import { memo } from 'react'
import type { Channel, ProbeInfo } from '../lib/types'
import { countryFlag, countryName, formatBitrate, formatClock, supportsFlagEmoji } from '../lib/format'
import { ChannelLogo } from './ChannelLogo'

interface Props {
  channel: Channel
  probe?: ProbeInfo
  active: boolean
  favorite: boolean
  nowPlaying: boolean
  onPlay: (channel: Channel) => void
  onToggleFavorite: (channel: Channel) => void
}

function healthClass(probe?: ProbeInfo): string {
  if (!probe) return 'unknown'
  return probe.health
}

/**
 * Channel card: 16:9 media inset with the logo over a vignette, a LIVE pill, a
 * resolution badge, and a health dot fed by the backend probe.
 */
export const ChannelCard = memo(function ChannelCard({
  channel,
  probe,
  active,
  favorite,
  nowPlaying,
  onPlay,
  onToggleFavorite,
}: Props) {
  const group = channel.group.split(';')[0]?.trim() || 'General'
  const badge = probe?.width && probe?.height ? `${probe.height}p` : channel.resolution
  const bitrate = formatBitrate(probe?.bitrateKbps)
  const withFlag = supportsFlagEmoji()

  return (
    <article
      className={`card${active ? ' card--active' : ''}`}
      data-channel-id={channel.id}
      data-country={channel.country ?? ''}
      data-health={probe?.health ?? 'unknown'}
    >
      <button
        type="button"
        className="card__hit"
        onClick={() => onPlay(channel)}
        aria-label={`Watch ${channel.name}`}
        aria-current={active ? 'true' : undefined}
      >
        <div className="card__media">
          <div className="card__vignette" />
          <ChannelLogo channel={channel.name} logo={channel.logo} className="card__logo" />

          {nowPlaying && (
            <span className="live-pill" aria-label="Live now">
              <span className="live-pill__dot" />
              LIVE
            </span>
          )}

          {badge && <span className="badge badge--resolution">{badge}</span>}

          <div className="card__play" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22">
              <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
            </svg>
          </div>
        </div>

        <div className="card__body">
          <h3 className="card__title" title={channel.name}>
            {channel.name}
          </h3>
          <div className="card__meta">
            <span className="card__country" title={countryName(channel.country)}>
              {withFlag && <span aria-hidden="true">{countryFlag(channel.country)}</span>}
              {channel.country ?? 'INT'}
            </span>
            <span className="card__group" title={channel.group}>
              {group}
            </span>
            <span className={`dot dot--${healthClass(probe)}`} aria-hidden="true" />
            <span className="card__bitrate">
              {probe && !probe.ok
                ? 'offline'
                : probe?.latencyMs
                  ? `${probe.latencyMs} ms`
                  : bitrate ?? '—'}
            </span>
          </div>
        </div>
      </button>

      <button
        type="button"
        className={`card__fav${favorite ? ' card__fav--on' : ''}`}
        onClick={() => onToggleFavorite(channel)}
        aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
        aria-pressed={favorite}
      >
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path
            d="M12 20.3l-1.1-1C6 14.9 3 12.2 3 8.9 3 6.2 5.1 4 7.8 4c1.5 0 3 .7 4.2 2 1.2-1.3 2.7-2 4.2-2C18.9 4 21 6.2 21 8.9c0 3.3-3 6-7.9 10.4z"
            fill={favorite ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      </button>

      {channel.now && (
        <div className="card__epg">
          <span className="card__epg-title">{channel.now.title}</span>
          <span className="card__epg-time">{formatClock(channel.now.start)}</span>
        </div>
      )}
    </article>
  )
})