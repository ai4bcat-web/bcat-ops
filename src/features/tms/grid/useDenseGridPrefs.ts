/**
 * What a person customised on a dense grid, kept per user and per grid in localStorage:
 * which columns, in which order, how wide, the density, the sort, the group-by and whether the
 * summary strip is open. The Shipments board's column templates (server side, shareable) feed
 * the same state through `applyLayout`, so a template and a hand-made layout are one thing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { isOwnerEmail } from '@/lib/auth/admin'
import type { DenseDensity, DenseSort } from './denseGridModel'
import { publishOrgGridDefault, useOrgGridDefault, type OrgGridLayout } from './orgGridDefault'

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
  /** Which width rule the saved `widths` were made under; older ones are dropped once so every column starts fitted again. */
  widthsFit?: number
  /** updatedAt of the owner's shared layout this person last took; a newer one replaces their columns once. */
  orgSeenAt?: string | null
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
  /**
   * Whether this grid takes part in the owner's shared layout (default true). The Shipments board
   * has its own team layout (teamColumnLayout.ts) and opts out.
   */
  shareLayout?: boolean
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
  /** True when this user's column changes become everyone's layout (the owner on a shared grid). */
  layoutSharedWithAll: boolean
}

const VERSION = 1
/** Bumped 2026-11-10 (columns auto-fit to what their cells show, measured from the page): saved widths from before it are discarded one time. */
const WIDTHS_FIT = 3

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
    widthsFit: WIDTHS_FIT,
  }
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return defaults
    const stored = JSON.parse(raw) as Partial<DensePrefs>
    const valid = new Set(opts.validKeys)
    const columns = Array.isArray(stored.columns) ? stored.columns.filter((k) => valid.has(k)) : []
    return {
      columns: columns.length > 0 ? columns : defaults.columns,
      widths: stored.widthsFit === WIDTHS_FIT && stored.widths && typeof stored.widths === 'object' ? stored.widths : {},
      widthsFit: WIDTHS_FIT,
      pinned: Array.isArray(stored.pinned) ? stored.pinned.filter((k) => columns.includes(k)) : [],
      density: stored.density === 'comfortable' ? 'comfortable' : 'compact',
      sort: stored.sort === undefined ? defaults.sort : stored.sort,
      groupBy: stored.groupBy === undefined ? defaults.groupBy : stored.groupBy,
      kpiOpen: stored.kpiOpen === true,
      orgSeenAt: typeof stored.orgSeenAt === 'string' ? stored.orgSeenAt : null,
    }
  } catch {
    return defaults
  }
}

/**
 * Whether `prefs` should take the owner's shared layout now. Everyone takes a layout newer than the
 * one they last took. The owner's own grid is the source, so it only takes the shared layout on a
 * device that never synced (otherwise a slow save could land on top of newer edits).
 */
export function shouldTakeOrgLayout(prefs: Pick<DensePrefs, 'orgSeenAt'>, org: OrgGridLayout | null, owner: boolean): boolean {
  if (!org || !org.updatedAt) return false
  if (owner) return !prefs.orgSeenAt
  return prefs.orgSeenAt !== org.updatedAt
}

/** `prefs` with the shared layout's columns, widths and pins (keys the grid no longer has are dropped). */
export function withOrgLayout(prefs: DensePrefs, org: OrgGridLayout, validKeys: readonly string[]): DensePrefs {
  const valid = new Set(validKeys)
  const columns = org.columns.filter((k) => valid.has(k))
  if (columns.length === 0) return { ...prefs, orgSeenAt: org.updatedAt }
  const widths = Object.fromEntries(Object.entries(org.widths).filter(([k]) => columns.includes(k)))
  return { ...prefs, columns, widths, pinned: org.pinned.filter((k) => columns.includes(k)), widthsFit: WIDTHS_FIT, orgSeenAt: org.updatedAt }
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

  // The owner's shared layout: take a newer one, and publish the owner's own column changes.
  const share = opts.shareLayout !== false
  const owner = share && isOwnerEmail(opts.email)
  const org = useOrgGridDefault(opts.gridId)
  // Taken during render, like the user switch above, so the grid never paints the stale layout first.
  if (share && org && shouldTakeOrgLayout(current.prefs, org, owner)) {
    current = { key: current.key, prefs: withOrgLayout(current.prefs, org, opts.validKeys) }
    setState(current)
    try {
      window.localStorage.setItem(current.key, JSON.stringify(current.prefs))
    } catch {
      /* private mode */
    }
  }

  const layoutDirty = useRef(false)
  const layoutUpdate = useCallback(
    (patch: (prev: DensePrefs) => DensePrefs) => {
      if (owner) layoutDirty.current = true
      update(patch)
    },
    [owner, update],
  )
  const gridId = opts.gridId
  const { columns: curColumns, widths: curWidths, pinned: curPinned } = current.prefs
  useEffect(() => {
    if (!owner || !layoutDirty.current) return
    layoutDirty.current = false
    publishOrgGridDefault(gridId, { columns: curColumns, widths: curWidths, pinned: curPinned }, (updatedAt) =>
      update((p) => ({ ...p, orgSeenAt: updatedAt })),
    )
  }, [owner, gridId, curColumns, curWidths, curPinned, update])

  const defaultColumns = opts.defaultColumns
  return {
    ...current.prefs,
    layoutSharedWithAll: owner,
    setColumns: useCallback((columns) => layoutUpdate((p) => ({ ...p, columns, pinned: p.pinned.filter((k) => columns.includes(k)) })), [layoutUpdate]),
    setWidth: useCallback((k, width) => layoutUpdate((p) => ({ ...p, widths: { ...p.widths, [k]: width } })), [layoutUpdate]),
    applyLayout: useCallback(
      (layout) =>
        layoutUpdate((p) => ({
          ...p,
          columns: layout.columns,
          pinned: layout.pinned,
          widths: layout.replaceWidths ? { ...layout.widths } : { ...p.widths, ...layout.widths },
        })),
      [layoutUpdate],
    ),
    setDensity: useCallback((density) => update((p) => ({ ...p, density })), [update]),
    setSort: useCallback((sort) => update((p) => ({ ...p, sort })), [update]),
    setGroupBy: useCallback((groupBy) => update((p) => ({ ...p, groupBy })), [update]),
    setKpiOpen: useCallback((kpiOpen) => update((p) => ({ ...p, kpiOpen })), [update]),
    resetColumns: useCallback(
      () => layoutUpdate((p) => ({ ...p, columns: [...defaultColumns], widths: {}, pinned: [] })),
      [layoutUpdate, defaultColumns],
    ),
  }
}
