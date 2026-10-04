import { useEffect, useState } from 'react'
import { logoSrc } from '../lib/api'

interface Props {
  channel: string
  logo?: string
  className?: string
}

/**
 * Channel logo with a deterministic monogram fallback.
 *
 * Roughly a fifth of the iptv-org logo URLs are dead, and a broken image icon on
 * a card looks broken — so a failed load swaps to a generated mark instead.
 */
export function ChannelLogo({ channel, logo, className }: Props) {
  const [failed, setFailed] = useState(false)

  // A new channel gets a fresh chance at its logo.
  useEffect(() => {
    setFailed(false)
  }, [logo])

  const initials = channel
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')

  if (!logo || failed) {
    return (
      <div className={`logo logo--fallback ${className ?? ''}`} aria-hidden="true">
        <span>{initials || 'TV'}</span>
      </div>
    )
  }

  return (
    <img
      className={`logo ${className ?? ''}`}
      src={logoSrc(logo)}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      // The backend answers a dead logo with a 1x1 transparent PNG so the page
      // logs no network errors; that is a "no logo" signal, not a logo.
      onLoad={(event) => {
        if (event.currentTarget.naturalWidth <= 1) setFailed(true)
      }}
    />
  )
}