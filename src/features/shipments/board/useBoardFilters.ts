/**
 * The one filter brain the Shipments board and the Tracking desk share.
 *
 * Both narrow the same shipment list with the same left panel, so the narrowing lives
 * here once. The hook owns the working filter set, builds the facet options the
 * type-ahead pickers search, and hands back a ready `BoardFilterPanelProps`; the page
 * owns only its own body.
 *
 * Nothing in here renders. Nothing in here fetches rows — the caller passes the rows it
 * already has, so a page never pays for a second read of the same list.
 */
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react'

import type { BoardFilterPanelProps } from './BoardFilterPanel'
import type { BoardDateKey, BoardDetailDef } from './types'
import {
  EMPTY_BOARD_FILTER_SET,
  boardFilterCount,
  boardStatusCounts,
  detailOptions,
  matchesBoardFilters,
  matchesQuery,
  type BoardDetailKey,
  type BoardFilterSet,
  type BoardStatusKey,
  type ShipmentRow,
} from '../shipmentViews'
import type { CustomerRecord } from '@/types/tms'

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
  /** Namespace for the collapse flag and the recently-used values. */
  storageKey: string
  /**
   * What this page shows before anybody filters it (Tracking starts on freight that
   * is moving). Reset Filters comes back here.
   */
  baseFilters?: BoardFilterSet
  /**
   * The board keeps its search in the URL so a link reproduces the list. Pass the
   * value and the setter to control it; leave both out and the hook holds it.
   */
  query?: string
  onQueryChange?: (value: string) => void
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
  panelProps: BoardFilterPanelProps
}

function readCollapsed(key: string): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(`${key}:collapsed`) === 'true'
}


export function useBoardFilters(options: UseBoardFiltersOptions): UseBoardFiltersResult {
  const { rows: allRows, customers, staffNameOf, storageKey } = options
  const baseFilters = options.baseFilters ?? EMPTY_BOARD_FILTER_SET

  const [ownQuery, setOwnQuery] = useState('')
  const query = options.query ?? ownQuery
  const setQuery = options.onQueryChange ?? setOwnQuery

  const [filters, setFilters] = useState<BoardFilterSet>(() => baseFilters)

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
    return queryRows.filter((r) => matchesBoardFilters(r, filters, now))
  }, [queryRows, filters])

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

  const panelProps = useMemo<BoardFilterPanelProps>(
    () => ({
      collapsed,
      onToggleCollapse: () => setCollapsed(!collapsed),
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
      collapsed, setCollapsed, statusCounts, filters, toggleStatus, detailDefs, setDetail,
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
    panelProps,
  }
}
