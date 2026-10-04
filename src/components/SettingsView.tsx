import type { Channel, Meta } from '../lib/types'
import { formatCount } from '../lib/format'

interface Props {
  meta: Meta | null
  channels: Channel[]
  probeCount: number
  healthyCount: number
  autoplay: boolean
  onAutoplayChange: (value: boolean) => void
  onReloadPlaylist: () => void
  reloading: boolean
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="settings__row">
      <span className="settings__label">{label}</span>
      <span className={`settings__value${tone ? ` settings__value--${tone}` : ''}`}>{value}</span>
    </div>
  )
}

export function SettingsView({
  meta,
  channels,
  probeCount,
  healthyCount,
  autoplay,
  onAutoplayChange,
  onReloadPlaylist,
  reloading,
}: Props) {
  const ffmpegTone = !meta ? undefined : meta.ffmpegOk ? 'good' : 'bad'

  return (
    <section className="settings">
      <header className="view__header">
        <h1>Settings</h1>
        <p className="view__subtitle">Pipeline diagnostics for the local ffmpeg backend.</p>
      </header>

      <div className="settings__grid">
        <article className="panel">
          <h2>Playback engine</h2>
          <Row label="Status" value={meta?.ffmpegOk ? 'Ready' : 'Unavailable'} tone={ffmpegTone} />
          <Row label="Binary" value={meta?.ffmpegPath ?? 'resolving…'} />
          <Row label="Version" value={meta?.ffmpegVersion ?? 'unknown'} />
          <Row label="Media server port" value={meta ? String(meta.port) : '—'} />
        </article>

        <article className="panel">
          <h2>Playlist</h2>
          <Row
            label="Source"
            value={meta?.playlistStatus === 'fallback' ? 'bundled fallback' : (meta?.playlistUrl ?? '—')}
            tone={meta?.playlistStatus === 'fallback' ? 'warn' : 'good'}
          />
          <Row label="Channels" value={formatCount(meta?.channelCount ?? channels.length)} />
          <Row label="Verified starters" value={formatCount(meta?.featuredCount ?? 0)} />
          <div className="settings__actions">
            <button
              type="button"
              className="button button--accent"
              onClick={onReloadPlaylist}
              disabled={reloading}
            >
              {reloading ? 'Reloading…' : 'Reload playlist'}
            </button>
          </div>
        </article>

        <article className="panel">
          <h2>Stream health</h2>
          <Row label="Probed" value={formatCount(probeCount)} />
          <Row
            label="Reachable"
            value={formatCount(healthyCount)}
            tone={healthyCount > 0 ? 'good' : undefined}
          />
          <p className="settings__note">
            Roughly half of the community playlist is offline at any moment, which is why
            every card carries a live health dot and failures offer the next channel.
          </p>
        </article>

        <article className="panel">
          <h2>Playback</h2>
          <label className="toggle">
            <input
              type="checkbox"
              checked={autoplay}
              onChange={(event) => onAutoplayChange(event.target.checked)}
            />
            <span>Start playing on launch</span>
          </label>
          <p className="settings__note">
            Starts on a verified channel. Audio begins muted if the browser autoplay policy
            requires a gesture.
          </p>
          <ul className="settings__keys">
            <li><kbd>Space</kbd> play / pause</li>
            <li><kbd>M</kbd> mute</li>
            <li><kbd>↑</kbd><kbd>↓</kbd> volume</li>
            <li><kbd>F</kbd> fullscreen</li>
            <li><kbd>Esc</kbd> back to the guide</li>
          </ul>
        </article>
      </div>
    </section>
  )
}