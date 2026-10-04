import { useEffect, useRef } from 'react'

export interface PivotItem {
  key: string
  label: string
  count: number
}

interface Props {
  items: PivotItem[]
  active: string
  onChange: (key: string) => void
}

/** WinUI-style Pivot tabs: label row with a floating accent underline. */
export function PivotTabs({ items, active, onChange }: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // Keep the selected tab visible when the strip overflows.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [active])

  return (
    <div className="pivot" role="tablist" ref={listRef}>
      {items.map((item) => {
        const selected = item.key === active
        return (
          <button
            key={item.key}
            ref={selected ? activeRef : undefined}
            role="tab"
            aria-selected={selected}
            className={`pivot__tab${selected ? ' pivot__tab--active' : ''}`}
            onClick={() => onChange(item.key)}
          >
            <span className="pivot__label">{item.label}</span>
            <span className="pivot__count">{item.count}</span>
          </button>
        )
      })}
    </div>
  )
}