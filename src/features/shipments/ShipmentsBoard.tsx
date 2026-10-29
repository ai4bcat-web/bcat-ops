/**
 * The one Shipments list — MVMNT's list anatomy over BCAT's data (UI reference §2,
 * spec §6.4 "Board", §6.8 status tabs).
 *
 * Title row with Views and "+ Shipment", a filter row of italic chips, the saved
 * department views as tabs, MVMNT's status quick-tabs with counts, the thirteen
 * default columns of a thirty-column set, and the footer the kit draws. All of the
 * deciding lives in `shipmentViews.ts` and `src/lib/shipmentViewDefs.ts`; this file
 * renders what those functions return.
 *
 * Single click opens the drawer, double click opens `/tms/shipments/:id`. Void is the
 * only way a shipment leaves the list, and only the owner or an ADMIN is offered it —
 * the Lambda enforces that from the token, this is only the door.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Check, Download, FileText, MoreHorizontal, RotateCcw, Save, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  TmsBadge, TmsButton, TmsDialog, TmsField, TmsIconButton, TmsInput, TmsListPage, TmsSelect, statusTone,
} from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { useOwnershipDivisions, useShipmentViews } from '@/features/tms/useShipmentViews'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useDocumentReviewQueue } from '@/hooks/useDocumentReviewQueue'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import {
  createShipment, duplicateShipment, getTmsSettings, graphqlErrorText, saveShipmentView,
  setShipmentStatus, tenderRespond,
} from '@/lib/apiClient'
import { checkCallState } from '@/lib/checkCalls'
import { effectiveCustomerStatus } from '@/lib/customerCredit'
import { SEED_DIVISIONS } from '@/lib/ownership'
import { ROLES, ROLE_LABELS } from '@/lib/roles'
import { SHIPMENT_STATUSES } from '@/lib/shipmentStatus'
import { applyViewFilters, slugify, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import { cn } from '@/lib/utils'
import { ShipmentDrawer } from './components/ShipmentDrawer'
import { ShipmentRowActions, type ShipmentActionHandlers } from './components/StatusActions'
import { MODE_OPTIONS } from './orderDraft'
import {
  BOARD_COLUMNS, BOARD_TABS, DEFAULT_COLUMN_KEYS, EMPTY_FILTERS, activeFilterCount, applyBoard,
  carrierLabel, divisionCodeOfViewSlug, filtersToViewFilters, isBoardTabKey, isSortKey,
  statusLabel, tabCounts, toCsv, toViewRow, visibleColumns, voidedAtOf,
  type BoardFilters, type BoardTabKey, type ShipmentRow, type SortDir, type SortKey,
} from './shipmentViews'
import type {
  ApStatus, ArStatus, AssignmentType, CustomerRecord, ShipmentMode, ShipmentStatus, ShipmentViewRecord,
  TmsSettings,
} from '@/types/tms'

const AR_STATUSES: ArStatus[] = ['DOCS_NEEDED', 'UNBILLED', 'UNPAID', 'PAID', 'INVOICE_NOT_NEEDED']
const AP_STATUSES: ApStatus[] = ['AWAITING_INVOICE', 'IN_REVIEW', 'TO_BE_PAID', 'PAID']
const ASSIGNMENT_TYPES: AssignmentType[] = ['OWN_ASSET', 'CARRIER', 'NEED_TO_COVER']
const PAGE_SIZES = [20, 50, 100]

/** The chips of MVMNT's filter row, in MVMNT's order. `all` is the "+ Filter" panel. */
type ChipKey =
  | 'customerId' | 'status' | 'pickup' | 'delivery' | 'origin' | 'destination'
  | 'division' | 'assignmentType' | 'repId' | 'arStatus' | 'all'

const CHIPS: { key: ChipKey; label: string }[] = [
  { key: 'customerId', label: 'Customer is' },
  { key: 'status', label: 'Status is' },
  { key: 'pickup', label: 'Pick Up on' },
  { key: 'delivery', label: 'Delivery on' },
  { key: 'origin', label: 'Origin is' },
  { key: 'destination', label: 'Destination is' },
  { key: 'division', label: 'Division is' },
  { key: 'assignmentType', label: 'Carrier type is' },
  { key: 'repId', label: 'Rep is' },
  { key: 'arStatus', label: 'AR Status is' },
]

const sentence = (value: string): string =>
  value.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

export function ShipmentsBoard() {
  const navigate = useNavigate()
  const { slug } = useParams()
  const { isAdmin, isOwner, user } = useAuth()
  const email = user?.email ?? ''
  const { shipments, loading, error, refresh } = useShipments()
  const { customers, locations } = useDirectory()
  const { nameOf } = useStaff()
  const { views, refresh: refreshViews } = useShipmentViews()
  const { divisions } = useOwnershipDivisions()
  const docReview = useDocumentReviewQueue()
  const [settings, setSettings] = useState<TmsSettings | null>(null)

  const [tab, setTab] = useState<BoardTabKey>('all')
  // The shell's global search sends people here as `?q=…`; while that param is present
  // it IS the search box, so a second search from the top bar changes this list.
  const [params, setParams] = useSearchParams()
  const urlQuery = params.get('q')
  const [typed, setTyped] = useState('')
  const query = urlQuery ?? typed
  const setQuery = (next: string) => {
    setPage(0)
    setTyped(next)
    if (urlQuery !== null) setParams(next ? { q: next } : {}, { replace: true })
  }
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS)
  const [openChip, setOpenChip] = useState<ChipKey | null>(null)
  // Null means "whatever the open view says"; a value means the user overrode it here.
  const [columnOverride, setColumnOverride] = useState<string[] | null>(null)
  const [sortOverride, setSortOverride] = useState<{ key: SortKey; dir: SortDir } | null>(null)
  const [fieldsOpen, setFieldsOpen] = useState(false)
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [newShipmentOpen, setNewShipmentOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [pageSize, setPageSize] = useState(20)
  const [page, setPage] = useState(0)
  // The check-call column is toned against a clock held in state rather than one read
  // during render: a DUE/OVERDUE tone only needs minute granularity, and a render-time
  // `Date.now()` is impure. The lazy initialiser runs outside the render-purity analysis.
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => { getTmsSettings().then(setSettings).catch(() => setSettings(null)) }, [])
  useEffect(() => {
    const t = setInterval(() => { setNowMs(Date.now()) }, 60_000)
    return () => clearInterval(t)
  }, [])

  const caller = useMemo(
    () => {
      const groups = user?.groups ?? []
      const roleGroup = groups.find((g) => g.startsWith('role-'))
      return { groups, role: roleGroup ? roleGroup.slice('role-'.length) : null, isOwner, isAdmin }
    },
    [user?.groups, isOwner, isAdmin],
  )
  const myViews = useMemo(() => viewsVisibleTo(views, caller), [views, caller])

  const divisionRows = divisions ?? SEED_DIVISIONS
  const divisionNameOf = (code: string) => divisionRows.find((d) => d.code === code)?.name ?? code
  const divisionColorOf = (code: string) => divisionRows.find((d) => d.code === code)?.color ?? null

  /** The open view: a saved one, or the sidebar's synthetic per-division slice. */
  const activeView: ShipmentViewRecord | null = myViews.find((v) => v.slug === slug) ?? null
  const divisionSlug = divisionCodeOfViewSlug(slug)
  const viewFilters = useMemo(
    () => activeView?.filters ?? (divisionSlug ? { divisions: [divisionSlug] } : null),
    [activeView, divisionSlug],
  )

  // The review queue is the only place that knows a carrier upload is waiting, so the
  // list borrows its counts for the "Uploads to review" filter. Rows are rebuilt only
  // when something is actually pending — the common case copies nothing.
  const pendingByShipment = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const doc of docReview.documents) counts[doc.shipmentId] = (counts[doc.shipmentId] ?? 0) + 1
    return counts
  }, [docReview.documents])
  const allRows: ShipmentRow[] = useMemo(
    () => (docReview.documents.length === 0
      ? shipments
      : shipments.map((s) => ({ ...s, pendingDocReviewCount: pendingByShipment[s.id] ?? null }))),
    [shipments, pendingByShipment, docReview.documents.length],
  )

  /*
   * A view is a working list, so `applyViewFilters` drops voided rows outright. The
   * Voided tab is the book's record of what was voided, which is a different question,
   * so it is answered over every row rather than over the view's slice.
   */
  const viewRows = useMemo(() => {
    if (!viewFilters || tab === 'voided') return allRows
    const allowed = new Set(applyViewFilters(viewFilters, allRows.map(toViewRow), new Date(nowMs)).map((r) => r.id))
    return allRows.filter((r) => allowed.has(r.id))
  }, [allRows, viewFilters, tab, nowMs])

  const counts = useMemo(() => tabCounts(viewRows, nowMs), [viewRows, nowMs])

  const viewSort = activeView?.sort && isSortKey(activeView.sort.key)
    ? { key: activeView.sort.key, dir: activeView.sort.dir }
    : null
  const sort = sortOverride ?? viewSort ?? { key: 'pickupAppt' as SortKey, dir: 'asc' as SortDir }
  const columnKeys = columnOverride ?? activeView?.columns ?? DEFAULT_COLUMN_KEYS

  const rows = useMemo(
    () => applyBoard(viewRows, { tab, query, filters, sortKey: sort.key, sortDir: sort.dir, nowMs }),
    [viewRows, tab, query, filters, sort.key, sort.dir, nowMs],
  )
  // The page index is clamped rather than reset from an effect: a narrower filter can
  // leave the list shorter than the page the user was on, and a render that shows
  // nothing before an effect fixes it is a blank screen the data never justified.
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1)
  const currentPage = Math.min(page, lastPage)
  const pageRows = rows.slice(currentPage * pageSize, currentPage * pageSize + pageSize)

  const clearFilters = () => { setPage(0); setFilters(EMPTY_FILTERS); setQuery(''); setOpenChip(null) }

  const exportCsv = () => {
    const csv = toCsv(rows, columnKeys)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `shipments-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const chipValue = (key: ChipKey): string | null => {
    switch (key) {
      case 'customerId': return customers.find((c) => c.id === filters.customerId)?.name ?? null
      case 'status': return filters.status ? sentence(filters.status) : null
      case 'pickup': return [filters.pickupFrom, filters.pickupTo].filter(Boolean).join(' – ') || null
      case 'delivery': return [filters.deliveryFrom, filters.deliveryTo].filter(Boolean).join(' – ') || null
      case 'origin': return filters.origin
      case 'destination': return filters.destination
      case 'division': return filters.division ? divisionNameOf(filters.division) : null
      case 'assignmentType': return filters.assignmentType ? sentence(filters.assignmentType) : null
      case 'repId': return filters.repId ? nameOf(filters.repId) : null
      case 'arStatus': return filters.arStatus ? sentence(filters.arStatus) : null
      case 'all': return null
    }
  }

  const columns: Array<ColumnDef<ShipmentRow>> = visibleColumns(columnKeys).map((col) => ({
    key: col.key,
    header: col.label,
    width: col.width,
    sortable: col.sortKey != null,
    render: (row) => <BoardCell columnKey={col.key} text={col.value(row)} row={row} nowMs={nowMs}
      repName={nameOf} divisionName={divisionNameOf} divisionColor={divisionColorOf} />,
  }))
  columns.push({
    key: 'actions',
    header: '',
    width: 44,
    render: (row) => (
      <ShipmentRowActions
        shipment={row}
        isAdmin={isAdmin}
        cancelDeleteAdminOnly={settings?.cancelDeleteAdminOnly ?? false}
        handlers={rowHandlers(row, refresh)}
      />
    ),
  })

  return (
    <>
      <TmsListPage<ShipmentRow>
        title="Shipments"
        primaryAction={{ label: 'Shipment', onClick: () => setNewShipmentOpen(true) }}
        actions={
          <>
            <TmsIconButton aria-label="Clear filters" onClick={clearFilters}>
              <XCircle size={16} />
            </TmsIconButton>
            {(isOwner || isAdmin) && (
              <TmsIconButton aria-label="Save as view" onClick={() => setSaveViewOpen(true)}>
                <Save size={16} />
              </TmsIconButton>
            )}
            <TmsIconButton aria-label="Export CSV" onClick={exportCsv}>
              <FileText size={16} />
            </TmsIconButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <TmsIconButton aria-label="More actions"><MoreHorizontal size={16} /></TmsIconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="tms-portal w-56">
                <DropdownMenuLabel>This list</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => refresh()}>
                  <RotateCcw size={14} className="mr-2" />Refresh
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={exportCsv}>
                  <Download size={14} className="mr-2" />Download CSV
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setFieldsOpen(true)}>Choose fields…</DropdownMenuItem>
                <DropdownMenuItem onSelect={clearFilters}>Clear all filters</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        viewTabs={{
          tabs: [
            { key: '', label: 'All shipments' },
            ...myViews.map((v) => ({ key: v.slug, label: v.name })),
            ...(divisionSlug && !myViews.some((v) => v.slug === slug)
              ? [{ key: slug ?? '', label: divisionNameOf(divisionSlug) }]
              : []),
          ],
          active: slug ?? '',
          onSelect: (key) => {
            setPage(0)
            setColumnOverride(null)
            setSortOverride(null)
            navigate(key ? `/tms/shipments/view/${key}` : '/tms/shipments')
          },
        }}
        quickTabs={{
          tabs: BOARD_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] })),
          active: tab,
          onSelect: (key) => { if (isBoardTabKey(key)) { setPage(0); setTab(key) } },
        }}
        search={{ value: query, onChange: setQuery, placeholder: 'Search' }}
        onRefresh={() => refresh()}
        filterChips={CHIPS.map((chip) => ({
          key: chip.key,
          label: chip.label,
          value: chipValue(chip.key),
          onClick: () => setOpenChip((open) => (open === chip.key ? null : chip.key)),
        }))}
        onAddFilter={() => setOpenChip((open) => (open === 'all' ? null : 'all'))}
        fieldsLabel={`${columnKeys.length} Fields`}
        onFields={() => setFieldsOpen(true)}
        columns={columns}
        rows={pageRows}
        rowKey={(row) => row.id}
        sort={sort}
        onSort={(key) => {
          if (!isSortKey(key)) return
          setSortOverride(sort.key === key
            ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
            : { key, dir: 'asc' })
        }}
        onRowClick={(row) => setOpenId(row.id)}
        onRowDoubleClick={(row) => navigate(`/tms/shipments/${row.id}`)}
        page={{
          from: rows.length === 0 ? 0 : currentPage * pageSize + 1,
          to: Math.min(rows.length, currentPage * pageSize + pageSize),
          total: rows.length,
          pageSize,
          onPageSize: (size) => { setPage(0); setPageSize(PAGE_SIZES.includes(size) ? size : 20) },
        }}
        emptyText={error ?? (loading ? 'Loading shipments…' : 'Please try again using a different query.')}
        onClearFilters={clearFilters}
        banner={openChip ? (
          <FilterPanel
            chip={openChip}
            filters={filters}
            customers={customers.map((c) => ({ id: c.id, name: c.name }))}
            divisions={divisionRows.map((d) => ({ code: d.code, name: d.name }))}
            repName={nameOf}
            reps={repIdsOn(allRows)}
            onChange={(next) => { setPage(0); setFilters(next) }}
            onClose={() => setOpenChip(null)}
          />
        ) : null}
        footerExtra={
          rows.length > pageSize ? (
            <span className="tms-footer-count">
              <TmsButton size="sm" disabled={currentPage === 0} onClick={() => setPage(Math.max(0, currentPage - 1))}>
                Previous
              </TmsButton>{' '}
              <TmsButton
                size="sm"
                disabled={currentPage >= lastPage}
                onClick={() => setPage(Math.min(lastPage, currentPage + 1))}
              >
                Next
              </TmsButton>
            </span>
          ) : null
        }
      />


      <ShipmentDrawer
        shipmentId={openId}
        onClose={() => setOpenId(null)}
        onChanged={refresh}
        customers={customers}
        locations={locations}
        settings={settings}
        isAdmin={isAdmin}
        currentUser={email}
      />

      <FieldsDialog
        open={fieldsOpen}
        keys={columnKeys}
        onClose={() => setFieldsOpen(false)}
        onChange={setColumnOverride}
      />

      {(isOwner || isAdmin) && (
        <SaveViewDialog
          open={saveViewOpen}
          onClose={() => setSaveViewOpen(false)}
          onSave={async (draft) => {
            const saved = await saveShipmentView({
              ...draft,
              filters: filtersToViewFilters(filters, query, tab),
              columns: [...columnKeys],
              sort: { key: sort.key, dir: sort.dir },
              sortOrder: (views.at(-1)?.sortOrder ?? 0) + 10,
              active: true,
            })
            await refreshViews()
            toast.success(`Saved the view "${saved.name}"`)
            setSaveViewOpen(false)
            navigate(`/tms/shipments/view/${saved.slug}`)
          }}
        />
      )}

      {newShipmentOpen && (
        <NewShipmentDialog
          customers={customers}
          defaultMode={(settings?.defaultMode as ShipmentMode | undefined) ?? 'FTL'}
          onClose={() => setNewShipmentOpen(false)}
          onCreated={(id) => { setNewShipmentOpen(false); refresh(); setOpenId(id) }}
        />
      )}
    </>
  )
}

/** Every rep id the list actually carries, so the Rep chip offers names, not a guess. */
function repIdsOn(rows: readonly ShipmentRow[]): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.salesRepId) ids.add(row.salesRepId)
    if (row.customerRepId) ids.add(row.customerRepId)
  }
  return [...ids].sort()
}

/**
 * One cell. Most columns are their own text, but status and division are chips, the
 * exception count is a badge, and the check-call clock is coloured by `checkCallState`
 * — the same function the worklist and the notifier read, so one load is never amber
 * here and red there.
 */
function BoardCell({ columnKey, text, row, nowMs, repName, divisionName, divisionColor }: {
  columnKey: string
  text: string
  row: ShipmentRow
  nowMs: number
  repName: (id: string | null | undefined) => string
  divisionName: (code: string) => string
  divisionColor: (code: string) => string | null
}) {
  if (columnKey === 'status') {
    const voidedAt = voidedAtOf(row)
    const label = statusLabel(row)
    return (
      <TmsBadge
        tone={statusTone(label)}
        title={voidedAt
          ? `Voided ${new Date(voidedAt).toLocaleString()} by ${row.voidedBy ?? 'unknown'}${row.voidReason ? ` — ${row.voidReason}` : ''}`
          : undefined}
      >
        {label}
      </TmsBadge>
    )
  }
  if (columnKey === 'division') {
    if (!row.revDivision) return null
    const color = divisionColor(row.revDivision)
    return (
      <span
        className="tms-division-chip"
        data-testid="board-division"
        style={color ? { borderColor: color, color } : undefined}
      >
        {row.revSubdivision
          ? `${divisionName(row.revDivision)} (${divisionName(row.revSubdivision)})`
          : divisionName(row.revDivision)}
      </span>
    )
  }
  if (columnKey === 'salesRepId') {
    const id = row.salesRepId ?? row.customerRepId ?? null
    return <>{id ? repName(id) : ''}</>
  }
  if (columnKey === 'carrier') {
    return <span className={cn(carrierLabel(row) === 'Need to cover' && 'tms-muted')}>{text}</span>
  }
  if (columnKey === 'arStatus' || columnKey === 'apStatus') {
    if (!text) return null
    return <TmsBadge tone={statusTone(columnKey === 'arStatus' ? row.arStatus ?? '' : row.apStatus ?? '')}>{text}</TmsBadge>
  }
  if (columnKey === 'openIncidentCount') {
    const open = row.openIncidentCount ?? 0
    if (open === 0) return null
    return <TmsBadge tone="red"><span data-testid="board-exceptions">{open}</span></TmsBadge>
  }
  if (columnKey === 'docsMissing') {
    // Blank means the gate has never run for this shipment. Saying "complete" there
    // would be a claim nothing has checked.
    if (row.docsMissing == null) return null
    if (row.docsMissing.length === 0) {
      return <Check size={14} className="text-[color:var(--tms-badge-green)]" data-testid="board-docs" data-state="complete" />
    }
    return (
      <TmsBadge tone="orange">
        <span data-testid="board-docs" data-state="missing" title={row.docsMissing.join(', ')}>
          {row.docsMissing.length} missing
        </span>
      </TmsBadge>
    )
  }
  if (columnKey === 'nextCheckCallAt') {
    const state = checkCallState({ nextCheckCallAt: row.nextCheckCallAt }, nowMs)
    return (
      <span
        data-testid="board-next-check-call"
        data-state={state}
        className={cn(
          'tabular-nums',
          state === 'OVERDUE' && 'tms-overdue',
          state === 'DUE' && 'tms-due',
        )}
      >
        {text}
      </span>
    )
  }
  return <>{text}</>
}

/**
 * The row menu acts on the row itself: every one of these needs only the shipment id and
 * the `updatedAt` the user is looking at, both of which the list already holds. Opening
 * the drawer first would be a round trip for nothing. There is no delete and no restore:
 * Void is the only exit, and the void dialog makes that call itself.
 */
function rowHandlers(row: ShipmentRow, refresh: () => void): ShipmentActionHandlers {
  const shipmentId = row.id
  const expectedUpdatedAt = row.updatedAt
  // The rethrow is for the menu's `run`, which keeps its dialog open on failure and
  // swallows the error there — the toast below is the only report the user gets.
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      toast.success(label)
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${label} failed`)
      throw err
    }
  }
  return {
    onDuplicate: (copies, sameCarrier) =>
      run(`${copies.length} copy${copies.length === 1 ? '' : 'ies'} created`,
        () => duplicateShipment({ shipmentId, copies, sameCarrier })),
    onSetStatus: (status, reason) =>
      run('Status updated', () => setShipmentStatus({ shipmentId, expectedUpdatedAt, status, reason })),
    onVoid: () => { toast.success(`${row.number} voided`); refresh() },
    onTenderRespond: (decision, reason) =>
      run('Tender updated', () => tenderRespond({ shipmentId, expectedUpdatedAt, decision, reason })),
  }
}

/**
 * One chip's editor, under the filter row. `all` is the "+ Filter" panel: every filter
 * the list has, including the ones MVMNT has no chip for (mode, AP, the tracking and
 * paperwork toggles), so nothing the board could narrow by before has been lost.
 */
function FilterPanel({ chip, filters, customers, divisions, reps, repName, onChange, onClose }: {
  chip: ChipKey
  filters: BoardFilters
  customers: { id: string; name: string }[]
  divisions: { code: string; name: string }[]
  reps: string[]
  repName: (id: string | null | undefined) => string
  onChange: (filters: BoardFilters) => void
  onClose: () => void
}) {
  const set = <K extends keyof BoardFilters>(key: K, value: BoardFilters[K]) => onChange({ ...filters, [key]: value })
  const show = (key: ChipKey) => chip === 'all' || chip === key

  return (
    <div className="tms-filter-panel tms-card" data-testid="filter-panel">
      <div className="tms-grid tms-grid-3">
        {show('customerId') && (
          <TmsField label="Customer">
            <TmsSelect
              aria-label="Filter customer"
              value={filters.customerId ?? ''}
              onChange={(e) => set('customerId', e.target.value || null)}
            >
              <option value="">All</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </TmsSelect>
          </TmsField>
        )}
        {show('status') && (
          <TmsField label="Status">
            <TmsSelect
              aria-label="Filter status"
              value={filters.status ?? ''}
              onChange={(e) => set('status', (e.target.value || null) as ShipmentStatus | null)}
            >
              <option value="">All</option>
              {SHIPMENT_STATUSES.map((s) => <option key={s} value={s}>{sentence(s)}</option>)}
            </TmsSelect>
          </TmsField>
        )}
        {show('pickup') && (
          <>
            <TmsField label="Pick up from">
              <TmsInput
                aria-label="Filter pickup from" type="date" value={filters.pickupFrom ?? ''}
                onChange={(e) => set('pickupFrom', e.target.value || null)}
              />
            </TmsField>
            <TmsField label="Pick up to">
              <TmsInput
                aria-label="Filter pickup to" type="date" value={filters.pickupTo ?? ''}
                onChange={(e) => set('pickupTo', e.target.value || null)}
              />
            </TmsField>
          </>
        )}
        {show('delivery') && (
          <>
            <TmsField label="Delivery from">
              <TmsInput
                aria-label="Filter delivery from" type="date" value={filters.deliveryFrom ?? ''}
                onChange={(e) => set('deliveryFrom', e.target.value || null)}
              />
            </TmsField>
            <TmsField label="Delivery to">
              <TmsInput
                aria-label="Filter delivery to" type="date" value={filters.deliveryTo ?? ''}
                onChange={(e) => set('deliveryTo', e.target.value || null)}
              />
            </TmsField>
          </>
        )}
        {show('origin') && (
          <TmsField label="Origin">
            <TmsInput
              aria-label="Filter origin" placeholder="City or state" value={filters.origin ?? ''}
              onChange={(e) => set('origin', e.target.value || null)}
            />
          </TmsField>
        )}
        {show('destination') && (
          <TmsField label="Destination">
            <TmsInput
              aria-label="Filter destination" placeholder="City or state" value={filters.destination ?? ''}
              onChange={(e) => set('destination', e.target.value || null)}
            />
          </TmsField>
        )}
        {show('division') && (
          <TmsField label="Division">
            <TmsSelect
              aria-label="Filter division"
              value={filters.division ?? ''}
              onChange={(e) => set('division', e.target.value || null)}
            >
              <option value="">All</option>
              {divisions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </TmsSelect>
          </TmsField>
        )}
        {show('assignmentType') && (
          <TmsField label="Carrier type">
            <TmsSelect
              aria-label="Filter carrier type"
              value={filters.assignmentType ?? ''}
              onChange={(e) => set('assignmentType', (e.target.value || null) as AssignmentType | null)}
            >
              <option value="">All</option>
              {ASSIGNMENT_TYPES.map((t) => <option key={t} value={t}>{sentence(t)}</option>)}
            </TmsSelect>
          </TmsField>
        )}
        {show('repId') && (
          <TmsField label="Rep">
            <TmsSelect
              aria-label="Filter rep"
              value={filters.repId ?? ''}
              onChange={(e) => set('repId', e.target.value || null)}
            >
              <option value="">All</option>
              {reps.map((id) => <option key={id} value={id}>{repName(id)}</option>)}
            </TmsSelect>
          </TmsField>
        )}
        {show('arStatus') && (
          <TmsField label="AR status">
            <TmsSelect
              aria-label="Filter AR status"
              value={filters.arStatus ?? ''}
              onChange={(e) => set('arStatus', (e.target.value || null) as ArStatus | null)}
            >
              <option value="">All</option>
              {AR_STATUSES.map((s) => <option key={s} value={s}>{sentence(s)}</option>)}
            </TmsSelect>
          </TmsField>
        )}
        {chip === 'all' && (
          <>
            <TmsField label="AP status">
              <TmsSelect
                aria-label="Filter AP status"
                value={filters.apStatus ?? ''}
                onChange={(e) => set('apStatus', (e.target.value || null) as ApStatus | null)}
              >
                <option value="">All</option>
                {AP_STATUSES.map((s) => <option key={s} value={s}>{sentence(s)}</option>)}
              </TmsSelect>
            </TmsField>
            <TmsField label="Mode">
              <TmsSelect
                aria-label="Filter mode"
                value={filters.mode ?? ''}
                onChange={(e) => set('mode', (e.target.value || null) as ShipmentMode | null)}
              >
                <option value="">All</option>
                {MODE_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </TmsSelect>
            </TmsField>
          </>
        )}
      </div>

      {chip === 'all' && (
        <div className="tms-filter-toggles">
          {([
            ['checkCallDue', 'Check call due'],
            ['checkCallOverdue', 'Overdue'],
            ['openExceptions', 'Open exceptions'],
            ['docsMissing', 'Docs missing'],
            ['uploadsToReview', 'Uploads to review'],
          ] as const).map(([key, label]) => (
            <label key={key} className="tms-check">
              <input
                type="checkbox"
                aria-label={`Filter ${label.toLowerCase()}`}
                checked={filters[key] === true}
                onChange={(e) => set(key, e.target.checked ? true : null)}
              />
              {label}
            </label>
          ))}
        </div>
      )}

      <div className="tms-filter-panel-foot">
        <span className="tms-muted">{activeFilterCount(filters)} filters on</span>
        <TmsButton size="sm" onClick={onClose}>Done</TmsButton>
      </div>
    </div>
  )
}

/** The "N Fields" picker: which of the thirty columns this list shows. */
function FieldsDialog({ open, keys, onClose, onChange }: {
  open: boolean
  keys: readonly string[]
  onClose: () => void
  onChange: (keys: string[]) => void
}) {
  return (
    <TmsDialog open={open} onOpenChange={(next) => { if (!next) onClose() }} title="Fields" className="tms-dialog-wide">
      <div className="tms-grid tms-grid-3">
        {BOARD_COLUMNS.map((c) => (
          <label key={c.key} className="tms-check">
            <input
              type="checkbox"
              checked={keys.includes(c.key)}
              onChange={() => onChange(
                keys.includes(c.key)
                  ? keys.filter((k) => k !== c.key)
                  : BOARD_COLUMNS.filter((col) => col.key === c.key || keys.includes(col.key)).map((col) => col.key),
              )}
            />
            {c.label}
          </label>
        ))}
      </div>
    </TmsDialog>
  )
}

interface ViewDraft {
  name: string
  department: string | null
  description: string | null
  audience: { groups: string[] } | null
  isDefault: boolean
  slug: string
}

/** "Save as view" — the chips on screen become a department view everyone named can open. */
function SaveViewDialog({ open, onClose, onSave }: {
  open: boolean
  onClose: () => void
  onSave: (draft: ViewDraft) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [department, setDepartment] = useState('')
  const [description, setDescription] = useState('')
  const [roles, setRoles] = useState<string[]>([])
  const [isDefault, setIsDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim()) { setError('Name the view.'); return }
    setBusy(true)
    try {
      await onSave({
        name: name.trim(),
        slug: slugify(name),
        department: department.trim() || null,
        description: description.trim() || null,
        audience: roles.length > 0 ? { groups: roles.map((r) => `role-${r}`) } : null,
        isDefault,
      })
    } catch (err) {
      setError(graphqlErrorText(err) || (err instanceof Error ? err.message : 'Save failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={(next) => { if (!next && !busy) onClose() }}
      title="Save as view"
      description="The filters, columns and sort on screen become a view in the sidebar."
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => { void submit() }} disabled={busy}>
            {busy ? 'Saving…' : 'Save view'}
          </TmsButton>
        </>
      }
    >
      <TmsField label="Name" error={error}>
        <TmsInput aria-label="View name" value={name} onChange={(e) => { setName(e.target.value); setError(null) }} />
      </TmsField>
      <TmsField label="Department" hint="Dispatch, Accounting, Sales…">
        <TmsInput aria-label="Department" value={department} onChange={(e) => setDepartment(e.target.value)} />
      </TmsField>
      <TmsField label="Description">
        <TmsInput aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </TmsField>
      <TmsField label="Who sees it" hint="Nobody named means everyone who can open Shipments.">
        <div className="tms-filter-toggles">
          {ROLES.filter((r) => r !== 'NONE').map((role) => (
            <label key={role} className="tms-check">
              <input
                type="checkbox"
                aria-label={ROLE_LABELS[role]}
                checked={roles.includes(role)}
                onChange={(e) => setRoles((prev) => (e.target.checked ? [...prev, role] : prev.filter((r) => r !== role)))}
              />
              {ROLE_LABELS[role]}
            </label>
          ))}
        </div>
      </TmsField>
      <label className="tms-check">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Open this view by default
      </label>
    </TmsDialog>
  )
}

/** "+ Shipment" — active customers only, exactly as MVMNT gates it (spec §6.4). */
function NewShipmentDialog({ customers, defaultMode, onClose, onCreated }: {
  customers: CustomerRecord[]
  defaultMode: ShipmentMode
  onClose: () => void
  onCreated: (shipmentId: string) => void
}) {
  const [customerId, setCustomerId] = useState('')
  const [mode, setMode] = useState<ShipmentMode>(defaultMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Dormant is an automatic "no shipment in 90 days" label that new freight clears, so a
  // dormant customer is still shippable; only the lead stages, Pending and Blocked are
  // refused. The Lambda re-checks — this list exists so the user is not offered a name
  // the server will reject.
  const now = new Date().toISOString()
  const active = customers.filter((c) => {
    const status = effectiveCustomerStatus(c, null, now)
    return status === 'ACTIVE' || status === 'DORMANT'
  })

  return (
    <TmsDialog
      open
      onOpenChange={(next) => { if (!next) onClose() }}
      title="New shipment"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            disabled={busy}
            onClick={async () => {
              if (!customerId) { setError('Pick a customer.'); return }
              setBusy(true)
              try {
                const bundle = await createShipment({ customerId, mode })
                onCreated(bundle.shipment.id)
              } catch (err) {
                setError(graphqlErrorText(err) || (err instanceof Error ? err.message : 'Create failed'))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Creating…' : 'Create draft'}
          </TmsButton>
        </>
      }
    >
      <TmsField label="Customer" hint="Only active customers can be shipped." error={error}>
        <TmsSelect aria-label="Customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">— select —</option>
          {active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </TmsSelect>
      </TmsField>
      <TmsField label="Mode">
        <TmsSelect aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value as ShipmentMode)}>
          {MODE_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </TmsSelect>
      </TmsField>
    </TmsDialog>
  )
}
