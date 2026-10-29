/**
 * The one Shipments board — Aljex-style layout inside the MVMNT shell.
 *
 * The page owns all state and every backend call. The presentational pieces in
 * `src/features/shipments/board/` are given values and callbacks; the page decides
 * what to fetch, what to filter, what to select and what to batch.
 *
 * A single pane handles the normal view. Split Screen renders two independent panes,
 * each with its own view, filters and selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  Clock,
  FileX,
  Search,
  Truck,
  UserX,
} from 'lucide-react'
import { toast } from 'sonner'

import { BoardFilterPanel } from './board/BoardFilterPanel'
import { useBoardFilters } from './board/useBoardFilters'
import { BoardGrid, type BoardGridColumn, type BoardGridSort } from './board/BoardGrid'
import { BoardFooterBar } from './board/BoardFooterBar'
import { IconKeyDialog, type BoardToneKey, type BoardExceptionKey } from './board/IconKeyDialog'
import { BatchTaskDialog, type BatchTaskAction, type BatchTaskResult } from './board/BatchTaskDialog'
import { BoardMapView } from './board/BoardMapView'
import { ColumnsPickerDialog } from './board/ColumnsPickerDialog'
import { FilterSetDialog } from './board/FilterSetDialog'
import { TmsBadge, TmsButton, TmsInput, statusTone } from '@/features/tms/kit'
import { useOwnershipDivisions, useShipmentViews } from '@/features/tms/useShipmentViews'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import {
  batchShipmentTask,
  deleteShipmentColumnTemplate,
  duplicateShipment,
  getTmsSettings,
  listOrders,
  listShipmentColumnTemplates,
  saveShipmentColumnTemplate,
  saveShipmentView,
  setShipmentStatus,
  tenderRespond,
} from '@/lib/apiClient'
import { saveBlob } from '@/lib/download'
import { checkCallState } from '@/lib/checkCalls'
import { customerDisplayName, isCustomerUnresolved } from '@/lib/customerResolution'
import { displayName } from '@/lib/roles'
import { slugify, viewCallerOf, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import { SEED_DIVISIONS } from '@/lib/ownership'
import { cn } from '@/lib/utils'
import { ShipmentDrawer } from './components/ShipmentDrawer'
import { ShipmentRowActions, type ShipmentActionHandlers } from './components/StatusActions'
import { CreateShipmentDialog } from './components/CreateShipmentDialog'
import { UnvoidShipmentDialog } from './components/UnvoidShipmentDialog'
import { RepointCustomerDialog } from './components/RepointCustomerDialog'

import {
  ALJEX_COLUMN_KEYS,
  BOARD_COLUMNS,
  EMPTY_BOARD_FILTER_SET,
  boardRowTone,
  carrierLabel,
  massReleaseReady,
  toCsv,
  visibleColumns,
  type BoardFilterSet,
  type ShipmentRow,
} from './shipmentViews'
import type { BatchShipmentTask, CustomerRecord, LocationRecord, OrderRecord, ShipmentColumnTemplateRecord, ShipmentViewRecord, TmsSettings, UserProfileRecord } from '@/types/tms'

const MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? ''
const MAPS_MAP_ID = (import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined) ?? undefined

const REFRESH_SECONDS = 60
const PAGE_SIZE_INITIAL = 50
const PAGE_SIZE_INCREMENT = 50

/** Kept for the one place the board still reasons about standard page sizes. */
const PAGE_SIZES = [20, 50, 100]

/** A chosen page size must not silently revert (the old board's bug). */
function normalizePageSize(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : PAGE_SIZES[1]
}

const SETTABLE_STATUSES = ['ON_HOLD', 'OPEN', 'CANCELED', 'UNCANCEL'] as const

const DEFAULT_SORT: BoardGridSort = { key: 'pickupShip', dir: 'asc' }

/**
 * The footer's Batch task offers one flat list of choices; the router takes a task and
 * its parameters. This is the one place the two vocabularies meet.
 */
function batchTaskOf(action: string): { task: BatchShipmentTask; params: Record<string, unknown> } | null {
  if (action === 'release') return { task: 'RELEASE_TO_BILLING', params: {} }
  if (action.startsWith('rep:')) return { task: 'SET_SALES_REP', params: { repId: action.slice(4) } }
  if (action.startsWith('carrierRep:')) return { task: 'SET_CARRIER_REP', params: { repId: action.slice(11) } }
  if (action.startsWith('carrierTeam:')) return { task: 'SET_CARRIER_REP', params: { teamKey: action.slice(12) } }
  if (action.startsWith('division:')) {
    const [divisionCode, subdivisionCode] = action.slice(9).split(':')
    return { task: 'SET_REV_DIVISION', params: subdivisionCode ? { divisionCode, subdivisionCode } : { divisionCode } }
  }
  if (action.startsWith('status:')) {
    return { task: 'SET_STATUS', params: { status: action.slice(7), reason: 'Batch task' } }
  }
  return null
}

function sentence(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

function panelStorageKey(email: string, pane: 'left' | 'right'): string {
  return `tms:shipments:panelCollapsed:${email ?? 'anon'}:${pane}`
}

function rowSortValue(row: ShipmentRow, key: string): string | number {
  switch (key) {
    case 'status':
      return statusCellText(row)
    case 'customerTotalRate':
      return row.revenueCents ?? Number.NEGATIVE_INFINITY
    case 'carrierTotalRates':
      return row.costCents ?? Number.NEGATIVE_INFINITY
    case 'grossProfit':
      return row.profitCents ?? Number.NEGATIVE_INFINITY
    case 'netMargin':
      return row.marginBps ?? Number.NEGATIVE_INFINITY
    case 'pickupShip':
      return row.shipDate ?? ''
    case 'pickupAppt':
      return row.pickupAppt ?? ''
    case 'deliveryAppt':
      return row.deliveryAppt ?? ''
    default: {
      const col = BOARD_COLUMNS.find((c) => c.key === key)
      return col ? col.value(row) : ''
    }
  }
}

/**
 * The screen and the CSV print the same Status text, because they ask the same
 * column for it. A second copy of this here is how `DEL` ended up on the board
 * beside a checkbox reading `Delivered`.
 */
const STATUS_COLUMN = BOARD_COLUMNS.find((c) => c.key === 'status')
function statusCellText(row: ShipmentRow): string {
  return STATUS_COLUMN ? STATUS_COLUMN.value(row) : ''
}

function sortRows(rows: ShipmentRow[], sort: BoardGridSort | null): ShipmentRow[] {
  if (!sort) return rows
  const dir = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const va = rowSortValue(a, sort.key)
    const vb = rowSortValue(b, sort.key)
    if (typeof va === 'number' && typeof vb === 'number') {
      if (va !== vb) return (va - vb) * dir
    } else {
      const cmp = String(va).localeCompare(String(vb))
      if (cmp !== 0) return cmp * dir
    }
    return a.id.localeCompare(b.id)
  })
}

function exceptionIcons(row: ShipmentRow): Array<{ icon: ReactNode; meaning: string }> {
  const out: Array<{ icon: ReactNode; meaning: string }> = []
  if ((row.openIncidentCount ?? 0) > 0) {
    out.push({ icon: <AlertTriangle size={14} />, meaning: `${row.openIncidentCount} open incident(s)` })
  }
  if (row.checkCallOpen === 'OPEN') {
    const state = checkCallState({ nextCheckCallAt: row.nextCheckCallAt }, Date.now())
    out.push({
      icon: <Clock size={14} />,
      meaning: state === 'OVERDUE' ? 'Overdue check call' : 'Open check call',
    })
  }
  if (row.docsMissing != null && row.docsMissing.length > 0) {
    out.push({ icon: <FileX size={14} />, meaning: `Missing documents: ${row.docsMissing.join(', ')}` })
  }
  if (isCustomerUnresolved(row)) {
    out.push({ icon: <UserX size={14} />, meaning: 'Customer not linked' })
  }
  return out
}

function toneRows(): BoardToneKey[] {
  return [
    { key: 'delivered', label: 'Delivered', statuses: ['DELIVERED'] },
    { key: 'dispatched', label: 'Dispatched', statuses: ['DISPATCHED'] },
    { key: 'departed', label: 'Departed', statuses: ['DEPARTED'] },
    { key: 'arrived', label: 'Arrived', statuses: ['ARRIVED'] },
    { key: 'covered', label: 'Covered', statuses: ['COVERED'] },
    { key: 'open', label: 'Open', statuses: ['OPEN'] },
    { key: 'hold', label: 'Hold', statuses: ['HOLD'] },
    { key: 'reserved', label: 'Reserved', statuses: ['RESERVED'] },
    { key: 'voided', label: 'Voided', statuses: ['VOIDED'] },
  ]
}

export function ShipmentsBoard() {
  const navigate = useNavigate()
  const { slug } = useParams<{ slug?: string }>()
  const { isAdmin, isOwner, user } = useAuth()
  const email = user?.email ?? ''
  const { shipments: rawRows, loading, error, refresh } = useShipments()
  const { customers, locations } = useDirectory()
  const staff = useStaff(email)
  const viewsState = useShipmentViews()
  const { views } = viewsState
  const [orders, setOrders] = useState<OrderRecord[]>([])
  const [columnTemplates, setColumnTemplates] = useState<ShipmentColumnTemplateRecord[]>([])
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [split, setSplit] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    getTmsSettings().then((s) => { if (!cancelled) setSettings(s) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Fetch the order layer once: the batch release action needs order ids and CAS tokens,
  // and the Mass Release column needs to know whether a row has already been released.
  useEffect(() => {
    let cancelled = false
    listOrders()
      .then((rows) => { if (!cancelled) setOrders(rows) })
      .catch(() => { /* already surfaced by useShipments */ })
    return () => { cancelled = true }
  }, [])

  const loadTemplates = useCallback(() => {
    listShipmentColumnTemplates()
      .then((rows) => setColumnTemplates(rows))
      .catch(() => {})
  }, [])

  useEffect(() => { loadTemplates() }, [loadTemplates])

  const allRows = useMemo<ShipmentRow[]>(() => {
    const orderByShipment: Record<string, OrderRecord> = {}
    for (const o of orders) {
      if (!o.shipmentId) continue
      orderByShipment[o.shipmentId] = o
    }
    return rawRows.map((r) => {
      const o = orderByShipment[r.id]
      return {
        ...r,
        readyToInvoiceAt: o?.readyToInvoiceAt ?? (r as ShipmentRow).readyToInvoiceAt ?? null,
        invoiceId: o?.invoiceId ?? (r as ShipmentRow).invoiceId ?? null,
      } as ShipmentRow
    })
  }, [rawRows, orders])

  const caller = useMemo(
    () => viewCallerOf({ groups: user?.groups, divisions: staff.me?.divisions, isOwner, isAdmin }),
    [user?.groups, staff.me?.divisions, isOwner, isAdmin],
  )

  const visibleViews = useMemo(() => viewsVisibleTo(views, caller), [views, caller])

  // No slug => land on the seeded default view.
  useEffect(() => {
    if (slug || viewsState.loading || visibleViews.length === 0) return
    const defaultView = visibleViews.find((v) => v.isDefault)
    if (defaultView) {
      navigate(`/tms/shipments/view/${defaultView.slug}`, { replace: true })
    }
  }, [slug, visibleViews, viewsState.loading, navigate])

  const mayAdmin = isOwner || isAdmin

  const [rightViewId, setRightViewId] = useState('')
  const leftKey = visibleViews.find((v) => v.slug === slug)?.id ?? slug ?? 'all'
  const rightKey = visibleViews.find((v) => v.slug === rightViewId)?.id ?? rightViewId ?? 'right'

  return (
    <div className="tms-board-shell flex h-full flex-col">
      <div className="tms-board-toolbar flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-3">
          <Truck size={18} />
          <span className="font-semibold">Shipments</span>
        </div>
        {mayAdmin && (
          <TmsButton size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
            Create shipment
          </TmsButton>
        )}
      </div>

      <div className={`flex flex-1 overflow-hidden ${split ? 'gap-1' : ''}`}>
        <BoardPane
          key={leftKey}
          pane="left"
          currentViewId={slug ?? ''}
          onSelectView={(id) => { navigate(id ? `/tms/shipments/view/${id}` : '/tms/shipments') }}
          allRows={allRows}
          loading={loading}
          error={error}
          refresh={refresh}
          customers={customers}
          locations={locations}
          settings={settings}
          staff={{ staff: staff.staff, me: staff.me, nameOf: staff.nameOf }}
          visibleViews={visibleViews}
          columnTemplates={columnTemplates}
          refreshTemplates={loadTemplates}
          isOwner={isOwner}
          isAdmin={isAdmin}
          currentUser={email}
          email={email}
          onSplit={() => setSplit((s) => !s)}
        />
        {split && (
          <BoardPane
            key={rightKey}
            pane="right"
            currentViewId={rightViewId}
            onSelectView={setRightViewId}
            allRows={allRows}
            loading={loading}
            error={error}
            refresh={refresh}
            customers={customers}
            locations={locations}
            settings={settings}
            staff={{ staff: staff.staff, me: staff.me, nameOf: staff.nameOf }}
            visibleViews={visibleViews}
            columnTemplates={columnTemplates}
            refreshTemplates={loadTemplates}
            isOwner={isOwner}
            isAdmin={isAdmin}
            currentUser={email}
            email={email}
            onSplit={() => setSplit((s) => !s)}
          />
        )}
      </div>

      <CreateShipmentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={refresh}
      />
    </div>
  )
}

interface StaffSnapshot {
  staff: UserProfileRecord[]
  me: UserProfileRecord | null
  nameOf: (id: string | null | undefined) => string
}

interface BoardPaneProps {
  pane: 'left' | 'right'
  currentViewId: string
  onSelectView: (id: string) => void
  allRows: ShipmentRow[]
  loading?: boolean
  error?: string | null
  refresh: () => Promise<void>
  customers: CustomerRecord[]
  locations: LocationRecord[]
  settings: TmsSettings | null
  staff: StaffSnapshot
  visibleViews: ShipmentViewRecord[]
  columnTemplates: ShipmentColumnTemplateRecord[]
  refreshTemplates: () => void
  isOwner: boolean
  isAdmin: boolean
  currentUser: string
  email: string
  onSplit: () => void
}

function BoardPane({
  pane,
  currentViewId,
  onSelectView,
  allRows,
  refresh,
  customers,
  locations,
  settings,
  staff,
  visibleViews,
  columnTemplates,
  refreshTemplates,
  isOwner,
  isAdmin,
  currentUser,
  email,
  onSplit,
}: BoardPaneProps) {
  const { staff: staffProfiles, nameOf: staffNameOf } = staff
  const divisions = useOwnershipDivisions().divisions ?? SEED_DIVISIONS
  // Step I teams are a property of the people, so the batch offers exactly the teams
  // somebody is actually on rather than a list nobody maintains.
  const teamKeys = useMemo(
    () => [...new Set(staffProfiles.flatMap((u) => u.teamKeys ?? []))].sort(),
    [staffProfiles],
  )
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const urlQuery = params.get('q')
  const [typed, setTyped] = useState('')
  const [pageSize, setPageSize] = useState(PAGE_SIZE_INITIAL)
  const query = urlQuery ?? typed
  const setQuery = useCallback(
    (next: string) => {
      setTyped(next)
      setPageSize(PAGE_SIZE_INITIAL)
      if (urlQuery !== null) {
        setParams(next ? { q: next } : {}, { replace: true })
      }
    },
    [urlQuery, setParams, setPageSize],
  )

  const activeView = useMemo(
    () => visibleViews.find((v) => v.slug === currentViewId) ?? null,
    [visibleViews, currentViewId],
  )

  const savedFilters = useMemo<BoardFilterSet>(
    () => activeView?.filters?.board ?? EMPTY_BOARD_FILTER_SET,
    [activeView],
  )
  const savedColumns = useMemo<string[]>(
    () => activeView?.columns ?? ALJEX_COLUMN_KEYS,
    [activeView],
  )

  const [columnKeys, setColumnKeys] = useState<string[]>(() => savedColumns)
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const [pinnedKeys, setPinnedKeys] = useState<string[]>([])
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [sort, setSort] = useState<BoardGridSort>(() =>
    activeView?.sort ? { key: activeView.sort.key, dir: activeView.sort.dir } : DEFAULT_SORT,
  )
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [mapVisible, setMapVisible] = useState(false)
  const [iconKeyOpen, setIconKeyOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchAction, setBatchAction] = useState('')
  const [batchResults, setBatchResults] = useState<BatchTaskResult[] | undefined>()
  const [batchRunning, setBatchRunning] = useState(false)
  const [filterSetDialog, setFilterSetDialog] = useState<{ open: boolean; mode: 'create' | 'edit' } | null>(null)
  const [filterSetName, setFilterSetName] = useState('')
  const [filterSetShared, setFilterSetShared] = useState(false)
  const [columnTemplateId, setColumnTemplateId] = useState<string | null>(null)
  const [dialogShipment, setDialogShipment] = useState<ShipmentRow | null>(null)
  const [dialogKind, setDialogKind] = useState<'unvoid' | 'repoint' | null>(null)

  const handleCreateFilterSet = useCallback(() => {
    setFilterSetName('')
    setFilterSetShared(false)
    setFilterSetDialog({ open: true, mode: 'create' })
  }, [])

  // The filters, the facet options and the panel itself are the same three things the
  // Dispatch, Tracking and Documents workstations show, so they come from one hook.
  // The board keeps what is its own: columns, sort, selection and the batch.
  const {
    filters,
    setFilters,
    rows: filteredRows,
    panelProps,
  } = useBoardFilters({
    rows: allRows,
    customers,
    staffNameOf,
    views: visibleViews,
    viewSlug: currentViewId,
    onSelectView,
    onCreateView: handleCreateFilterSet,
    storageKey: panelStorageKey(email, pane),
    baseFilters: savedFilters,
    query,
    onQueryChange: setQuery,
  })

  // Columns and sort hydrate with the view the same way the filters do inside the
  // hook: only when the view identity changes, so a poll never discards an edit.
  const lastHydratedViewIdRef = useRef<string | null>(null)
  useEffect(() => {
    const nextId = activeView?.id ?? null
    if (nextId === lastHydratedViewIdRef.current) return
    lastHydratedViewIdRef.current = nextId
    setColumnKeys(savedColumns)
    setSort(activeView?.sort ? { key: activeView.sort.key, dir: activeView.sort.dir } : DEFAULT_SORT)
    setColumnTemplateId(null)
    setColumnWidths({})
    setPinnedKeys([])
  }, [activeView, savedColumns])

  // Countdown refetch.
  const [secondsToRefresh, setSecondsToRefresh] = useState(REFRESH_SECONDS)
  const [autoRefresh, setAutoRefresh] = useState(true)
  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(() => {
      setSecondsToRefresh((s) => {
        if (s <= 1) {
          void refresh()
          return REFRESH_SECONDS
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [autoRefresh, refresh])

  const handleRefresh = useCallback(() => {
    setSecondsToRefresh(REFRESH_SECONDS)
    return refresh()
  }, [refresh])

  const sortedRows = useMemo(() => sortRows(filteredRows, sort), [filteredRows, sort])
  const shownRows = useMemo(() => sortedRows.slice(0, pageSize), [sortedRows, pageSize])

  const columnsDirty = useMemo(() => !arraysEqual(columnKeys, savedColumns), [columnKeys, savedColumns])

  const activeTemplate = useMemo(
    () => columnTemplates.find((ct) => ct.id === columnTemplateId) ?? null,
    [columnTemplates, columnTemplateId],
  )

  const activeColumnTemplateId = useMemo(() => {
    if (columnTemplateId) return columnTemplateId
    const t = columnTemplates.find(
      (ct) => ct.columns.length === columnKeys.length && arraysEqual(ct.columns, columnKeys),
    )
    return t?.id ?? null
  }, [columnTemplateId, columnTemplates, columnKeys])

  const columnTemplateOptions = useMemo(
    () => columnTemplates.map((ct) => ({ id: ct.id, name: ct.name })),
    [columnTemplates],
  )

  const handleUpdateFilterSet = useCallback(async () => {
    if (!activeView) return
    try {
      await saveShipmentView({
        id: activeView.id,
        name: activeView.name,
        slug: activeView.slug,
        department: activeView.department,
        description: activeView.description,
        filters: { ...activeView.filters, board: filters },
        columns: columnKeys,
        sort,
        isDefault: activeView.isDefault,
        audience: activeView.audience,
        sortOrder: activeView.sortOrder,
        active: activeView.active,
      })
      toast.success('View saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    }
  }, [activeView, filters, columnKeys, sort])

  const handleRevertFilterSet = useCallback(() => {
    setFilters(savedFilters)
    setColumnKeys(savedColumns)
    setSort(activeView?.sort ? { key: activeView.sort.key, dir: activeView.sort.dir } : DEFAULT_SORT)
    setColumnTemplateId(null)
  }, [savedFilters, savedColumns, activeView, setFilters])

  const handleSelectColumnTemplate = useCallback(
    (id: string) => {
      const t = columnTemplates.find((ct) => ct.id === id)
      if (t) {
        setColumnKeys([...t.columns])
        setColumnWidths({ ...(t.widths ?? {}) })
        setPinnedKeys([...(t.pinned ?? [])])
        setColumnTemplateId(id)
      }
    },
    [columnTemplates],
  )

  const exportCsv = useCallback(() => {
    const csv = toCsv(filteredRows, columnKeys)
    saveBlob(new Blob([csv], { type: 'text/csv' }), `shipments-${new Date().toISOString().slice(0, 10)}.csv`)
  }, [filteredRows, columnKeys])

  // Batch task actions. Everything but the CSV runs on the server: one call, one
  // audit row per shipment, and the release gate decides each row for itself.
  const batchActions = useMemo<BatchTaskAction[]>(() => {
    const actions: BatchTaskAction[] = [{ key: 'release', label: 'Release to billing' }]
    for (const u of staffProfiles) {
      actions.push({ key: `rep:${u.id}`, label: `Change sales rep to ${displayName(u)}` })
    }
    for (const d of divisions) {
      if (!d.active) continue
      const parent = d.parentId ? divisions.find((p) => p.id === d.parentId) ?? null : null
      actions.push({
        key: `division:${parent ? `${parent.code}:${d.code}` : d.code}`,
        label: `Change revenue division to ${parent ? `${parent.name} · ${d.name}` : d.name}`,
      })
    }
    for (const u of staffProfiles) {
      actions.push({ key: `carrierRep:${u.id}`, label: `Change carrier rep to ${displayName(u)}` })
    }
    for (const team of teamKeys) {
      actions.push({ key: `carrierTeam:${team}`, label: `Change carrier team to ${team}` })
    }
    for (const status of SETTABLE_STATUSES) {
      actions.push({ key: `status:${status}`, label: `Set status to ${sentence(status)}` })
    }
    actions.push({ key: 'export', label: 'Export selected' })
    return actions
  }, [staffProfiles, divisions, teamKeys])

  const selectedRows = useMemo(
    () => shownRows.filter((r) => selectedIds.includes(r.id)),
    [shownRows, selectedIds],
  )

  const runBatch = useCallback(async () => {
    if (!batchAction || selectedRows.length === 0) return
    setBatchRunning(true)
    setBatchResults(undefined)

    const labelOf = (shipmentId: string, fallback: string | null) =>
      selectedRows.find((r) => r.id === shipmentId)?.number ?? fallback ?? shipmentId

    if (batchAction === 'export') {
      const results: BatchTaskResult[] = []
      try {
        const csv = toCsv(selectedRows, columnKeys)
        saveBlob(new Blob([csv], { type: 'text/csv' }), `shipments-selected-${new Date().toISOString().slice(0, 10)}.csv`)
        results.push({ rowId: 'export', rowLabel: 'Export selected', success: true })
      } catch (err) {
        results.push({ rowId: 'export', rowLabel: 'Export selected', success: false, message: err instanceof Error ? err.message : 'Export failed' })
      }
      setBatchResults(results)
      setBatchRunning(false)
      return
    }

    const task = batchTaskOf(batchAction)
    if (!task) {
      setBatchResults([{ rowId: 'batch', rowLabel: 'Batch task', success: false, message: 'Unknown task' }])
      setBatchRunning(false)
      return
    }

    try {
      const res = await batchShipmentTask({
        task: task.task,
        shipmentIds: selectedRows.map((r) => r.id),
        params: task.params,
      })
      const results: BatchTaskResult[] = res.results.map((r) => ({
        rowId: r.shipmentId,
        rowLabel: labelOf(r.shipmentId, r.number),
        success: r.ok,
        message: r.message ?? undefined,
      }))
      setBatchResults(results)
      setBatchRunning(false)
      if (results.every((r) => r.success)) {
        setSelectedIds([])
        await handleRefresh()
      } else {
        await handleRefresh()
      }
    } catch (err) {
      setBatchResults(
        selectedRows.map((r) => ({
          rowId: r.id,
          rowLabel: r.number,
          success: false,
          message: err instanceof Error ? err.message : 'Batch failed',
        })),
      )
      setBatchRunning(false)
    }
  }, [batchAction, selectedRows, columnKeys, handleRefresh])

  const gridColumns = useMemo<BoardGridColumn[]>(
    () =>
      visibleColumns(columnKeys).map((col) => ({
        key: col.key,
        header: col.label,
        sortable: col.sortKey != null,
        width: col.width,
      })),
    [columnKeys],
  )

  const renderCell = useCallback(
    (row: ShipmentRow, columnKey: string): ReactNode => {
      if (columnKey === 'exceptions') {
        const icons = exceptionIcons(row)
        if (icons.length === 0) return null
        return (
          <span className="flex items-center gap-1">
            {icons.map((ex, i) => (
              <span key={i} title={ex.meaning} className="tms-board-exception">
                {ex.icon}
              </span>
            ))}
          </span>
        )
      }
      if (columnKey === 'status') {
        return <span className="font-medium">{statusCellText(row)}</span>
      }
      if (columnKey === 'massRelease') {
        const { ready, reason } = massReleaseReady(row)
        if (ready) {
          return (
            <input
              type="checkbox"
              aria-label={`Release ${row.number}`}
              checked={selectedIds.includes(row.id)}
              onChange={() => setSelectedIds((prev) => (prev.includes(row.id) ? prev.filter((id) => id !== row.id) : [...prev, row.id]))}
              onClick={(e) => e.stopPropagation()}
            />
          )
        }
        return <span className="tms-muted text-xs">{reason}</span>
      }
      if (columnKey === 'customerName') {
        if (!isCustomerUnresolved(row)) return <>{customerDisplayName(row)}</>
        return (
          <span className="flex items-center gap-1">
            <span className="tms-muted">{customerDisplayName(row)}</span>
            <TmsBadge tone="orange">Not linked</TmsBadge>
          </span>
        )
      }
      if (columnKey === 'carrier') {
        return <span className={cn(carrierLabel(row) === 'Need to cover' && 'tms-muted')}>{carrierLabel(row)}</span>
      }
      if (columnKey === 'arStatus' || columnKey === 'apStatus') {
        const value = columnKey === 'arStatus' ? row.arStatus : row.apStatus
        if (!value) return null
        return <TmsBadge tone={statusTone(value)}>{sentence(value)}</TmsBadge>
      }
      if (columnKey === 'docsMissing') {
        if (row.docsMissing == null) return null
        if (row.docsMissing.length === 0) {
          return <span className="text-[color:var(--tms-badge-green)]">Complete</span>
        }
        return (
          <TmsBadge tone="orange" title={row.docsMissing.join(', ')}>
            {row.docsMissing.length} missing
          </TmsBadge>
        )
      }
      if (columnKey === 'nextCheckCallAt') {
        const state = checkCallState({ nextCheckCallAt: row.nextCheckCallAt }, Date.now())
        const col = BOARD_COLUMNS.find((c) => c.key === columnKey)
        return (
          <span className={cn('tabular-nums', state === 'OVERDUE' && 'tms-overdue', state === 'DUE' && 'tms-due')}>
            {col ? col.value(row) : ''}
          </span>
        )
      }
      const col = BOARD_COLUMNS.find((c) => c.key === columnKey)
      return col ? col.value(row) : null
    },
    [selectedIds],
  )

  const rowHandlers = useCallback(
    (row: ShipmentRow): ShipmentActionHandlers => {
      const run = async (label: string, fn: () => Promise<unknown>) => {
        try {
          await fn()
          toast.success(label)
          await refresh()
        } catch (err) {
          toast.error(err instanceof Error ? err.message : `${label} failed`)
          throw err
        }
      }
      return {
        onDuplicate: (copies) =>
          run(`${copies.length} copy${copies.length === 1 ? '' : 'ies'} created`, () =>
            duplicateShipment({ shipmentId: row.id, copies })),
        onSetStatus: (status, reason) =>
          run('Status updated', () =>
            setShipmentStatus({ shipmentId: row.id, expectedUpdatedAt: row.updatedAt, status, reason })),
        onVoid: () => { toast.success(`${row.number} voided`); refresh().catch(() => {}) },
        onTenderRespond: (decision, reason) =>
          run('Tender updated', () =>
            tenderRespond({ shipmentId: row.id, expectedUpdatedAt: row.updatedAt, decision, reason })),
        onUnvoid: () => { setDialogShipment(row); setDialogKind('unvoid') },
        onRepointCustomer: () => { setDialogShipment(row); setDialogKind('repoint') },
      }
    },
    [refresh],
  )

  const actionsColumn: BoardGridColumn = useMemo(
    () => ({ key: 'actions', header: '', width: 44 }),
    [],
  )

  const columnsWithActions = useMemo(
    () => [...gridColumns, actionsColumn],
    [gridColumns, actionsColumn],
  )

  const renderCellWithActions = useCallback(
    (row: ShipmentRow, key: string): ReactNode => {
      if (key === 'actions') {
        return (
          <ShipmentRowActions
            shipment={row}
            isAdmin={isAdmin}
            cancelDeleteAdminOnly={false}
            handlers={rowHandlers(row)}
          />
        )
      }
      return renderCell(row, key)
    },
    [renderCell, rowHandlers, isAdmin],
  )

  const [openDrawerId, setOpenDrawerId] = useState<string | null>(null)

  const exceptionsForKey = useMemo<BoardExceptionKey[]>(() => {
    const meanings = new Map<string, ReactNode>()
    for (const row of shownRows) {
      for (const ex of exceptionIcons(row)) {
        meanings.set(ex.meaning, ex.icon)
      }
    }
    return [...meanings.entries()].map(([meaning, icon]) => ({ icon, meaning }))
  }, [shownRows])

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <BoardFilterPanel
          {...panelProps}
          filterSetDirty={panelProps.filterSetDirty || columnsDirty}
          columnTemplates={columnTemplateOptions}
          activeColumnTemplateId={activeColumnTemplateId}
          onSelectColumnTemplate={handleSelectColumnTemplate}
          onManageColumnTemplates={() => setColumnsOpen(true)}
          onUpdateFilterSet={() => { void handleUpdateFilterSet() }}
          onRevertFilterSet={handleRevertFilterSet}
          onResetFilters={handleRevertFilterSet}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search size={16} className="tms-muted" />
            <TmsInput
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 w-64"
            />
          </div>

          <div className="flex-1 overflow-hidden">
            {mapVisible ? (
              <BoardMapView
                rows={shownRows}
                apiKey={MAPS_KEY}
                mapId={MAPS_MAP_ID}
                onOpenShipment={(id) => setOpenDrawerId(id)}
              />
            ) : (
              <BoardGrid<ShipmentRow>
                columns={columnsWithActions}
                rows={shownRows}
                rowKey={(r) => r.id}
                selectedIds={selectedIds}
                toneOf={(r) => boardRowTone(r)}
                onToggle={(id) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
                onToggleAll={() =>
                  setSelectedIds((prev) => (prev.length === shownRows.length ? [] : shownRows.map((r) => r.id)))
                }
                sort={sort}
                onSort={(key) =>
                  setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
                }
                onRowClick={(row) => setOpenDrawerId(row.id)}
                onRowDoubleClick={(row) => navigate(`/tms/shipments/${row.id}`)}
                renderCell={renderCellWithActions}
              />
            )}
          </div>

          <BoardFooterBar
            shown={shownRows.length}
            total={filteredRows.length}
            secondsToRefresh={secondsToRefresh}
            autoRefresh={autoRefresh}
            onToggleAutoRefresh={() => setAutoRefresh((a) => !a)}
            onNext50={() => setPageSize((s) => normalizePageSize(s + PAGE_SIZE_INCREMENT))}
            onRefresh={handleRefresh}
            onExportCsv={exportCsv}
            onShowMap={() => setMapVisible((m) => !m)}
            onIconKey={() => setIconKeyOpen(true)}
            onNewTab={() => window.open(window.location.href, '_blank')}
            onBatchTask={() => setBatchOpen(true)}
            onSplitScreen={onSplit}
            mapVisible={mapVisible}
            selectedCount={selectedIds.length}
          />
        </div>
      </div>

      <IconKeyDialog
        open={iconKeyOpen}
        onOpenChange={setIconKeyOpen}
        tones={toneRows()}
        exceptions={exceptionsForKey}
      />

      <BatchTaskDialog<ShipmentRow>
        open={batchOpen}
        onOpenChange={(open) => { setBatchOpen(open); if (!open) setBatchResults(undefined) }}
        selectedRows={selectedRows}
        rowLabel={(r) => r.number}
        rowKey={(r) => r.id}
        actions={batchActions}
        selectedAction={batchAction}
        onSelectAction={setBatchAction}
        onRun={runBatch}
        running={batchRunning}
        results={batchResults}
      />

      <FilterSetDialog
        open={filterSetDialog?.open ?? false}
        onOpenChange={(open) => { if (!open) setFilterSetDialog(null) }}
        mode={filterSetDialog?.mode ?? 'create'}
        name={filterSetName}
        onNameChange={setFilterSetName}
        shared={filterSetShared}
        onSharedChange={setFilterSetShared}
        canDelete={false}
        onDelete={() => {}}
        onSave={async () => {
          const name = filterSetName.trim()
          if (!name) { toast.error('Name the view.'); return }
          try {
            if (filterSetDialog?.mode === 'edit' && activeView) {
              await saveShipmentView({
                id: activeView.id,
                name,
                slug: activeView.slug,
                department: activeView.department,
                description: activeView.description,
                filters: { ...activeView.filters, board: filters },
                columns: columnKeys,
                sort,
                isDefault: activeView.isDefault,
                audience: activeView.audience,
                sortOrder: activeView.sortOrder,
                active: activeView.active,
              })
              toast.success('View updated')
            } else {
              const slug = slugify(name)
              const saved = await saveShipmentView({
                name,
                slug,
                filters: { board: filters },
                columns: columnKeys,
                sort,
                isDefault: false,
                active: true,
                sortOrder: (visibleViews[visibleViews.length - 1]?.sortOrder ?? 0) + 10,
              })
              toast.success('View created')
              onSelectView(saved.slug)
            }
            setFilterSetDialog(null)
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Save failed')
          }
        }}
      />

      <ColumnsPickerDialog
        open={columnsOpen}
        onOpenChange={setColumnsOpen}
        columns={columnKeys}
        widths={columnWidths}
        pinned={pinnedKeys}
        onApply={(next) => {
          setColumnKeys(next.columns)
          setColumnWidths(next.widths)
          setPinnedKeys(next.pinned)
          setColumnTemplateId(null)
        }}
        onSaveTemplate={async (next) => {
          try {
            await saveShipmentColumnTemplate({
              id: activeColumnTemplateId ?? undefined,
              name: next.name,
              columns: next.columns,
              widths: next.widths,
              pinned: next.pinned,
              shared: next.shared,
            })
            setColumnKeys(next.columns)
            setColumnWidths(next.widths)
            setPinnedKeys(next.pinned)
            toast.success('Template saved')
            refreshTemplates()
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Save failed')
          }
        }}
        onDeleteTemplate={
          activeTemplate && (isOwner || isAdmin || activeTemplate.ownerEmail === email)
            ? async () => {
                try {
                  await deleteShipmentColumnTemplate({ id: activeTemplate.id })
                  toast.success('Template deleted')
                  setColumnTemplateId(null)
                  refreshTemplates()
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Delete failed')
                }
              }
            : undefined
        }
      />

      {openDrawerId && (
        <ShipmentDrawer
          shipmentId={openDrawerId}
          onClose={() => setOpenDrawerId(null)}
          onChanged={handleRefresh}
          customers={customers}
          locations={locations}
          settings={settings}
          isAdmin={isAdmin}
          currentUser={currentUser}
        />
      )}

      {dialogShipment && dialogKind === 'unvoid' && (
        <UnvoidShipmentDialog
          shipment={dialogShipment}
          open
          onOpenChange={(open) => { if (!open) setDialogShipment(null) }}
          onUnvoided={async () => { setDialogShipment(null); await handleRefresh() }}
        />
      )}

      {dialogShipment && dialogKind === 'repoint' && (
        <RepointCustomerDialog
          shipment={dialogShipment}
          customers={customers}
          open
          onOpenChange={(open) => { if (!open) setDialogShipment(null) }}
          onRepointed={async () => { setDialogShipment(null); await handleRefresh() }}
        />
      )}
    </div>
  )
}
