import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'fluent-iptv:favorites'

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Favourite channels, persisted across restarts. */
export function useFavorites() {
  const [favorites, setFavorites] = useState<string[]>(read)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites))
    } catch {
      /* private mode / quota: favourites simply do not persist */
    }
  }, [favorites])

  const toggle = useCallback((id: string) => {
    setFavorites((current) =>
      current.includes(id) ? current.filter((f) => f !== id) : [...current, id],
    )
  }, [])

  const isFavorite = useCallback((id: string) => favorites.includes(id), [favorites])

  return { favorites, toggle, isFavorite }
}