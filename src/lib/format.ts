/** Small display helpers shared across the UI. */

const regionNames =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null

export function countryFlag(code?: string): string {
  if (!code || code.length !== 2) return '🌐'
  const upper = code.toUpperCase()
  const base = 0x1f1e6
  const first = upper.codePointAt(0)
  const second = upper.codePointAt(1)
  if (first === undefined || second === undefined) return '🌐'
  return String.fromCodePoint(base + (first - 65), base + (second - 65))
}

/**
 * Windows has no flag emoji: regional indicator pairs render as plain letters,
 * which would duplicate the ISO code shown next to them.
 */
export function supportsFlagEmoji(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
  return !/win/i.test(platform)
}

export function countryName(code?: string): string {
  if (!code) return 'International'
  if (!regionNames) return code
  try {
    return regionNames.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

export function formatBitrate(kbps?: number | null): string | null {
  if (!kbps || kbps <= 0) return null
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`
  return `${Math.round(kbps)} kbps`
}

export function resolutionTier(width?: number, height?: number): string | null {
  if (!width || !height) return null
  const longEdge = Math.max(width, height)
  if (longEdge >= 3400) return '4K'
  if (longEdge >= 1600) return 'FHD'
  if (longEdge >= 1000) return 'HD'
  if (longEdge >= 600) return 'SD'
  return 'LD'
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** `Entertainment;Family;General` -> the first, human-friendly group. */
export function primaryGroup(group: string): string {
  return group.split(';')[0]?.trim() || 'General'
}

export function groupList(group: string): string[] {
  return group
    .split(';')
    .map((g) => g.trim())
    .filter(Boolean)
}