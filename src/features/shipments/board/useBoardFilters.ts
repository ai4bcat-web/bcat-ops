/**
 * The one filter brain the Shipments board and the three workstation pages share.
 *
 * Dispatch, Tracking and Documents are not boards — each has its own purpose-built
 * body — but they all narrow the same shipment list with the same left panel and the
 * same saved views, so the narrowing lives here once. The hook owns the working filter
 * set, hydrates it from the active saved view, builds the facet options the type-ahead
 * pickers search, and hands back a ready `BoardFilterPanelProps`; the page owns only
 * its own body.
 *
 * Nothing in here renders. Nothing in here fetches rows — the caller passes the rows it
 * already has, so a page never pays for a second read of the same list.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'

import type { BoardFilterPanelProps } from './BoardFilterPanel'
import type { BoardDateKey, BoardDetailDef } from './types'
import { archiveShipmentView, saveShipmentView } from '@/lib/apiClient'
import { ME_SENTINEL, MY_TEAM_SENTINEL, slugify } from '@/lib/shipmentViewDefs'
import {
  EMPTY_BOARD_FILTER_SET,
  boardFilterCount,
  boardFiltersEqual,
  boardStatusCounts,
  detailOptions,
  matchesBoardFilters,
  matchesQuery,
  type BoardDetailKey,
  type BoardFilterSet,
  type BoardStatusKey,
  type ShipmentRow,
} from '../shipmentViews'
import type { CustomerRecord, ShipmentViewRecord, Team, UserProfileRecord } from '@/types/tms'

/** The fifteen Details facets, in the order Aljex lists them. */
export const DETAIL_LABELS: Record<BoardDetailKey, string> = {
  customer: 'Customer',
  carrier: 'Carrier',
  pickupName: 'Pick Up Name',
  consigneeName: 'Consignee Name',
  fromStates: 'From States',
  toStates: 'To States',
  revenueType: 'Revenue Types',
  equipment: 'Equip Type',
  office: 'Office (team)',
  fromRegion: 'From Region',
  toRegion: 'To Region',
  salesRep: 'Sales Rep',
  serviceRep: 'Service Rep',
  dispatcherAssigned: 'Dispatcher Assigned',
  dispatcherActual: 'Dispatcher Actual',
}

const STAFF_KEYS: BoardDetailKey[] = ['salesRep', 'serviceRep', 'dispatcherAssigned', 'dispatcherActual']

export const BOARD_STATUS_ORDER: BoardStatusKey[] = [
  'OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED', 'DELIVERED', 'HOLD', 'RESERVED', 'VOIDED',
]

export interface UseBoardFiltersOptions {
  /** Every row the page may show, before search and before filters. */
  rows: readonly ShipmentRow[]
  customers: readonly CustomerRecord[]
  /** Resolves a user-profile id to a name for the rep facets. */
  staffNameOf: (id: string | null | undefined) => string
  /** The saved views this caller may see. */
  views: readonly ShipmentViewRecord[]
  /** The active view's slug, '' for none. */
  viewSlug: string
  onSelectView: (slug: string) => void
  /** Re-read the views after a save or an archive. */
  onViewsChanged?: () => void
  /** Opens the page's own "Save as view" dialog. */
  onCreateView?: () => void
  /** Namespace for the collapse flag and the recently-used values. */
  storageKey: string
  /**
   * What this page shows before anybody filters it — the workstation's reason to
   * exist (Tracking starts on freight that is moving). Reset Filters comes back here.
   */
  baseFilters?: BoardFilterSet
  /**
   * The board keeps its search in the URL so a link reproduces the list. Pass the
   * value and the setter to control it; leave both out and the hook holds it.
   */
  query?: string
  onQueryChange?: (value: string) => void
  /**
   * Step P2. Who is looking, so the seeded My queue / Team queue views can mean
   * "mine" without a view per rep. The sentinels are resolved only when the rows
   * are matched — the saved filter set keeps `@me`, so it still round-trips and
   * still means the same thing for the next person who opens it.
   */
  viewer?: { userId: string | null; teamRepIds: readonly string[] }
}

export interface UseBoardFiltersResult {
  query: string
  setQuery: (value: string) => void
  filters: BoardFilterSet
  setFilters: Dispatch<SetStateAction<BoardFilterSet>>
  /** Rows after search only — what the status counts are drawn from. */
  queryRows: ShipmentRow[]
  /** Rows after search and filters: what the page renders. */
  rows: ShipmentRow[]
  statusCounts: Record<BoardStatusKey, number>
  detailDefs: BoardDetailDef[]
  collapsed: boolean
  setCollapsed: (next: boolean) => void
  dirty: boolean
  activeView: ShipmentViewRecord | null
  /** Persist the current filters onto the active view. */
  saveView: () => Promise<void>
  /** Create a new saved view from the current filters. */
  createView: (name: string, shared: boolean, columns?: string[]) => Promise<void>
  panelProps: BoardFilterPanelProps
}

function readCollapsed(key: string): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(`${key}:collapsed`) === 'true'
}

/**
 * Turn the signed-in user's profile and the org's team roster into the ids that
 * `@myteam` resolves to. A viewer on no team gets an empty list, so `@myteam`
 * honestly matches nothing rather than silently widening to the whole board.
 */
export function teamRepIdsFor(
  me: UserProfileRecord | null,
  teams: readonly Team[] | null | undefined,
): readonly string[] {
  if (!me?.teamKeys?.length || !teams?.length) return []
  const myTeamKeys = new Set(me.teamKeys)
  const ids = new Set<string>()
  for (const team of teams) {
    if (myTeamKeys.has(team.key)) {
      for (const id of team.memberIds) ids.add(id)
    }
  }
  return [...ids]
}

export function resolveQueueSentinels(
  filters: BoardFilterSet,
  viewer: { userId: string | null; teamRepIds: readonly string[] } | undefined,
): BoardFilterSet {
  const details = filters.details ?? {}
  let touched = false
  const next: typeof details = { ...details }
  for (const key of ['dispatcherAssigned', 'dispatcherActual'] as const) {
    const facet = details[key]
    if (!facet?.values?.some((v) => v === ME_SENTINEL || v === MY_TEAM_SENTINEL)) continue
    touched = true
    const expanded: string[] = []
    for (const value of facet.values) {
      if (value === ME_SENTINEL) {
        if (viewer?.userId) expanded.push(viewer.userId)
      } else if (value === MY_TEAM_SENTINEL) {
        expanded.push(...(viewer?.teamRepIds ?? []))
      } else {
        expanded.push(value)
      }
    }
    // `NO_MATCH` is not a Cognito username, so an unresolved queue shows nothing
    // rather than quietly widening to the whole board.
    next[key] = { ...facet, values: expanded.length ? [...new Set(expanded)] : ['\u0000NO_MATCH'] }
  }
  return touched ? { ...filters, details: next } : filters
}


export function useBoardFilters(options: UseBoardFiltersOptions): UseBoardFiltersResult {
  const {
    rows: allRows,
    customers,
    staffNameOf,
    views,
    viewSlug,
    onSelectView,
    onViewsChanged,
    onCreateView,
    storageKey,
  } = options
  const baseFilters = options.baseFilters ?? EMPTY_BOARD_FILTER_SET

  const [ownQuery, setOwnQuery] = useState('')
  const query = options.query ?? ownQuery
  const setQuery = options.onQueryChange ?? setOwnQuery
  const activeView = useMemo(
    () => views.find((v) => v.slug === viewSlug) ?? null,
    [views, viewSlug],
  )
  const savedFilters = useMemo<BoardFilterSet>(
    () => activeView?.filters?.board ?? baseFilters,
    [activeView, baseFilters],
  )

  const [filters, setFilters] = useState<BoardFilterSet>(() => savedFilters)

  // The views hook resolves after the first render, so the lazy initializer above can
  // capture the stub. Re-hydrate whenever the view identity changes — and only then,
  // so a poll that returns the same view never clobbers edits in progress.
  const hydratedRef = useRef<string | null>(null)
  useEffect(() => {
    const nextId = activeView?.id ?? null
    if (nextId === hydratedRef.current) return
    hydratedRef.current = nextId
    setFilters(savedFilters)
  }, [activeView, savedFilters])

  const [collapsed, setCollapsedState] = useState(() => readCollapsed(storageKey))
  const setCollapsed = useCallback(
    (next: boolean) => {
      setCollapsedState(next)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(`${storageKey}:collapsed`, String(next))
      }
    },
    [storageKey],
  )

  const queryRows = useMemo(() => {
    if (!query) return [...allRows]
    return allRows.filter((r) => matchesQuery(r, query))
  }, [allRows, query])

  const rows = useMemo(() => {
    const now = new Date()
    // Resolve `@me` / `@myteam` here rather than in `filters`: the panel, the dirty
    // check and the save all keep the sentinel, so a shared queue view still means
    // "mine" for whoever opens it next.
    const applied = resolveQueueSentinels(filters, options.viewer)
    return queryRows.filter((r) => matchesBoardFilters(r, applied, now))
  }, [queryRows, filters, options.viewer])

  const statusCounts = useMemo(() => boardStatusCounts(queryRows), [queryRows])

  const detailDefs = useMemo<BoardDetailDef[]>(() => {
    const labels: Record<string, string> = {}
    for (const c of customers) labels[c.id] = c.name
    return (Object.keys(DETAIL_LABELS) as BoardDetailKey[]).map((key) => {
      const options = detailOptions(queryRows, key).map((opt) => {
        let label = opt.value
        if (key === 'customer') label = labels[opt.value] ?? opt.value
        if (STAFF_KEYS.includes(key)) label = staffNameOf(opt.value)
        return { ...opt, label }
      })
      return { key, label: DETAIL_LABELS[key], options }
    })
  }, [queryRows, customers, staffNameOf])

  const dirty = useMemo(() => !boardFiltersEqual(filters, savedFilters), [filters, savedFilters])

  const setDetail = useCallback((key: BoardDetailKey, values: string[]) => {
    setFilters((prev) => {
      const details = { ...(prev.details ?? {}) }
      const exclude = details[key]?.exclude ?? false
      if (values.length === 0) delete details[key]
      else details[key] = { values, exclude }
      return { ...prev, details }
    })
  }, [])

  const setDetailExclude = useCallback((key: BoardDetailKey, exclude: boolean) => {
    setFilters((prev) => {
      const details = { ...(prev.details ?? {}) }
      const current = details[key]
      if (!current) return prev
      details[key] = { ...current, exclude }
      return { ...prev, details }
    })
  }, [])

  const toggleStatus = useCallback((status: BoardStatusKey) => {
    setFilters((prev) => {
      const current = prev.statuses ?? []
      const next = current.includes(status)
        ? current.filter((s) => s !== status)
        : [...current, status]
      return { ...prev, statuses: next }
    })
  }, [])

  const setDate = useCallback((key: BoardDateKey, filter: BoardFilterSet['dates'][BoardDateKey]) => {
    setFilters((prev) => {
      const dates = { ...(prev.dates ?? {}) }
      if (!filter || (filter.mode === 'FIXED' ? !filter.date : !filter.from && !filter.to)) delete dates[key]
      else dates[key] = filter
      return { ...prev, dates }
    })
  }, [])

  const setFlag = useCallback(
    (key: keyof NonNullable<BoardFilterSet['flags']>, checked: boolean) => {
      setFilters((prev) => {
        const flags = { ...(prev.flags ?? {}) }
        if (checked) flags[key] = true
        else delete flags[key]
        return { ...prev, flags }
      })
    },
    [],
  )

  const saveView = useCallback(async () => {
    if (!activeView) return
    try {
      await saveShipmentView({
        id: activeView.id,
        name: activeView.name,
        slug: activeView.slug,
        department: activeView.department,
        description: activeView.description,
        filters: { ...activeView.filters, board: filters },
        columns: activeView.columns,
        sort: activeView.sort,
        isDefault: activeView.isDefault,
        audience: activeView.audience,
        sortOrder: activeView.sortOrder,
        active: activeView.active,
      })
      toast.success('View saved')
      onViewsChanged?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    }
  }, [activeView, filters, onViewsChanged])

  const createView = useCallback(
    async (name: string, shared: boolean, columns?: string[]) => {
      const saved = await saveShipmentView({
        name,
        slug: slugify(name),
        department: activeView?.department ?? null,
        description: null,
        filters: { board: filters },
        columns: columns ?? activeView?.columns ?? null,
        sort: activeView?.sort ?? null,
        isDefault: false,
        audience: shared ? null : { groups: [], roles: [], divisions: [] },
        sortOrder: (activeView?.sortOrder ?? 0) + 1,
        active: true,
      })
      onViewsChanged?.()
      onSelectView(saved.slug)
    },
    [activeView, filters, onSelectView, onViewsChanged],
  )

  const revert = useCallback(() => setFilters(savedFilters), [savedFilters])

  const remove = useCallback(async () => {
    if (!activeView) return
    try {
      await archiveShipmentView({ id: activeView.id })
      toast.success('View archived')
      onViewsChanged?.()
      onSelectView('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Archive failed')
    }
  }, [activeView, onSelectView, onViewsChanged])

  const panelProps = useMemo<BoardFilterPanelProps>(
    () => ({
      collapsed,
      onToggleCollapse: () => setCollapsed(!collapsed),
      viewName: activeView?.name ?? 'All shipments',
      filterSets: views.map((v) => ({ id: v.slug, name: v.name, isDefault: v.isDefault })),
      activeFilterSetId: viewSlug || null,
      filterSetDirty: dirty,
      onSelectFilterSet: onSelectView,
      onCreateFilterSet: onCreateView ?? (() => {}),
      onUpdateFilterSet: () => { void saveView() },
      onRevertFilterSet: revert,
      onDeleteFilterSet: () => { void remove() },
      statuses: BOARD_STATUS_ORDER,
      statusCounts,
      selectedStatuses: filters.statuses ?? [],
      onToggleStatus: toggleStatus,
      detailDefs,
      detailFilters: filters.details ?? {},
      onDetailChange: setDetail,
      onDetailExcludeChange: setDetailExclude,
      dateFilters: filters.dates ?? {},
      onDateChange: setDate,
      flags: filters.flags,
      onFlagChange: setFlag,
      onClearFilters: () => setFilters(EMPTY_BOARD_FILTER_SET),
      onResetFilters: () => setFilters(baseFilters),
      activeFilterCount: boardFilterCount(filters),
      recentStorageKey: storageKey,
    }),
    [
      collapsed, setCollapsed, activeView, views, viewSlug, dirty, onSelectView, onCreateView,
      saveView, revert, remove, statusCounts, filters, toggleStatus, detailDefs, setDetail,
      setDetailExclude, setDate, setFlag, baseFilters, storageKey,
    ],
  )

  return {
    query,
    setQuery,
    filters,
    setFilters,
    queryRows,
    rows,
    statusCounts,
    detailDefs,
    collapsed,
    setCollapsed,
    dirty,
    activeView,
    saveView,
    createView,
    panelProps,
  }
}
