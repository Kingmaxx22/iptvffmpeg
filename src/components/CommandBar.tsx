import { useMemo } from 'react'
import { countryFlag, countryName, formatCount } from '../lib/format'

export type SortKey = 'name' | 'country' | 'health'

interface Props {
  query: string
  onQuery: (value: string) => void
  country: string
  onCountry: (value: string) => void
  sort: SortKey
  onSort: (value: SortKey) => void
  countries: { code: string; count: number }[]
  total: number
  shown: number
  loading: boolean
  onRefresh: () => void
  hideOffline: boolean
  onHideOffline: (value: boolean) => void
  offlineCount: number
}

export function CommandBar({
  query,
  onQuery,
  country,
  onCountry,
  sort,
  onSort,
  countries,
  total,
  shown,
  loading,
  onRefresh,
  hideOffline,
  onHideOffline,
  offlineCount,
}: Props) {
  const summary = useMemo(
    () => `${formatCount(shown)} of ${formatCount(total)} channels`,
    [shown, total],
  )

  return (
    <header className="commandbar">
      <div className="commandbar__row">
        <div className="search">
          <svg className="search__icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"
              fill="currentColor"
            />
          </svg>
          <input
            className="search__input"
            type="search"
            value={query}
            placeholder="Search channels, countries, categories"
            aria-label="Search channels"
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>

        <label className="select">
          <span className="select__label">Country</span>
          <select
            className="select__control"
            value={country}
            onChange={(event) => onCountry(event.target.value)}
            aria-label="Filter by country"
          >
            <option value="">All countries</option>
            {countries.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {countryFlag(entry.code)} {entry.code} · {countryName(entry.code)} ({entry.count})
              </option>
            ))}
          </select>
        </label>

        <label className="select">
          <span className="select__label">Sort</span>
          <select
            className="select__control"
            value={sort}
            onChange={(event) => onSort(event.target.value as SortKey)}
            aria-label="Sort channels"
          >
            <option value="name">Name</option>
            <option value="country">Country</option>
            <option value="health">Health</option>
          </select>
        </label>

        <button
          type="button"
          className={`button button--toggle${hideOffline ? ' is-on' : ''}`}
          onClick={() => onHideOffline(!hideOffline)}
          aria-pressed={hideOffline}
          title={
            hideOffline
              ? 'Offline channels are hidden. Click to show them.'
              : 'Offline channels are visible. Click to hide them.'
          }
        >
          <span className="dot dot--offline" aria-hidden="true" />
          Hide offline
          {offlineCount > 0 && <span className="button__count">{offlineCount}</span>}
        </button>

        <button
          type="button"
          className="button button--icon"
          onClick={onRefresh}
          disabled={loading}
          title="Reload the iptv-org playlist"
          aria-label="Reload playlist"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.1A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
      <p className="commandbar__summary">{summary}</p>
    </header>
  )
}