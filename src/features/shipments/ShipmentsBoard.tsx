/**
 * The one Shipments board — Aljex-style layout inside the MVMNT shell.
 *
 * The page owns all state and every backend call. The presentational pieces in
 * `src/features/shipments/board/` are given values and callbacks; the page decides
 * what to fetch, what to filter, what to select and what to batch.
 *
 * A single pane handles the normal view. Split Screen renders two independent panes,
 * each with its own list (Active, All or Voided), filters and selection.
 */
import { CurrentlyViewing } from './components/CurrentlyViewing'
import { deliveryPhase, deliveryPhaseText } from '@/lib/deliveryPhase'
import { phaseInputOfRow } from './deliveryPhaseInputs'
import './deliveryTimeline.css'
import { TrackingModeNotSetRowChip } from './trackingModeControl/TrackingModeNotSetChip'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  Clock,
  Columns3,
  Download,
  FileX,
  Lock,
  Search,
  Trash2,
  Truck,
  UserX,
} from 'lucide-react'
import { toast } from 'sonner'

import { BoardFooterBar } from './board/BoardFooterBar'
import { IconKeyDialog, type BoardToneKey, type BoardExceptionKey } from './board/IconKeyDialog'
import { BatchTaskDialog, type BatchTaskAction, type BatchTaskResult } from './board/BatchTaskDialog'
import { BoardMapView } from './board/BoardMapView'
import { ColumnsDialog } from '@/features/tms/grid/ColumnsDialog'
import { ShipmentsSectionTabs } from './ShipmentsSectionTabs'
import { TmsBadge, TmsButton, TmsFilterChip, TmsInput, TmsSegmentedTabs, TmsSelect, statusTone } from '@/features/tms/kit'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import {
  ClearFiltersButton,
  DensityToggle,
  DenseKpiStrip,
  SummaryToggle,
  type DenseKpi,
} from '@/features/tms/grid/DenseControls'
import {
  activeFilterCount,
  filterRows,
  nextSort,
  reorderKeys,
  sortDenseRows,
  type DenseColumnFilter,
  type DenseFilters,
  type DenseSort,
} from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { lockHeldByOther } from '@/lib/shipmentLock'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useCarriers } from '@/hooks/useCarriers'
import { useDrivers } from '@/hooks/useDrivers'
import { useTrucks } from '@/hooks/useTrucks'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import {
  batchShipmentTask,
  duplicateShipment,
  getTmsSettings,
  listShipmentColumnTemplates,
  listShipmentsByNumber,
  saveShipmentColumnTemplate,
  setShipmentStatus,
  tenderRespond,
} from '@/lib/apiClient'
import { saveBlob } from '@/lib/download'
import { exportRecords } from '@/lib/opsExports'
import { activeUnits } from '@/lib/fleetActive'
import { checkCallState } from '@/lib/checkCalls'
import { formatCents } from '@/lib/invoiceBuild'
import { customerDisplayName, isCustomerUnresolved } from '@/lib/customerResolution'
import { displayName } from '@/lib/roles'
import { inShipmentList, monthsOfYear, parseShipmentList, shipmentListCounts, shipmentYears, type ShipmentList, type ShipmentYear } from '@/lib/shipmentLists'
import { chicagoYear } from '@/lib/date'
import { currentMonth, monthsCovering } from '@/lib/shipmentWindows'
import { SEED_DIVISIONS } from '@/lib/ownership'
import { cn } from '@/lib/utils'
import { ShipmentDrawer } from './components/ShipmentDrawer'
import { ShipmentRowActions, type ShipmentActionHandlers } from './components/StatusActions'
import { DeleteShipmentsDialog } from './components/DeleteShipmentsDialog'
import { UnvoidShipmentDialog } from './components/UnvoidShipmentDialog'
import { CoverCarrierDialog } from '@/features/carriers/cover/CoverCarrierDialog'
import { needsCover } from '@/features/tms/carrierSales/carrierSalesQueue'
import { RepointCustomerDialog } from './components/RepointCustomerDialog'

import {
  BOARD_COLUMNS,
  boardRowTone,
  boardStatusOf,
  carrierHoverText,
  carrierLabel,
  driverNamesOf,
  setFleetDrivers,
  matchesQuery,
  needsDriver,
  toCsv,
  isDemoShipment,
  type ShipmentRow,
} from './shipmentViews'
import {
  ACTIONS_COLUMN,
  SHIPMENT_COLUMN_KEYS,
  SHIPMENT_DEFAULT_COLUMNS,
  SHIPMENT_GRID_COLUMNS,
  sentence,
  statusCellText,
} from './shipmentGridColumns'
import {
  fitColumnWidths,
  resolveTeamLayout,
  TEAM_DEFAULT_COLUMN_TEMPLATE_ID,
  TEAM_DEFAULT_COLUMN_TEMPLATE_NAME,
  type TeamColumnLayout,
} from './teamColumnLayout'
import type { BatchShipmentTask, CustomerRecord, LocationRecord, ShipmentColumnTemplateRecord, TmsSettings, UserProfileRecord } from '@/types/tms'
import { REVIEW_BILLING_LABEL, needsBillingReview, reviewBillingNote } from '@/lib/reviewBilling'
import { BOARD_FLAGS, BOARD_FLAG_LABELS, flagCounts, matchesFlags, type BoardFlag } from './boardChips'
import { BatchActionBar } from './board/BatchActionBar'
import {
  outcomesFromServer,
  pushRefusals,
  selectAllUpToCap,
  toggleSelection,
  type BatchOutcome,
} from './batchReview'

type Period = { key: 'this' | 'last' | 'last3' } | { key: 'month'; month: string }

/** An exact PRO or reference-sized token: shorter text is a filter, not a lookup. */
const PRO_PATTERN = /^[A-Za-z0-9-]{5,}$/

/** The month `n` before (negative) or after (positive) `month`, 'YYYY-MM'. */
function shiftMonth(month: string, n: number): string {
  const span = monthsCovering(month, month, Math.abs(n))
  return n < 0 ? span[0] : span[span.length - 1]
}

/** The pickup months a period names, oldest first. */
function periodMonths(period: Period, thisMonth: string): string[] {
  if (period.key === 'month') return [period.month]
  if (period.key === 'last') return [shiftMonth(thisMonth, -1)]
  if (period.key === 'last3') return monthsCovering(shiftMonth(thisMonth, -2), thisMonth, 0)
  return [thisMonth]
}

const MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? ''
const MAPS_MAP_ID = (import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined) ?? undefined

const REFRESH_SECONDS = 60
/** A hundred rows a page; the grid virtualises them, so the DOM holds only the rows in view. */
const PAGE_SIZE_INITIAL = 100
const PAGE_SIZE_INCREMENT = 100

/** Kept for the one place the board still reasons about standard page sizes. */
const PAGE_SIZES = [20, 50, 100]

/** A chosen page size must not silently revert (the old board's bug). */
function normalizePageSize(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : PAGE_SIZES[1]
}

const SETTABLE_STATUSES = ['ON_HOLD', 'OPEN', 'CANCELED', 'UNCANCEL'] as const

const DEFAULT_SORT: DenseSort = { key: 'pickupShip', dir: 'asc' }

const COLUMN_BY_KEY = Object.fromEntries(SHIPMENT_GRID_COLUMNS.map((c) => [c.key, c]))

/**
 * The footer's Batch task offers one flat list of choices; the router takes a task and
 * its parameters. This is the one place the two vocabularies meet.
 */
function batchTaskOf(
  action: string,
  driverParams?: (driverId: string) => Record<string, unknown>,
): { task: BatchShipmentTask; params: Record<string, unknown> } | null {
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
  if (action.startsWith('driver:')) {
    const driverId = action.slice(7)
    return { task: 'ASSIGN_DRIVER', params: driverParams ? driverParams(driverId) : { driverId } }
  }
  return null
}

/** Step W: a live Ivan Cartage shipment nobody is driving. */
const NEEDS_DRIVER_MEANING = 'Ivan Cartage load with no driver'

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
  if (needsDriver(row)) {
    out.push({ icon: <UserX size={14} />, meaning: NEEDS_DRIVER_MEANING })
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
    { key: 'voided', label: 'Voided', statuses: ['VOIDED'] },
  ]
}

/** Columns locked to the left edge of the grid, whatever the team layout says. */
const LOCKED_KEYS = ['status', 'proNumber']

/** Status carries the tracking pill and Customer the Not linked badge beside their text: Fit widths leaves room for them. */
function withChipRoom(widths: Record<string, number>): Record<string, number> {
  const out = { ...widths }
  if (out.status != null) out.status = Math.max(out.status, 240)
  if (out.customerName != null) out.customerName = Math.max(out.customerName, 240)
  return out
}

/** The carrier profile a row's Carrier cell links to: by MC number, else by exact name. Own fleet and multi-carrier rows have none. */
function carrierIdOfRow(row: ShipmentRow, carriers: readonly { id: string; name: string; mcNumber?: string | null }[]): string | null {
  if (row.assignmentType === 'OWN_ASSET' || (row.carriers && row.carriers.length >= 2) || !row.carrierName) return null
  const mc = (row.carrierMc ?? '').trim()
  const byMc = mc ? carriers.find((c) => (c.mcNumber ?? '').trim() === mc) : undefined
  const name = row.carrierName.trim().toLowerCase()
  return (byMc ?? carriers.find((c) => c.name.trim().toLowerCase() === name))?.id ?? null
}

export function ShipmentsBoard() {
  const { isAdmin, isOwner, user } = useAuth()
  const navigate = useNavigate()
  const email = user?.email ?? ''
  const { shipments: workingRows, loading: workingLoading, partial: workingPartial, error: workingError, refresh: refreshWorking } = useShipments({ kind: 'working' })
  const { customers, locations } = useDirectory()
  const staff = useStaff(email)
  const [params] = useSearchParams()
  const list = parseShipmentList(params.get('list'))
  const [period, setPeriod] = useState<Period>({ key: 'this' })
  const [thisMonth] = useState(() => currentMonth(new Date()))
  const [reports, setReports] = useState<Record<'left' | 'right', PaneReport>>({ left: { query: '' }, right: { query: '' } })
  const report = useCallback((pane: 'left' | 'right', next: PaneReport) => {
    setReports((prev) => (prev[pane].query === next.query ? prev : { ...prev, [pane]: next }))
  }, [])
  const [columnTemplates, setColumnTemplates] = useState<ShipmentColumnTemplateRecord[]>([])
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [split, setSplit] = useState(false)
  const [rightList, setRightList] = useState<ShipmentList>('all')

  useEffect(() => {
    let cancelled = false
    getTmsSettings().then((s) => { if (!cancelled) setSettings(s) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const visiblePanes: Array<'left' | 'right'> = split ? ['left', 'right'] : ['left']
  const wantsAllList = visiblePanes.some((pane) => (pane === 'left' ? list : rightList) === 'all')
  const wantsVoidedList = visiblePanes.some((pane) => (pane === 'left' ? list : rightList) === 'voided')
  const needWindow = wantsAllList || wantsVoidedList
  // The All list is scoped by year (default: this Chicago year). A specific year reads that year's
  // twelve pickup months; All years reads the whole table. All never lists voided shipments: the
  // Voided list reads its own pickup-month period with the void filter dropped.
  const [year, setYear] = useState<ShipmentYear>(() => chicagoYear())
  const [seenYears, setSeenYears] = useState<number[]>(() => [chicagoYear()])
  const months = useMemo(() => periodMonths(period, thisMonth), [period, thisMonth])
  const windowMonths = wantsAllList && year !== 'all' ? monthsOfYear(year) : []
  const { shipments: windowRows, loading: windowLoading, partial: windowPartial, error: windowError, refresh: refreshWindow } = useShipments({
    kind: 'window', months: windowMonths,
  })
  const { shipments: voidedRows, loading: voidedLoading, error: voidedError, refresh: refreshVoided } = useShipments({
    kind: 'window', months: wantsVoidedList ? months : [], includeVoided: true,
  })
  const { shipments: allYearsRows, loading: allYearsLoading, error: allYearsError, refresh: refreshAllYears } = useShipments(
    wantsAllList && year === 'all' ? { kind: 'all' } : { kind: 'ids', ids: [] },
  )

  // An exact PRO typed on All adds its number-index match, but list scope still excludes
  // every voided row. Debounced: one read per pause.
  const typedPro = wantsAllList ? visiblePanes.map((pane) => reports[pane].query.trim()).find((q) => PRO_PATTERN.test(q)) ?? '' : ''
  const [proIds, setProIds] = useState<{ query: string; ids: string[] }>({ query: '', ids: [] })
  useEffect(() => {
    if (!typedPro) return undefined
    let live = true
    const timer = setTimeout(() => {
      listShipmentsByNumber(typedPro)
        .then((found) => { if (live) setProIds({ query: typedPro, ids: found.map((s) => s.id) }) })
        .catch(() => { /* the typed search still filters the rows already loaded */ })
    }, 400)
    return () => { live = false; clearTimeout(timer) }
  }, [typedPro])
  const { shipments: proRows, refresh: refreshPro } = useShipments({ kind: 'ids', ids: typedPro && proIds.query === typedPro ? proIds.ids : [] })
  const loading = workingLoading || windowLoading || allYearsLoading || voidedLoading
  const partial = workingPartial || windowPartial
  const error = workingError ?? windowError ?? allYearsError ?? voidedError

  const refresh = useCallback(async () => {
    await Promise.all([refreshWorking(), refreshWindow(), refreshAllYears(), refreshVoided(), refreshPro()])
  }, [refreshWorking, refreshWindow, refreshAllYears, refreshVoided, refreshPro])

  const loadTemplates = useCallback(() => {
    listShipmentColumnTemplates()
      .then((rows) => setColumnTemplates(rows))
      .catch(() => {})
  }, [])

  useEffect(() => { loadTemplates() }, [loadTemplates])

  // Union of working rows, All's year, Voided's period and exact PRO matches.
  // Each pane applies its own scope; voided rows can appear only in the Voided pane.
  const allRows = useMemo<ShipmentRow[]>(() => {
    const byId = new Map<string, ShipmentRow>()
    for (const set of [workingRows, windowRows, allYearsRows, voidedRows, proRows]) for (const r of set) byId.set(r.id, r as ShipmentRow)
    return [...byId.values()]
  }, [workingRows, windowRows, allYearsRows, voidedRows, proRows])

  const counts = useMemo(() => shipmentListCounts(allRows, year), [allRows, year])

  // Every year the data has shown so far, kept after a narrower year is picked so the selector does not shrink.
  const foundYears = useMemo(() => shipmentYears(allRows), [allRows])
  if (foundYears.some((y) => !seenYears.includes(y))) setSeenYears([...new Set([...seenYears, ...foundYears])].sort((a, b) => b - a))
  const yearOptions = useMemo(
    () => [{ value: 'all', label: 'All years' }, ...seenYears.map((y) => ({ value: String(y), label: String(y) }))],
    [seenYears],
  )

  return (
    <div className="tms-dense-page tms-caps">
      <div className="tms-dense-bar">
        <div className="flex items-center gap-3">
          <Truck size={18} />
          <span className="font-semibold">View · Active shipments</span>
          <ShipmentsSectionTabs current={list} activeCount={counts.active} allCount={needWindow && !windowLoading && !allYearsLoading ? counts.all : undefined} />
          {partial && <TmsBadge tone="gray">Adding delivered loads…</TmsBadge>}
          {wantsAllList && (
            <TmsSelect
              aria-label="Year"
              className="tms-dense-select"
              value={String(year)}
              onChange={(e) => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              options={yearOptions}
            />
          )}
          {wantsVoidedList && (
            <div className="flex items-center gap-1" role="group" aria-label="Period">
              <TmsButton size="sm" variant="ghost" aria-label="Previous month" onClick={() => setPeriod({ key: 'month', month: shiftMonth(months[0], -1) })}>‹</TmsButton>
              <TmsSegmentedTabs
                aria-label="Period"
                size="sm"
                active={period.key}
                onSelect={(key) => setPeriod(key === 'month' ? { key: 'month', month: months[0] } : { key: key as 'this' | 'last' | 'last3' })}
                tabs={[
                  { key: 'this', label: 'This month' },
                  { key: 'last', label: 'Last month' },
                  { key: 'last3', label: 'Last 3 months' },
                  ...(period.key === 'month' ? [{ key: 'month', label: months[0] }] : []),
                ]}
              />
              <TmsButton size="sm" variant="ghost" aria-label="Next month" disabled={months[months.length - 1] >= thisMonth} onClick={() => setPeriod({ key: 'month', month: shiftMonth(months[months.length - 1], 1) })}>›</TmsButton>
            </div>
          )}
        </div>
        <span className="tms-dense-spacer" />
        <TmsButton size="sm" variant="primary" data-testid="create-shipment" onClick={() => navigate('/tms/shipments/new')}>
          Create shipment
        </TmsButton>
      </div>

      <div className={`flex min-h-0 flex-1 overflow-hidden ${split ? 'gap-1' : ''}`}>
        <BoardPane
          key={`left-${list}`}
          pane="left"
          list={list}
          year={year}
          allRows={allRows}
          loading={loading}
          error={error}
          refresh={refresh}
          customers={customers}
          locations={locations}
          settings={settings}
          staff={{ staff: staff.staff, me: staff.me, nameOf: staff.nameOf }}
          columnTemplates={columnTemplates}
          refreshTemplates={loadTemplates}
          isOwner={isOwner}
          isAdmin={isAdmin}
          currentUser={email}
          email={email}
          onSplit={() => setSplit((s) => !s)}
          onReport={report}
        />
        {split && (
          <BoardPane
            key={`right-${rightList}`}
            pane="right"
            list={rightList}
            year={year}
            onListChange={setRightList}
            allRows={allRows}
            loading={loading}
            error={error}
            refresh={refresh}
            customers={customers}
            locations={locations}
            settings={settings}
            staff={{ staff: staff.staff, me: staff.me, nameOf: staff.nameOf }}
            columnTemplates={columnTemplates}
            refreshTemplates={loadTemplates}
            isOwner={isOwner}
            isAdmin={isAdmin}
            currentUser={email}
            email={email}
            onSplit={() => setSplit((s) => !s)}
            onReport={report}
          />
        )}
      </div>

    </div>
  )
}

interface StaffSnapshot {
  staff: UserProfileRecord[]
  me: UserProfileRecord | null
  nameOf: (id: string | null | undefined) => string
}

interface PaneReport {
  query: string
}

interface BoardPaneProps {
  pane: 'left' | 'right'
  list: ShipmentList
  /** The All list's year; Active ignores it. */
  year: ShipmentYear
  /** Only the split-screen's right pane picks its own list; the left one follows the URL. */
  onListChange?: (list: ShipmentList) => void
  allRows: ShipmentRow[]
  loading?: boolean
  error?: string | null
  refresh: () => Promise<void>
  customers: CustomerRecord[]
  locations: LocationRecord[]
  settings: TmsSettings | null
  staff: StaffSnapshot
  columnTemplates: ShipmentColumnTemplateRecord[]
  refreshTemplates: () => void
  isOwner: boolean
  isAdmin: boolean
  currentUser: string
  email: string
  onSplit: () => void
  onReport?: (pane: 'left' | 'right', report: PaneReport) => void
}

function BoardPane({
  pane,
  list,
  year,
  onListChange,
  allRows,
  refresh,
  customers,
  locations,
  settings,
  staff,
  columnTemplates,
  refreshTemplates,
  isOwner,
  isAdmin,
  currentUser,
  email,
  onSplit,
  onReport,
}: BoardPaneProps) {
  const { staff: staffProfiles } = staff
  const divisions = useOwnershipDivisions().divisions ?? SEED_DIVISIONS
  const { drivers } = useDrivers()
  const { carriers: directoryCarriers } = useCarriers()
  // Set during render so the Carrier column's text, sort and filter all see the mapping on the first paint.
  useMemo(() => setFleetDrivers(drivers), [drivers])
  const { equipment } = useTrucks()
  // Step W: the roster the batch can book onto Ivan Cartage loads (active, not a broker placeholder).
  const ivanDrivers = useMemo(
    () => drivers.filter((d) => d.active && d.type !== 'broker').sort((a, b) => a.name.localeCompare(b.name)),
    [drivers],
  )
  // Step I teams are a property of the people, so the batch offers exactly the teams
  // somebody is actually on rather than a list nobody maintains.
  const teamKeys = useMemo(
    () => [...new Set(staffProfiles.flatMap((u) => u.teamKeys ?? []))].sort(),
    [staffProfiles],
  )

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
        setParams((prev) => {
          const nextParams = new URLSearchParams(prev)
          if (next) nextParams.set('q', next)
          else nextParams.delete('q')
          return nextParams
        }, { replace: true })
      }
    },
    [urlQuery, setParams, setPageSize],
  )

  const listRows = useMemo(() => allRows.filter((r) => inShipmentList(r, list, year)), [allRows, list, year])

  // Density, sort and the summary strip persist per user and per pane. Columns, widths and pins do
  // not: everybody sees the team default, which only an admin edits (see teamColumnLayout.ts).
  const prefs = useDenseGridPrefs({
    gridId: `shipments-${pane}`,
    email,
    defaultColumns: SHIPMENT_DEFAULT_COLUMNS,
    validKeys: SHIPMENT_COLUMN_KEYS,
    defaultSort: DEFAULT_SORT,
  })
  const teamLayout = useMemo(
    () => resolveTeamLayout(columnTemplates, SHIPMENT_COLUMN_KEYS, SHIPMENT_DEFAULT_COLUMNS),
    [columnTemplates],
  )
  // An admin's unsaved edit of the team layout; null outside edit mode.
  const [layoutDraft, setLayoutDraft] = useState<TeamColumnLayout | null>(null)
  const [layoutSaving, setLayoutSaving] = useState(false)
  const layout = layoutDraft ?? teamLayout
  const columnKeys = layout.columns
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [filters, setFilters] = useState<DenseFilters>({})
  const [flags, setFlags] = useState<ReadonlySet<BoardFlag>>(() => new Set())
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [capRefusal, setCapRefusal] = useState<string | null>(null)
  const [barOutcomes, setBarOutcomes] = useState<BatchOutcome[] | undefined>()
  const [barRunning, setBarRunning] = useState(false)
  const [mapVisible, setMapVisible] = useState(false)
  const [iconKeyOpen, setIconKeyOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchAction, setBatchAction] = useState('')
  const [batchResults, setBatchResults] = useState<BatchTaskResult[] | undefined>()
  const [batchRunning, setBatchRunning] = useState(false)
  const [dialogShipment, setDialogShipment] = useState<ShipmentRow | null>(null)
  // Frozen when opened: the auto-refresh must not pull the rows (and this dialog's Restore) out from under it.
  const [deleteTargets, setDeleteTargets] = useState<Array<{ id: string; number: string }> | null>(null)
  const [dialogKind, setDialogKind] = useState<'unvoid' | 'repoint' | 'cover' | null>(null)

  // The page decides what to fetch, so it hears what this pane is asking for: a typed PRO
  // adds that exact row (R4, §4.3). The Voided list is its own pane list, never a facet of All.
  const wantsVoided = list === 'voided'
  useEffect(() => { onReport?.(pane, { query }) }, [onReport, pane, query])

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

  // The "Demo" chip: only the ZZ DEMO walkthrough rows. It lives in the URL (`?demo=1`)
  // so the isolated view can be bookmarked or handed over as a link.
  const demoOnly = params.get('demo') === '1'
  // Status and PRO # are locked to the left of the grid: they stay put while the rest scrolls sideways.
  const lockedFirst = useMemo(() => {
    const locked = columnKeys.filter((k) => LOCKED_KEYS.includes(k))
    return [...locked, ...columnKeys.filter((k) => !LOCKED_KEYS.includes(k))]
  }, [columnKeys])
  const lockedCount = useMemo(() => columnKeys.filter((k) => LOCKED_KEYS.includes(k)).length, [columnKeys])
  const gridColumns = useMemo(() => {
    const chosen = lockedFirst.map((k) => COLUMN_BY_KEY[k]).filter((c) => c != null)
    return [...chosen, ACTIONS_COLUMN]
  }, [lockedFirst])

  // List scope, then search, then the quick toggles, then voided rows (hidden unless the Status
  // header asks for them), then every header filter. `fitRows` is the list before the header
  // filters: the facet options and auto-fit widths are drawn from it so they do not shift as you filter.
  // The chips count this base: the list after search, scope, voided and demo handling.
  const chipBase = useMemo(
    () =>
      listRows.filter(
        (r) =>
          (!query || matchesQuery(r, query))
          && (wantsVoided || boardStatusOf(r) !== 'VOIDED')
          && (!demoOnly || isDemoShipment(r)),
      ),
    [listRows, query, wantsVoided, demoOnly],
  )
  const chipCounts = useMemo(() => flagCounts(chipBase, Date.now()), [chipBase])
  const fitRows = useMemo(() => {
    if (flags.size === 0) return chipBase
    const nowMs = Date.now()
    return chipBase.filter((r) => matchesFlags(r, flags, nowMs))
  }, [chipBase, flags])
  const filteredRows = useMemo(() => filterRows(fitRows, gridColumns, filters), [fitRows, gridColumns, filters])
  const toggleDemo = useCallback(() => {
    setPageSize(PAGE_SIZE_INITIAL)
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (next.get('demo') === '1') next.delete('demo')
      else next.set('demo', '1')
      return next
    }, { replace: true })
  }, [setParams])
  const sortedRows = useMemo(() => sortDenseRows(filteredRows, gridColumns, prefs.sort), [filteredRows, gridColumns, prefs.sort])
  const shownRows = useMemo(() => sortedRows.slice(0, pageSize), [sortedRows, pageSize])

  const saveTeamLayout = useCallback(async () => {
    if (!layoutDraft) return
    setLayoutSaving(true)
    try {
      await saveShipmentColumnTemplate({
        id: TEAM_DEFAULT_COLUMN_TEMPLATE_ID,
        name: TEAM_DEFAULT_COLUMN_TEMPLATE_NAME,
        columns: layoutDraft.columns,
        widths: layoutDraft.widths,
        pinned: layoutDraft.pinned,
        shared: true,
      })
      toast.success('Team default saved. Everyone sees it now.')
      setLayoutDraft(null)
      refreshTemplates()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setLayoutSaving(false)
    }
  }, [layoutDraft, refreshTemplates])

  /** Every active shipment (the Active list, ignoring this page's tab, filters and columns) with every stored field. */
  const exportAllActive = useCallback(() => {
    const n = exportRecords('active-shipments', allRows.filter((r) => inShipmentList(r, 'active')))
    toast.success(`Exported ${n} active shipments`)
  }, [allRows])

  const exportCsv = useCallback(() => {
    const csv = toCsv(filteredRows, columnKeys)
    saveBlob(new Blob([csv], { type: 'text/csv' }), `shipments-${new Date().toISOString().slice(0, 10)}.csv`)
  }, [filteredRows, columnKeys])

  // Batch task actions. Everything but the CSV runs on the server: one call, one
  // audit row per shipment.
  const batchActions = useMemo<BatchTaskAction[]>(() => {
    const actions: BatchTaskAction[] = []
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
    for (const d of ivanDrivers) {
      actions.push({ key: `driver:${d.id}`, label: `Assign driver (Ivan Cartage): ${d.name}` })
    }
    actions.push({ key: 'export', label: 'Export selected' })
    return actions
  }, [staffProfiles, divisions, teamKeys, ivanDrivers])

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

    // The driver's own truck and trailer ride along, as the single-load dialog pre-fills them.
    const driverParams = (driverId: string): Record<string, unknown> => {
      const d = ivanDrivers.find((x) => x.id === driverId)
      const truck = d?.assignedTruckId ? equipment.find((e) => e.id === d.assignedTruckId) : undefined
      const trailer = d?.assignedTrailerId ? activeUnits(equipment).find((e) => e.id === d.assignedTrailerId) : undefined
      return {
        driverId,
        ...(truck ? { truckId: truck.id, truckNumber: truck.unitNumber } : {}),
        ...(trailer ? { trailerId: trailer.id, trailerNumber: trailer.unitNumber } : {}),
      }
    }
    const task = batchTaskOf(batchAction, driverParams)
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
  }, [batchAction, selectedRows, columnKeys, handleRefresh, ivanDrivers, equipment])

  const toggleRow = useCallback(
    (id: string) => {
      const next = toggleSelection(selectedIds, id)
      setSelectedIds(next.ids)
      setCapRefusal(next.refusal)
    },
    [selectedIds],
  )

  // Step AP: Push to Load Review. Rows that fail their customer's requirements are refused
  // here with every reason; the rest go to the server, which decides each row again.
  // Release is not here: Load Review is the only way into billing.
  const runPush = useCallback(async () => {
    if (selectedRows.length === 0) return
    setBarRunning(true)
    setBarOutcomes(undefined)
    const labelOf = (id: string, fallback: string | null) => selectedRows.find((r) => r.id === id)?.number ?? fallback ?? id
    const refused = pushRefusals(selectedRows, { customers, orgDefault: settings?.reviewRequirements })
    const refusedIds = new Set(refused.map((o) => o.rowId))
    const sendRows = selectedRows.filter((r) => !refusedIds.has(r.id))
    let sent: BatchOutcome[] = []
    if (sendRows.length > 0) {
      try {
        const res = await batchShipmentTask({ task: 'PUSH_TO_LOAD_REVIEW', shipmentIds: sendRows.map((r) => r.id), params: {} })
        sent = outcomesFromServer(res.results, labelOf)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Batch failed'
        sent = sendRows.map((r) => ({ rowId: r.id, rowLabel: r.number, ok: false, reasons: [message] }))
      }
    }
    const order = new Map(selectedRows.map((r, i) => [r.id, i]))
    const all = [...refused, ...sent].sort((a, b) => (order.get(a.rowId) ?? 0) - (order.get(b.rowId) ?? 0))
    setBarOutcomes(all)
    setBarRunning(false)
    // Done rows leave the selection; the ones that failed stay selected so they can be fixed and retried.
    const failedIds = new Set(all.filter((o) => !o.ok).map((o) => o.rowId))
    setSelectedIds((prev) => prev.filter((id) => failedIds.has(id)))
    setCapRefusal(null)
    await handleRefresh()
  }, [selectedRows, customers, settings, handleRefresh])

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
      if (columnKey === 'proNumber') {
        const held = lockHeldByOther(row, email, Date.now())
        return (
          <>
            <Link className="tms-link tms-board-link" to={`/tms/shipments/${row.id}/edit`} onClick={(e) => e.stopPropagation()}>{row.number ?? ''}</Link>
            {held ? <Lock size={12} aria-label={`${held.by} is editing`} data-testid="board-lock-icon" style={{ marginLeft: 4, verticalAlign: 'middle' }}><title>{`${held.by} is editing this shipment`}</title></Lock> : null}
          </>
        )
      }
      if (columnKey === 'status') {
        return <span className="flex items-center gap-1"><span className="font-medium">{statusCellText(row)}</span><TrackingModeNotSetRowChip row={row} /></span>
      }
      if (columnKey === 'delivery') {
        const r = deliveryPhase(phaseInputOfRow(row, Date.now()))
        return <span className="tms-dt-text" data-tone={r.tone} title={r.reason ?? undefined}>{deliveryPhaseText(r)}</span>
      }
      if (columnKey === 'customerName') {
        if (!isCustomerUnresolved(row) && row.customerId) {
          return <Link className="tms-link tms-board-link" to={`/tms/customers?customer=${encodeURIComponent(row.customerId)}`} onClick={(e) => e.stopPropagation()}>{customerDisplayName(row)}</Link>
        }
        if (!isCustomerUnresolved(row)) return <>{customerDisplayName(row)}</>
        return (
          <span className="flex items-center gap-1">
            <span className="tms-muted">{customerDisplayName(row)}</span>
            <TmsBadge tone="orange">Not linked</TmsBadge>
          </span>
        )
      }
      if (columnKey === 'driver') {
        const names = driverNamesOf(row)
        if (names.length === 0) return null
        return <span className="flex flex-wrap items-center gap-1">{names.map((n) => <TmsBadge key={n} tone="gray">{n}</TmsBadge>)}</span>
      }
      if (columnKey === 'carrier') {
        const label = carrierLabel(row)
        const carrierId = carrierIdOfRow(row, directoryCarriers)
        if (carrierId) {
          return <Link className="tms-link tms-board-link" to={`/tms/carriers/${carrierId}`} title={carrierHoverText(row)} onClick={(e) => e.stopPropagation()}>{label}</Link>
        }
        return <span className={cn(label === 'Need to cover' && 'tms-muted')} title={carrierHoverText(row)}>{label}</span>
      }
      if (columnKey === 'arStatus' || columnKey === 'apStatus') {
        const value = columnKey === 'arStatus' ? row.arStatus : row.apStatus
        if (!value) return null
        return (
          <>
            <TmsBadge tone={statusTone(value)}>{sentence(value)}</TmsBadge>
            {columnKey === 'arStatus' && needsBillingReview(row) && (
              <> <TmsBadge tone="orange" title={reviewBillingNote(row)}>{REVIEW_BILLING_LABEL}</TmsBadge></>
            )}
          </>
        )
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
    [directoryCarriers, email],
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
        // Step AM: a load that still needs a truck offers Cover right on its row.
        ...(needsCover(row) ? { onCover: () => { setDialogShipment(row); setDialogKind('cover') } } : {}),
      }
    },
    [refresh],
  )

  const renderCellWithActions = useCallback(
    (row: ShipmentRow, key: string): ReactNode => {
      if (key === 'actions') {
        return (
          <ShipmentRowActions
            shipment={row}
            isAdmin={isAdmin}
            cancelDeleteAdminOnly={settings?.cancelDeleteAdminOnly === true}
            handlers={rowHandlers(row)}
          />
        )
      }
      return renderCell(row, key)
    },
    [renderCell, rowHandlers, isAdmin, settings?.cancelDeleteAdminOnly],
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

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const resetPage = useCallback(() => setPageSize(PAGE_SIZE_INITIAL), [])
  const setColumnFilter = useCallback(
    (key: string, next: DenseColumnFilter | null) => {
      setFilters((prev) => {
        const copy = { ...prev }
        if (next) copy[key] = next
        else delete copy[key]
        return copy
      })
      resetPage()
    },
    [resetPage],
  )
  const clearFilters = useCallback(() => {
    setFilters({})
    setFlags(new Set())
    resetPage()
  }, [resetPage])

  // The summary strip counts what the list shows now, so it follows every filter.
  const kpis = useMemo<DenseKpi[]>(() => {
    if (!prefs.kpiOpen) return []
    let open = 0
    let moving = 0
    let delivered = 0
    let docs = 0
    let revenue = 0
    let profit = 0
    for (const r of filteredRows) {
      const status = boardStatusOf(r)
      if (status === 'OPEN') open += 1
      else if (status === 'DISPATCHED' || status === 'ARRIVED' || status === 'DEPARTED') moving += 1
      else if (status === 'DELIVERED') delivered += 1
      if ((r.docsMissing?.length ?? 0) > 0) docs += 1
      revenue += r.revenueCents ?? 0
      profit += r.profitCents ?? 0
    }
    return [
      { label: 'Shipments', value: filteredRows.length },
      { label: 'Open', value: open },
      { label: 'In transit', value: moving },
      { label: 'Delivered', value: delivered },
      { label: 'Missing docs', value: docs, tone: docs > 0 ? 'warn' : undefined },
      { label: 'Revenue', value: formatCents(revenue) },
      { label: 'Gross profit', value: formatCents(profit), tone: profit < 0 ? 'bad' : 'good' },
    ]
  }, [prefs.kpiOpen, filteredRows])

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="tms-dense-bar">
        <Search size={14} className="tms-muted" aria-hidden="true" />
        <TmsInput
          placeholder="Search"
          aria-label="Search shipments"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="tms-dense-search"
        />
        {onListChange && (
          <TmsSegmentedTabs
            aria-label="Shipment list"
            size="sm"
            active={list}
            onSelect={(key) => onListChange(parseShipmentList(key))}
            tabs={[{ key: 'active', label: 'Active' }, { key: 'all', label: 'All' }, { key: 'voided', label: 'Voided' }]}
          />
        )}
        <TmsFilterChip label="Demo" value={demoOnly ? 'only' : null} onClick={toggleDemo} />
        {/* The filter strip, styled like Load Review's (Needs fixes / Looks ready / All in review): its own strip beside the list strip. */}
        <TmsSegmentedTabs
          aria-label="Shipment filters"
          size="sm"
          active={flags.size === 0 ? 'all' : flags.size === 1 ? [...flags][0] : ''}
          onSelect={(key) => { setFlags(key === 'all' ? new Set() : new Set([key as BoardFlag])); resetPage() }}
          tabs={[
            { key: 'all', label: 'Any' },
            ...BOARD_FLAGS.map((flag) => ({ key: flag, label: BOARD_FLAG_LABELS[flag], count: chipCounts[flag] })),
          ]}
        />
        <ClearFiltersButton count={activeFilterCount(filters) + flags.size} onClear={clearFilters} />
        <span className="tms-dense-spacer" />
        <TmsButton size="sm" variant="secondary" data-testid="export-active-shipments" title="Every active shipment with every field" onClick={exportAllActive}>
          <Download size={14} aria-hidden="true" /> Export all active
        </TmsButton>
        {isAdmin && !layoutDraft && (
          <TmsButton size="sm" variant="secondary" onClick={() => setLayoutDraft({ columns: [...teamLayout.columns], widths: { ...teamLayout.widths }, pinned: [...teamLayout.pinned] })}>
            <Columns3 size={14} aria-hidden="true" /> Edit layout
          </TmsButton>
        )}
        {isAdmin && layoutDraft && (
          <>
            <span className="text-xs text-muted-foreground" role="status">Editing the team layout: drag headers, resize, or use Columns.</span>
            <TmsButton size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>
              <Columns3 size={14} aria-hidden="true" /> Columns
            </TmsButton>
            <TmsButton
              size="sm" variant="secondary" title="Set every column to the width of its longest value"
              onClick={() => setLayoutDraft((d) => (d ? { ...d, widths: withChipRoom(fitColumnWidths(gridColumns.filter((c) => d.columns.includes(c.key)), filteredRows)) } : d))}
            >
              Fit widths
            </TmsButton>
            <TmsButton size="sm" variant="primary" disabled={layoutSaving} onClick={() => void saveTeamLayout()}>
              Save as team default
            </TmsButton>
            <TmsButton size="sm" variant="ghost" disabled={layoutSaving} onClick={() => setLayoutDraft(null)}>
              Cancel
            </TmsButton>
          </>
        )}
        <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
        <SummaryToggle open={prefs.kpiOpen} onToggle={() => prefs.setKpiOpen(!prefs.kpiOpen)} />
      </div>
      <DenseKpiStrip open={prefs.kpiOpen} items={kpis} />
      <CurrentlyViewing rows={allRows} onOpen={(id) => setOpenDrawerId(id)} onChanged={handleRefresh} />
      {isOwner && selectedIds.length > 0 && (
        <div className="tms-dense-bar" data-testid="delete-selected-bar">
          <TmsButton size="sm" variant="destructive" data-testid="delete-selected" onClick={() => setDeleteTargets(selectedRows.map((r) => ({ id: r.id, number: r.number })))}>
            <Trash2 size={14} aria-hidden="true" /> Delete selected ({selectedIds.length})
          </TmsButton>
        </div>
      )}
      <BatchActionBar
        actionLabel="Push to Load Review"
        selectedCount={selectedIds.length}
        running={barRunning}
        refusal={capRefusal}
        outcomes={barOutcomes}
        onRun={() => void runPush()}
        onClear={() => { setSelectedIds([]); setCapRefusal(null); setBarOutcomes(undefined) }}
      />

      <div className="tms-dense-body">
        {mapVisible ? (
          <BoardMapView
            rows={shownRows}
            apiKey={MAPS_KEY}
            mapId={MAPS_MAP_ID}
            onOpenShipment={(id) => setOpenDrawerId(id)}
          />
        ) : (
          <DenseGrid<ShipmentRow>
            uppercase
            aria-label="Shipments"
            recentKey={`tms:shipments:recent:${email}`}
            resetKey={`${query}|${flags.size}|${demoOnly}|${JSON.stringify(filters)}|${JSON.stringify(prefs.sort)}`}
            columns={gridColumns}
            rows={shownRows}
            fitRows={fitRows}
            rowKey={(r) => r.id}
            renderCell={renderCellWithActions}
            density={prefs.density}
            userWidths={layout.widths}
            stickyCount={Math.max(1, lockedCount, layout.pinned.length)}
            sort={prefs.sort}
            onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
            filters={filters}
            onFilterChange={setColumnFilter}
            onReorder={layoutDraft ? (from, to) => setLayoutDraft((d) => {
              if (!d) return d
              const columns = reorderKeys(d.columns, from, to)
              return { ...d, columns, pinned: d.pinned.filter((k) => columns.includes(k)) }
            }) : undefined}
            onResize={layoutDraft ? (key, width) => setLayoutDraft((d) => (d ? { ...d, widths: { ...d.widths, [key]: width } } : d)) : undefined}
            selectable
            selectedIds={selectedSet}
            toneOf={boardRowTone}
            onToggle={toggleRow}
            onToggleAll={() => {
              const next = selectAllUpToCap(selectedIds, shownRows.map((r) => r.id))
              setSelectedIds(next.ids)
              setCapRefusal(next.refusal)
            }}
            empty="No shipments match."
          />
        )}
      </div>

      <BoardFooterBar
        shown={shownRows.length}
        total={filteredRows.length}
        secondsToRefresh={secondsToRefresh}
        autoRefresh={autoRefresh}
        onToggleAutoRefresh={() => setAutoRefresh((a) => !a)}
        pageSize={PAGE_SIZE_INCREMENT}
        onNextPage={() => setPageSize((s) => normalizePageSize(s + PAGE_SIZE_INCREMENT))}
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

      {isAdmin && layoutDraft && (
        <ColumnsDialog
          catalog={SHIPMENT_GRID_COLUMNS}
          open={columnsOpen}
          onOpenChange={setColumnsOpen}
          columns={layoutDraft.columns}
          widths={layoutDraft.widths}
          pinned={layoutDraft.pinned}
          onApply={(next) => setLayoutDraft({ columns: next.columns, widths: next.widths, pinned: next.pinned })}
        />
      )}

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

      {deleteTargets && (
        <DeleteShipmentsDialog
          shipments={deleteTargets}
          onClose={() => setDeleteTargets(null)}
          onDeleted={() => { setSelectedIds([]); setCapRefusal(null); void handleRefresh() }}
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

      {dialogShipment && dialogKind === 'cover' && (
        <CoverCarrierDialog
          shipmentId={dialogShipment.id}
          shipmentNumber={dialogShipment.number}
          onClose={() => setDialogShipment(null)}
          onCovered={() => { void handleRefresh() }}
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
