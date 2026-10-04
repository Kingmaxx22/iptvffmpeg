export type NavKey = 'live' | 'favorites' | 'settings'

interface Props {
  active: NavKey
  onChange: (key: NavKey) => void
  variant: 'bar' | 'rail' | 'pane'
  favoriteCount: number
}

const ITEMS: { key: NavKey; label: string; icon: JSX.Element }[] = [
  {
    key: 'live',
    label: 'Live TV',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          d="M21 6h-7.6l3.3-3.3-1.4-1.4L9 7.6 5.7 1.3 4.3 2.7 7.6 6H3v12h18V6zm-2 10H5V8h14v8z"
          fill="currentColor"
        />
      </svg>
    ),
  },
  {
    key: 'favorites',
    label: 'Favourites',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          d="M12 20.3l-1.1-1C6 14.9 3 12.2 3 8.9 3 6.2 5.1 4 7.8 4c1.5 0 3 .7 4.2 2 1.2-1.3 2.7-2 4.2-2C18.9 4 21 6.2 21 8.9c0 3.3-3 6-7.9 10.4z"
          fill="currentColor"
        />
      </svg>
    ),
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          d="M19.4 13a7.8 7.8 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1l-.4-2.7h-4l-.4 2.7a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L4.6 11a7.8 7.8 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.7h4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z"
          fill="currentColor"
        />
      </svg>
    ),
  },
]

/**
 * WinUI navigation surface: a fixed bottom bar on mobile, a compact rail on
 * tablet, and a full navigation pane on desktop.
 */
export function NavBar({ active, onChange, variant, favoriteCount }: Props) {
  if (variant === 'pane') {
    return (
      <nav className="navpane" aria-label="Primary">
        <div className="navpane__brand">
          <span className="navpane__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
            </svg>
          </span>
          <span>Fluent IPTV</span>
        </div>
        <ul className="navpane__list">
          {ITEMS.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className={`navpane__item${active === item.key ? ' is-active' : ''}`}
                onClick={() => onChange(item.key)}
                aria-current={active === item.key}
              >
                {item.icon}
                <span className="navpane__label">{item.label}</span>
                {item.key === 'favorites' && favoriteCount > 0 && (
                  <span className="navpane__count">{favoriteCount}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    )
  }

  return (
    <nav className={`navbar navbar--${variant}`} aria-label="Primary">
      <ul className="navbar__list">
        {ITEMS.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className={`navbar__item${active === item.key ? ' is-active' : ''}`}
              onClick={() => onChange(item.key)}
              aria-current={active === item.key}
            >
              <span className="navbar__icon">{item.icon}</span>
              <span className="navbar__label">{item.label}</span>
              {item.key === 'favorites' && favoriteCount > 0 && (
                <span className="navbar__count">{favoriteCount}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}