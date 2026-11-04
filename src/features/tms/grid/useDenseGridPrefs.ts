/**
 * What a person customised on a dense grid, kept per user and per grid in localStorage:
 * which columns, in which order, how wide, the density, the sort, the group-by and whether the
 * summary strip is open. The Shipments board's column templates (server side, shareable) feed
 * the same state through `applyLayout`, so a template and a hand-made layout are one thing.
 */
import { useCallback, useState } from 'react'
import type { DenseDensity, DenseSort } from './denseGridModel'

export interface DensePrefs {
  /** Visible column keys, in order. */
  columns: string[]
  widths: Record<string, number>
  /** Leading columns pinned (sticky) in addition to the first one. */
  pinned: string[]
  density: DenseDensity
  sort: DenseSort | null
  groupBy: string | null
  kpiOpen: boolean
}

export interface UseDensePrefsOptions {
  /** Which grid: `shipments`, `tracking`, `intake`. */
  gridId: string
  email: string | null | undefined
  defaultColumns: readonly string[]
  /** Every key the grid can render; stored keys outside it are dropped (a retired column). */
  validKeys: readonly string[]
  defaultSort: DenseSort | null
  defaultGroupBy?: string | null
}

export interface UseDensePrefsResult extends DensePrefs {
  setColumns: (columns: string[]) => void
  setWidth: (key: string, width: number) => void
  /**
   * A template or the Columns dialog: columns and pins at once. Widths merge into the user's own
   * (a template overrides only the widths it sets); `replaceWidths` is the dialog's Apply,
   * which hands back the complete set (Reset widths = an empty one).
   */
  applyLayout: (layout: { columns: string[]; widths: Record<string, number>; pinned: string[]; replaceWidths?: boolean }) => void
  setDensity: (density: DenseDensity) => void
  setSort: (sort: DenseSort | null) => void
  setGroupBy: (groupBy: string | null) => void
  setKpiOpen: (open: boolean) => void
  resetColumns: () => void
}

const VERSION = 1

export function densePrefsKey(gridId: string, email: string | null | undefined): string {
  return `tms:grid:${gridId}:${email ?? 'anon'}:v${VERSION}`
}

function read(key: string, opts: UseDensePrefsOptions): DensePrefs {
  const defaults: DensePrefs = {
    columns: [...opts.defaultColumns],
    widths: {},
    pinned: [],
    density: 'compact',
    sort: opts.defaultSort,
    groupBy: opts.defaultGroupBy ?? null,
    kpiOpen: false,
  }
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return defaults
    const stored = JSON.parse(raw) as Partial<DensePrefs>
    const valid = new Set(opts.validKeys)
    const columns = Array.isArray(stored.columns) ? stored.columns.filter((k) => valid.has(k)) : []
    return {
      columns: columns.length > 0 ? columns : defaults.columns,
      widths: stored.widths && typeof stored.widths === 'object' ? stored.widths : {},
      pinned: Array.isArray(stored.pinned) ? stored.pinned.filter((k) => columns.includes(k)) : [],
      density: stored.density === 'comfortable' ? 'comfortable' : 'compact',
      sort: stored.sort === undefined ? defaults.sort : stored.sort,
      groupBy: stored.groupBy === undefined ? defaults.groupBy : stored.groupBy,
      kpiOpen: stored.kpiOpen === true,
    }
  } catch {
    return defaults
  }
}

export function useDenseGridPrefs(opts: UseDensePrefsOptions): UseDensePrefsResult {
  const key = densePrefsKey(opts.gridId, opts.email)
  const [state, setState] = useState(() => ({ key, prefs: read(key, opts) }))
  // A different user signing in on the same browser gets their own layout.
  let current = state
  if (state.key !== key) {
    current = { key, prefs: read(key, opts) }
    setState(current)
  }

  const update = useCallback(
    (patch: (prev: DensePrefs) => DensePrefs) => {
      setState((prev) => {
        const prefs = patch(prev.prefs)
        try {
          window.localStorage.setItem(prev.key, JSON.stringify(prefs))
        } catch {
          /* private mode: the layout lasts for the session */
        }
        return { key: prev.key, prefs }
      })
    },
    [],
  )

  const defaultColumns = opts.defaultColumns
  return {
    ...current.prefs,
    setColumns: useCallback((columns) => update((p) => ({ ...p, columns, pinned: p.pinned.filter((k) => columns.includes(k)) })), [update]),
    setWidth: useCallback((k, width) => update((p) => ({ ...p, widths: { ...p.widths, [k]: width } })), [update]),
    applyLayout: useCallback(
      (layout) =>
        update((p) => ({
          ...p,
          columns: layout.columns,
          pinned: layout.pinned,
          widths: layout.replaceWidths ? { ...layout.widths } : { ...p.widths, ...layout.widths },
        })),
      [update],
    ),
    setDensity: useCallback((density) => update((p) => ({ ...p, density })), [update]),
    setSort: useCallback((sort) => update((p) => ({ ...p, sort })), [update]),
    setGroupBy: useCallback((groupBy) => update((p) => ({ ...p, groupBy })), [update]),
    setKpiOpen: useCallback((kpiOpen) => update((p) => ({ ...p, kpiOpen })), [update]),
    resetColumns: useCallback(
      () => update((p) => ({ ...p, columns: [...defaultColumns], widths: {}, pinned: [] })),
      [update, defaultColumns],
    ),
  }
}
