/**
 * Pure ranking and recent-value persistence for type-ahead detail filters.
 *
 * The UI never shows a scrolling list of every facet value. Instead it asks this
 * module for the top-N matches for the current query and the recently-used values
 * when the query is empty. Persistence is SSR-safe localStorage keyed by facet.
 */

export interface DetailOption {
  value: string
  label: string
  count: number
  codes?: string[]
}

const DEFAULT_LIMIT = 8
const MAX_RECENTS = 8

function normalize(text: string): string {
  return text.trim().toLowerCase()
}

/**
 * Rank options for a type-ahead detail facet.
 *
 * Empty query: recents first (most recent first), then the remaining options by
 * count descending. Non-empty query: case-insensitive matches on label, value,
 * or any code entry, ranked exact-code, label-prefix, label-substring,
 * value-prefix, value-substring, code-substring; ties by count descending.
 */
export function rankDetailOptions(
  options: readonly DetailOption[],
  query: string,
  recent: readonly string[],
  limit: number = DEFAULT_LIMIT,
): DetailOption[] {
  const cap = limit
  const q = normalize(query)

  if (!q) {
    const recentSet = new Set(recent)
    const recentOptions: DetailOption[] = []
    for (const value of recent) {
      const opt = options.find((o) => o.value === value)
      if (opt && !recentOptions.some((o) => o.value === opt.value)) {
        recentOptions.push(opt)
      }
    }
    if (recentOptions.length === 0) return []
    const rest = options
      .filter((o) => !recentSet.has(o.value))
      .sort((a, b) => b.count - a.count)
    return [...recentOptions, ...rest].slice(0, cap)
  }

  const scored = options
    .map((option) => {
      const label = normalize(option.label)
      const value = normalize(option.value)
      const codes = (option.codes ?? []).map(normalize)

      let score: number | null = null

      if (codes.includes(q)) {
        score = 0
      } else if (label.startsWith(q)) {
        score = 1
      } else if (label.includes(q)) {
        score = 2
      } else if (value.startsWith(q)) {
        score = 3
      } else if (value.includes(q)) {
        score = 4
      } else if (codes.some((c) => c.includes(q))) {
        score = 5
      }

      if (score === null) return null
      return { option, score }
    })
    .filter((entry): entry is { option: DetailOption; score: number } => entry !== null)

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    return b.option.count - a.option.count
  })

  return scored.map((s) => s.option).slice(0, cap)
}

function recentKey(storageKey: string, facet: string): string {
  return `${storageKey}:recent:${facet}`
}

/** Read the persisted recent values for a facet, newest first. SSR-safe. */
export function readRecent(storageKey: string, facet: string): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(recentKey(storageKey, facet))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

/** Push a value to the front of the recent list for a facet. SSR-safe. */
export function pushRecent(storageKey: string, facet: string, value: string): void {
  if (typeof window === 'undefined') return
  try {
    const prev = readRecent(storageKey, facet)
    const next = [value, ...prev.filter((v) => v !== value)].slice(0, MAX_RECENTS)
    window.localStorage.setItem(recentKey(storageKey, facet), JSON.stringify(next))
  } catch {
    // Ignore quota / private-mode errors.
  }
}
