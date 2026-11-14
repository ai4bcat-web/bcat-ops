/**
 * Shipments › Intake: the tender e-mails that arrived at a division's intake address and became
 * partially built loads. Opens on All loads; "By rev division" / "By customer" split the queue into sub-tabs
 * (?view=&group=), a table; a row opens the review page. Only open loads are listed (Ryne 2026-11-12): moved
 * and dismissed ones simply leave. Rows stay one line; duplicate / already-built flags and team notes open in a dialog.
 */
import { BatchActionBar } from '../board/BatchActionBar'
import { outcomesFromServer, selectAllUpToCap, toggleSelection, type BatchOutcome } from '../batchReview'
import { batchShipmentTask } from '@/lib/apiClient'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Mail, Truck, X } from 'lucide-react'
import { TmsAlert, TmsBadge, TmsButton, TmsEmptyState, TmsSegmentedTabs } from '@/features/tms/kit'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import {
  ClearFiltersButton,
  ColumnsButton,
  DensityToggle,
  DenseKpiStrip,
} from '@/features/tms/grid/DenseControls'
import {
  activeFilterCount,
  filterRows,
  nextSort,
  reorderKeys,
  sortDenseRows,
  type DenseColumn,
  type DenseColumnFilter,
  type DenseFilters,
} from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'
import { useAuth } from '@/hooks/useAuth'
import { flattenDivisions } from '@/features/tms/settings/taxonomyDrafts'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { formatDateTime } from '@/lib/date'
import { intakeCounts } from '@/lib/intakeLoad'
import { isDeletedIntake } from '@/lib/intakeDup'
import { duplicateGroups } from '@/lib/intakeDuplicates'
import { DeleteIntakeDialog, IntakeItemDialog, IntakeRowFlags } from './DuplicateParts'
import { useAutolinkBuilt, useBuiltMatches } from './useBuiltMatches'
import type { IntakeLoadRecord } from '@/types/intake'
import {
  ALL_GROUP,
  UNASSIGNED,
  groupByCustomer,
  groupByDivision,
  parseView,
  resolveGroup,
  rowInGroup,
  withDivisionColumn,
  type IntakeView,
} from './intakeGroups'
import { useIntakeLoads } from './useIntakeLoads'
import { useIntakePermissions } from './useIntakePermissions'
import './intake.css'


function rememberedView(key: string): IntakeView | null {
  try {
    const v = parseView(window.localStorage.getItem(key))
    return v === 'all' ? null : v
  } catch {
    return null
  }
}

function rememberView(key: string, view: IntakeView): void {
  try {
    window.localStorage.setItem(key, view)
  } catch {
    // storage unavailable: the view just is not remembered
  }
}

const DEFAULT_COLUMNS = ['received', 'from', 'customer', 'division', 'reference', 'route', 'completeness', 'source']

function divisionColumnAddedKey(email: string | null | undefined): string {
  return `tms:intake:division-column-added:${email ?? 'anon'}`
}

function reviewText(row: IntakeLoadRecord): string {
  if (row.reviewedAt && row.reviewedBy) return 'Reviewed'
  return row.status === 'OPEN' ? 'Needs review' : ''
}

const BANNER_KEY = 'tms:intake:divisions-banner-hidden'

function bannerHidden(): boolean {
  try {
    return window.localStorage.getItem(BANNER_KEY) === '1'
  } catch {
    return false
  }
}

function cityState(stop: { city: string | null; state: string | null } | undefined): string {
  if (!stop) return '—'
  const parts = [stop.city, stop.state].filter(Boolean)
  return parts.length ? parts.join(', ') : '—'
}

function route(row: IntakeLoadRecord): string {
  const stops = row.fields.stops
  const pickup = stops.find((s) => s.type === 'pickup')
  const delivery = [...stops].reverse().find((s) => s.type === 'delivery')
  return `${cityState(pickup)} → ${cityState(delivery)}`
}

function completeness(row: IntakeLoadRecord): string {
  const { required, missing, toCheck } = intakeCounts(row)
  const base = `${required - missing} of ${required} required`
  return toCheck > 0 ? `${base} · ${toCheck} to check` : base
}

export function IntakeBoard() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const [filters, setFilters] = useState<DenseFilters>({})
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [capRefusal, setCapRefusal] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<BatchOutcome[] | undefined>()
  const [pushing, setPushing] = useState(false)
  const { divisions } = useOwnershipDivisions()
  const { isOwnerOrAdmin, canReview } = useIntakePermissions()
  const [deleting, setDeleting] = useState<IntakeLoadRecord | null>(null)
  const [itemId, setItemId] = useState<string | null>(null)
  const [hideBanner, setHideBanner] = useState(bannerHidden)

  const open = useIntakeLoads({ status: 'OPEN' })

  const activeDivisions = useMemo(
    () => flattenDivisions(divisions ?? []).filter((r) => r.division.active).map((r) => r.division),
    [divisions],
  )
  const activeCodes = useMemo(() => new Set(activeDivisions.map((d) => d.code)), [activeDivisions])
  const isUnrouted = (row: IntakeLoadRecord) => row.divisionCode == null || !activeCodes.has(row.divisionCode)

  const unroutedShown = isOwnerOrAdmin || open.rows.some(isUnrouted)
  const viewKey = `tms:intake:view:${user?.email ?? 'anon'}`
  const rawView = params.get('view')
  const legacyDivision = params.get('division')
  // A bare ?group= (no ?view) follows the view this person last used; with nothing in the URL the page is always All loads.
  const view: IntakeView =
    rawView != null ? parseView(rawView)
    : legacyDivision ? 'division'
    : params.get('group') ? (rememberedView(viewKey) ?? 'all')
    : 'all'
  const requestedGroup = params.get('group') ?? (legacyDivision === 'unrouted' ? UNASSIGNED : legacyDivision)

  useEffect(() => {
    if (view !== 'all') rememberView(viewKey, view)
  }, [view, viewKey])

  const groups = useMemo(() => {
    if (view === 'division') return groupByDivision(open.rows, activeDivisions).filter((g) => g.id !== UNASSIGNED || unroutedShown)
    if (view === 'customer') return groupByCustomer(open.rows)
    return []
  }, [view, open.rows, activeDivisions, unroutedShown])
  const selected = resolveGroup(groups, requestedGroup)
  const tabs = [{ id: ALL_GROUP, label: 'All', count: open.rows.length }, ...groups].map((g) => ({
    key: g.id, label: g.label, count: g.count, testId: `intake-group-${g.id}`, countTestId: `intake-group-count-${g.id}`,
  }))

  const division = view === 'division' ? activeDivisions.find((d) => d.code === selected) : undefined
  // Rows an admin deleted are out of every tab; duplicates are found among the open queue.
  const dups = useMemo(() => duplicateGroups(open.rows), [open.rows])
  const { matches: built } = useBuiltMatches(open.rows)
  // A row whose reference already belongs to exactly one built shipment is tied to it and leaves the queue (the server checks again).
  useAutolinkBuilt(built, open.refresh)
  const divisionName = useMemo(() => {
    const names = new Map(flattenDivisions(divisions ?? []).map((r) => [r.division.code, r.division.name]))
    return (r: IntakeLoadRecord) => {
      const code = r.fields.divisionCode ?? r.divisionCode
      return code ? (names.get(code) ?? code) : '—'
    }
  }, [divisions])
  const rows = open.rows.filter((r) => !isDeletedIntake(r) && rowInGroup(r, view, selected, activeCodes))
  const missingAddress = activeDivisions.filter((d) => !d.intakeEmail)

  function update(next: Record<string, string | null>) {
    const copy = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v == null) copy.delete(k)
      else copy.set(k, v)
    }
    setParams(copy, { replace: true })
  }

  function selectView(next: string) {
    const v = parseView(next)
    update({ view: v === 'all' ? null : v, group: null, division: null })
  }

  const columns = useMemo<Array<DenseColumn<IntakeLoadRecord>>>(
    () => [
      { key: 'received', header: 'Received', group: 'E-mail', text: (r) => formatDateTime(r.receivedAt), filter: 'date', dateOf: (r) => r.receivedAt, sortValue: (r) => r.receivedAt },
      {
        key: 'from',
        header: 'From / Subject',
        group: 'E-mail',
        width: 640,
        text: (r) => `${r.fromName || r.fromEmail} ${r.subject || '(no subject)'}`,
        sortValue: (r) => r.fromName || r.fromEmail,
      },
      { key: 'customer', header: 'Customer', group: 'Order', text: (r) => r.fields.customerName ?? '—', filter: 'multi', optionsOf: (r) => (r.fields.customerName ? [{ value: r.fields.customerName, label: r.fields.customerName }] : []) },
      { key: 'division', header: 'Rev division', group: 'Order', text: divisionName, filter: 'multi', optionsOf: (r) => { const n = divisionName(r); return n === '—' ? [] : [{ value: n, label: n }] } },
      { key: 'reference', header: 'Reference', group: 'Order', text: (r) => r.fields.reference ?? '—' },
      { key: 'route', header: 'Pickup → Delivery', group: 'Order', text: route },
      {
        key: 'completeness',
        header: 'Completeness',
        group: 'Review',
        text: completeness,
        filter: 'number',
        numberOf: (r) => {
          const { required, missing } = intakeCounts(r)
          return required - missing
        },
        numberUnit: 'required fields filled',
      },
      {
        key: 'review',
        header: 'Review',
        group: 'Review',
        text: reviewText,
        filter: 'multi',
        fixedOptions: [{ value: 'Reviewed', label: 'Reviewed' }, { value: 'Needs review', label: 'Needs review' }],
      },
      { key: 'source', header: 'E-mail', text: () => '', fixed: true, filter: false, sortable: false, width: 190 },
    ],
    [divisionName],
  )
  const prefs = useDenseGridPrefs({
    gridId: 'intake',
    email: user?.email,
    defaultColumns: DEFAULT_COLUMNS,
    validKeys: DEFAULT_COLUMNS,
    defaultSort: { key: 'received', dir: 'desc' },
  })
  const { columns: savedColumns, setColumns } = prefs
  useEffect(() => {
    if (savedColumns.includes('division')) return
    const key = divisionColumnAddedKey(user?.email)
    try {
      if (window.localStorage.getItem(key) === '1') return
      window.localStorage.setItem(key, '1')
    } catch {
      return
    }
    setColumns(withDivisionColumn(savedColumns))
  }, [savedColumns, setColumns, user?.email])
  const gridColumns = useMemo(
    () => [
      ...prefs.columns.filter((k) => k !== 'source').map((k) => columns.find((c) => c.key === k)).filter((c) => c != null),
      ...columns.filter((c) => c.key === 'source'),
    ],
    [prefs.columns, columns],
  )
  const filteredRows = useMemo(() => filterRows(rows, columns, filters), [rows, columns, filters])
  const sortedRows = useMemo(() => sortDenseRows(filteredRows, columns, prefs.sort), [filteredRows, columns, prefs.sort])
  const setColumnFilter = useCallback((key: string, next: DenseColumnFilter | null) => {
    setFilters((prev) => {
      const copy = { ...prev }
      if (next) copy[key] = next
      else delete copy[key]
      return copy
    })
  }, [])
  const kpis = useMemo(
    () => [
      { label: 'Tender e-mails', value: sortedRows.length },
      { label: 'Need review', value: sortedRows.filter((r) => reviewText(r) === 'Needs review').length, tone: 'warn' as const },
      { label: 'Reviewed', value: sortedRows.filter((r) => reviewText(r) === 'Reviewed').length, tone: 'good' as const },
    ],
    [sortedRows],
  )

  const renderCell = (row: IntakeLoadRecord, key: string) => {
    switch (key) {
      case 'from':
        return (
          <div className="tms-intake-from">
            <div className="tms-intake-from-head" title={`${row.fromName || row.fromEmail}: ${row.subject || '(no subject)'}`}>
              <span className="tms-intake-from-name">{row.fromName || row.fromEmail}</span>
              <span className="tms-intake-from-subject">{row.subject || '(no subject)'}</span>
            </div>
            <IntakeRowFlags row={row} dup={dups.get(row.id)} built={built.get(row.id)} onOpen={() => setItemId(row.id)} />
          </div>
        )
      case 'completeness':
        return <span className="tms-intake-completeness">{completeness(row)}</span>
      case 'review':
        if (row.reviewedAt && row.reviewedBy) return <TmsBadge tone="green">Reviewed</TmsBadge>
        return row.status === 'OPEN' ? <TmsBadge tone="orange">Needs review</TmsBadge> : '—'
      case 'source':
        return (
          <span className="tms-intake-row-actions">
          <Link
            className="tms-intake-source-link"
            to={`/tms/workflows/runs/${row.runId}`}
            aria-label="Open the source e-mail run"
            onClick={(e) => e.stopPropagation()}
          >
            <Mail size={14} aria-hidden="true" />
          </Link>
          {row.status === 'OPEN' ? (
            <TmsButton
              size="sm"
              data-testid="intake-create-shipment"
              onClick={(e) => { e.stopPropagation(); navigate(`/tms/shipments/intake/${encodeURIComponent(row.id)}`) }}
            >
              Create shipment
            </TmsButton>
          ) : null}
          </span>
        )
      default:
        return columns.find((c) => c.key === key)?.text(row) ?? null
    }
  }

  const toggleRow = (id: string) => {
    const next = toggleSelection(selectedIds, id)
    setSelectedIds(next.ids)
    setCapRefusal(next.refusal)
  }

  // Push to Load Review acts on the shipment an intake row became. An intake row that has not
  // become one yet is refused with the reason; the server then decides each shipment itself.
  async function pushSelected() {
    const picked = sortedRows.filter((r) => selectedIds.includes(r.id))
    if (picked.length === 0) return
    setPushing(true)
    setOutcomes(undefined)
    const unlinked: BatchOutcome[] = picked
      .filter((r) => !r.shipmentId)
      .map((r) => ({ rowId: r.id, rowLabel: r.subject || r.fromEmail, ok: false, reasons: ['No shipment yet: create the shipment first'] }))
    const linked = picked.filter((r) => r.shipmentId)
    let sent: BatchOutcome[] = []
    if (linked.length > 0) {
      const byShipment = new Map(linked.map((r) => [r.shipmentId as string, r]))
      try {
        const res = await batchShipmentTask({ task: 'PUSH_TO_LOAD_REVIEW', shipmentIds: linked.map((r) => r.shipmentId as string), params: {} })
        sent = outcomesFromServer(res.results, (id, fallback) => byShipment.get(id)?.shipmentNumber ?? fallback ?? id)
          .map((o) => ({ ...o, rowId: byShipment.get(o.rowId)?.id ?? o.rowId }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Batch failed'
        sent = linked.map((r) => ({ rowId: r.id, rowLabel: r.shipmentNumber ?? r.id, ok: false, reasons: [message] }))
      }
    }
    const all = [...unlinked, ...sent]
    setOutcomes(all)
    setPushing(false)
    const failedIds = new Set(all.filter((o) => !o.ok).map((o) => o.rowId))
    setSelectedIds((prev) => prev.filter((id) => failedIds.has(id)))
    setCapRefusal(null)
  }

  const noAddress = division != null && !division.intakeEmail
  const emptyBody = noAddress ? (
    <TmsEmptyState
      compact
      title={`No intake e-mail set for ${division.name}`}
      message={
        isOwnerOrAdmin ? (
          <Link to="/tms/brokerage/divisions">Set one under Divisions &amp; ownership</Link>
        ) : (
          'Ask an owner to set the address tender e-mails for this division arrive at.'
        )
      }
    />
  ) : (
    <TmsEmptyState compact title="No tender e-mails waiting." message={null} />
  )

  return (
    <div className="tms-dense-page">
      <div className="tms-dense-bar">
        <span className="tms-dense-title">
          <Truck size={18} aria-hidden="true" /> Build · Intake
        </span>
        <TmsSegmentedTabs
          aria-label="Intake view"
          size="sm"
          active={view}
          onSelect={selectView}
          tabs={[
            { key: 'all', label: 'All loads', testId: 'intake-view-all' },
            { key: 'division', label: 'By rev division', testId: 'intake-view-division' },
            { key: 'customer', label: 'By customer', testId: 'intake-view-customer' },
          ]}
        />
        {view !== 'all' ? (
          <TmsSegmentedTabs
            aria-label={view === 'division' ? 'Rev division' : 'Customer'}
            size="sm"
            tabs={tabs}
            active={selected}
            onSelect={(key) => update({ view, group: key === ALL_GROUP ? null : key, division: null })}
          />
        ) : null}
        <ClearFiltersButton count={activeFilterCount(filters)} onClear={() => setFilters({})} />
        <span className="tms-dense-spacer" />
        <ColumnsButton
          catalog={columns}
          columns={prefs.columns.filter((k) => k !== 'source')}
          widths={prefs.widths}
          pinned={prefs.pinned}
          onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })}
        />
        <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
      </div>
      {isOwnerOrAdmin && missingAddress.length > 0 && !hideBanner ? (
        <p className="tms-intake-banner-compact" data-testid="intake-divisions-banner">
          <span>No intake e-mail yet: {missingAddress.map((d) => d.name).join(', ')}.</span>{' '}
          <Link to="/tms/brokerage/divisions">Open Divisions</Link>
          <button
            type="button"
            className="tms-intake-banner-x"
            aria-label="Hide this notice"
            data-testid="intake-divisions-banner-hide"
            onClick={() => {
              setHideBanner(true)
              try { window.localStorage.setItem(BANNER_KEY, '1') } catch { /* storage unavailable: hidden until reload */ }
            }}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </p>
      ) : null}
      {open.error ? <TmsAlert tone="red" title="Could not load intake">{open.error}</TmsAlert> : null}
      <DenseKpiStrip open items={kpis} />
      <BatchActionBar
        actionLabel="Push to Load Review"
        selectedCount={selectedIds.length}
        running={pushing}
        refusal={capRefusal}
        outcomes={outcomes}
        onRun={() => void pushSelected()}
        onClear={() => { setSelectedIds([]); setCapRefusal(null); setOutcomes(undefined) }}
      />
      <div className="tms-dense-body">
        <DenseGrid<IntakeLoadRecord>
          aria-label="Intake"
          recentKey={`tms:intake:recent:${user?.email ?? 'anon'}`}
          resetKey={`${view}|${selected}|${JSON.stringify(filters)}|${JSON.stringify(prefs.sort)}`}
          columns={gridColumns}
          rows={sortedRows}
          fitRows={rows}
          rowKey={(r) => r.id}
          selectable
          selectedIds={new Set(selectedIds)}
          onToggle={toggleRow}
          onToggleAll={() => {
            const next = selectAllUpToCap(selectedIds, sortedRows.map((r) => r.id))
            setSelectedIds(next.ids)
            setCapRefusal(next.refusal)
          }}
          renderCell={renderCell}
          density={prefs.density}
          userWidths={prefs.widths}
          stickyCount={Math.max(1, prefs.pinned.length)}
          sort={prefs.sort}
          onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
          filters={filters}
          onFilterChange={setColumnFilter}
          onReorder={(from, to) => prefs.setColumns(reorderKeys(prefs.columns, from, to))}
          onResize={prefs.setWidth}
          onRowClick={(r) => navigate(`/tms/shipments/intake/${encodeURIComponent(r.id)}`)}
          empty={open.loading ? <TmsBadge tone="gray">Loading…</TmsBadge> : rows.length > 0 ? 'No tender e-mails match the column filters.' : emptyBody}
        />
      </div>
      {itemId && !deleting ? (() => {
        const item = open.rows.find((r) => r.id === itemId)
        return item ? (
          <IntakeItemDialog
            row={item}
            dup={dups.get(item.id)}
            built={built.get(item.id)}
            isAdmin={isOwnerOrAdmin}
            canReview={canReview}
            onClose={() => setItemId(null)}
            onDelete={() => setDeleting(item)}
            onChanged={() => open.refresh()}
          />
        ) : null
      })() : null}
      {deleting ? (
        <DeleteIntakeDialog
          row={deleting}
          open
          onOpenChange={(o) => { if (!o) setDeleting(null) }}
          onDeleted={() => { setDeleting(null); setItemId(null); open.refresh() }}
        />
      ) : null}
    </div>
  )
}

export default IntakeBoard
