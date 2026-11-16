/**
 * The owner's column layout per dense grid, shared with everyone (Ryne 2026-11-16: "any time I update
 * columns" it applies to all users). Stored as a ShipmentColumnTemplate row with a reserved id
 * (`grid-default:<gridId>`), written only by the owner (SAVE_COLUMN_TEMPLATE refuses anyone else for
 * these ids) and read by every signed-in user. Each person still customises their own layout; a newer
 * owner layout replaces it once (see useDenseGridPrefs `orgSeenAt`).
 */
import { useSyncExternalStore } from 'react'
import { listShipmentColumnTemplates, saveShipmentColumnTemplate } from '@/lib/apiClient'

export const GRID_DEFAULT_PREFIX = 'grid-default:'

export function orgGridDefaultId(gridId: string): string {
  return `${GRID_DEFAULT_PREFIX}${gridId}`
}

export interface OrgGridLayout {
  columns: string[]
  widths: Record<string, number>
  pinned: string[]
  updatedAt: string
}

type Store = Map<string, OrgGridLayout>

let store: Store = new Map()
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** Normalises a stored template row into a layout (bad shapes drop to null). */
export function layoutFromTemplate(row: { columns?: unknown; widths?: unknown; pinned?: unknown; updatedAt?: unknown }): OrgGridLayout | null {
  if (!Array.isArray(row.columns)) return null
  const columns = row.columns.filter((k): k is string => typeof k === 'string')
  if (columns.length === 0) return null
  const widths: Record<string, number> = {}
  if (row.widths && typeof row.widths === 'object') {
    for (const [k, v] of Object.entries(row.widths as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) widths[k] = v
    }
  }
  const pinned = Array.isArray(row.pinned) ? row.pinned.filter((k): k is string => typeof k === 'string' && columns.includes(k)) : []
  return { columns, widths, pinned, updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '' }
}

function load(): void {
  if (loading) return
  let request: ReturnType<typeof listShipmentColumnTemplates>
  try {
    request = listShipmentColumnTemplates()
  } catch {
    // No backend (tests with a partial client mock, an older stack): personal layouts only.
    loading = Promise.resolve()
    return
  }
  loading = Promise.resolve(request)
    .then((rows) => {
      const next: Store = new Map()
      for (const row of rows) {
        const id = String((row as { id?: unknown }).id ?? '')
        if (!id.startsWith(GRID_DEFAULT_PREFIX)) continue
        const layout = layoutFromTemplate(row as Parameters<typeof layoutFromTemplate>[0])
        if (layout) next.set(id.slice(GRID_DEFAULT_PREFIX.length), layout)
      }
      store = next
      emit()
    })
    .catch(() => {
      /* offline / no model: personal layouts only */
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  load()
  return () => listeners.delete(listener)
}

/** The owner's shared layout for `gridId`, or null while loading / when none was saved. */
export function useOrgGridDefault(gridId: string): OrgGridLayout | null {
  return useSyncExternalStore(subscribe, () => store.get(gridId) ?? null, () => null)
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * The owner changed `gridId`'s columns: save them as everyone's layout. Debounced so a drag of a
 * column edge saves once. The cache updates right away (so the owner's own grid does not snap back)
 * and again with the server's updatedAt once saved.
 */
export function publishOrgGridDefault(
  gridId: string,
  layout: { columns: string[]; widths: Record<string, number>; pinned: string[] },
  onSaved?: (updatedAt: string) => void,
  delayMs = 700,
): void {
  const existing = pending.get(gridId)
  if (existing) clearTimeout(existing)
  pending.set(
    gridId,
    setTimeout(() => {
      pending.delete(gridId)
      saveShipmentColumnTemplate({
        id: orgGridDefaultId(gridId),
        name: `Default columns · ${gridId}`,
        columns: layout.columns,
        widths: layout.widths,
        pinned: layout.pinned.filter((k) => layout.columns.includes(k)),
        shared: true,
      })
        .then((saved) => {
          const updatedAt = String((saved as { updatedAt?: unknown } | null)?.updatedAt ?? new Date().toISOString())
          store = new Map(store)
          store.set(gridId, { ...layout, updatedAt })
          onSaved?.(updatedAt)
          emit()
        })
        .catch((err: unknown) => {
          console.warn('[grid] could not save the shared column layout', gridId, err)
        })
    }, delayMs),
  )
}

/** Test hook: forget the cache. */
export function __resetOrgGridDefaults(): void {
  store = new Map()
  loading = null
  for (const t of pending.values()) clearTimeout(t)
  pending.clear()
}
