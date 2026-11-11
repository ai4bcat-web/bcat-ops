/**
 * Shipments › Intake: the tender e-mails that arrived at a division's intake address and became
 * partially built loads. Opens on All loads; "By rev division" / "By customer" split the queue into sub-tabs
 * (?view=&group=), status chips, a table; a row opens the review page.
 */
import { BatchActionBar } from '../board/BatchActionBar'
import { outcomesFromServer, selectAllUpToCap, toggleSelection, type BatchOutcome } from '../batchReview'
import { batchShipmentTask } from '@/lib/apiClient'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Mail, Truck } from 'lucide-react'
import { TmsAlert, TmsBadge, TmsButton, TmsEmptyState, TmsFilterChip, TmsSegmentedTabs } from '@/features/tms/kit'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import {
  ClearFiltersButton,
  ColumnsButton,
  DensityToggle,
  DenseKpiStrip,
  SummaryToggle,
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
import { intakeCounts, isDemoIntake } from '@/lib/intakeLoad'
import type { IntakeLoadRecord, IntakeStatus } from '@/types/intake'
import { ShipmentsSectionTabs } from '../ShipmentsSectionTabs'
import {
  ALL_GROUP,
  UNASSIGNED,
  groupByCustomer,
  groupByDivision,
  parseView,
  resolveGroup,
  rowInGroup,
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

const DEFAULT_COLUMNS = ['received', 'from', 'customer', 'reference', 'route', 'completeness', 'source']

function reviewText(row: IntakeLoadRecord): string {
  if (row.reviewedAt && row.reviewedBy) return 'Reviewed'
  return row.status === 'OPEN' ? 'Needs review' : ''
}

type StatusChip = 'open' | 'moved' | 'dismissed'
const CHIP_STATUS: Record<StatusChip, IntakeStatus> = { open: 'OPEN', moved: 'MOVED', dismissed: 'DISMISSED' }

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
  const { isOwnerOrAdmin } = useIntakePermissions()

  const chip: StatusChip = params.get('status') === 'moved' ? 'moved' : params.get('status') === 'dismissed' ? 'dismissed' : 'open'
  const open = useIntakeLoads({ status: 'OPEN' })
  const other = useIntakeLoads({ status: CHIP_STATUS[chip], enabled: chip !== 'open' })
  const shown = chip === 'open' ? open : other

  const activeDivisions = useMemo(
    () => flattenDivisions(divisions ?? []).filter((r) => r.division.active).map((r) => r.division),
    [divisions],
  )
  const activeCodes = useMemo(() => new Set(activeDivisions.map((d) => d.code)), [activeDivisions])
  const isUnrouted = (row: IntakeLoadRecord) => row.divisionCode == null || !activeCodes.has(row.divisionCode)

  const unroutedShown = isOwnerOrAdmin || open.rows.some(isUnrouted) || (chip !== 'open' && other.rows.some(isUnrouted))
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
  const demoOnly = params.get('demo') === '1'
  const rows = shown.rows.filter((r) => rowInGroup(r, view, selected, activeCodes) && (!demoOnly || isDemoIntake(r)))
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
        text: (r) => `${r.fromName || r.fromEmail} ${r.subject || '(no subject)'}`,
        sortValue: (r) => r.fromName || r.fromEmail,
      },
      { key: 'customer', header: 'Customer', group: 'Order', text: (r) => r.fields.customerName ?? '—', filter: 'multi', optionsOf: (r) => (r.fields.customerName ? [{ value: r.fields.customerName, label: r.fields.customerName }] : []) },
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
    [],
  )
  const prefs = useDenseGridPrefs({
    gridId: 'intake',
    email: user?.email,
    defaultColumns: DEFAULT_COLUMNS,
    validKeys: DEFAULT_COLUMNS,
    defaultSort: { key: 'received', dir: 'desc' },
  })
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
            <span className="tms-intake-from-name">{row.fromName || row.fromEmail}</span>
            <span className="tms-intake-from-subject">{row.subject || '(no subject)'}</span>
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
    <TmsEmptyState compact title="No tender e-mails waiting." message={chip === 'open' ? null : `Nothing ${chip} here.`} />
  )

  return (
    <div className="tms-dense-page">
      <div className="tms-dense-bar">
        <span className="tms-dense-title">
          <Truck size={18} aria-hidden="true" /> Build · Intake
        </span>
        <ShipmentsSectionTabs current="intake" />
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
        <TmsSegmentedTabs
          aria-label="Intake status"
          size="sm"
          active={chip}
          onSelect={(key) => update({ status: key === 'open' ? null : key })}
          tabs={[
            { key: 'open', label: 'Open' },
            { key: 'moved', label: 'Moved' },
            { key: 'dismissed', label: 'Dismissed' },
          ]}
        />
        <TmsFilterChip label="Demo" value={demoOnly ? 'only' : null} onClick={() => update({ demo: demoOnly ? null : '1' })} />
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
        <SummaryToggle open={prefs.kpiOpen} onToggle={() => prefs.setKpiOpen(!prefs.kpiOpen)} />
      </div>
      {isOwnerOrAdmin && missingAddress.length > 0 ? (
        <TmsAlert tone="orange" title="Divisions without an intake e-mail" className="tms-intake-banner">
          {missingAddress.map((d) => d.name).join(', ')} cannot receive tender e-mails yet.{' '}
          <Link to="/tms/brokerage/divisions">Open Divisions</Link>
        </TmsAlert>
      ) : null}
      {shown.error ? <TmsAlert tone="red" title="Could not load intake">{shown.error}</TmsAlert> : null}
      <DenseKpiStrip open={prefs.kpiOpen} items={kpis} />
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
          resetKey={`${view}|${selected}|${chip}|${demoOnly}|${JSON.stringify(filters)}|${JSON.stringify(prefs.sort)}`}
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
          empty={shown.loading ? <TmsBadge tone="gray">Loading…</TmsBadge> : rows.length > 0 ? 'No tender e-mails match the column filters.' : emptyBody}
        />
      </div>
    </div>
  )
}

export default IntakeBoard
