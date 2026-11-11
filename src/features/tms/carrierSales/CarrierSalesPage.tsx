/**
 * `/tms/carrier-sales` — the loads that still need a truck, the offers waiting on us and
 * the covered loads on the carrier assignment ladder (Step AM). Cover opens the Cover dialog (MC lookup,
 * MyCarrierPackets preview, setup packet, assign); the Covered tab shows each load's rung and filters by it,
 * and Open goes to the shipment's Carrier tab where the ladder's buttons live. Sending, signing and driver
 * info happen there, never from this list.
 */
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Search, Truck } from 'lucide-react'
import { TmsBadge, TmsButton, TmsInput, TmsSegmentedTabs, TmsSelect } from '@/features/tms/kit'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import { ClearFiltersButton, ColumnsButton, DenseKpiStrip, DensityToggle, SummaryToggle, type DenseKpi } from '@/features/tms/grid/DenseControls'
import { activeFilterCount, filterRows, nextSort, reorderKeys, sortDenseRows, type DenseColumn, type DenseColumnFilter, type DenseFilters } from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'
import { CoverCarrierDialog } from '@/features/carriers/cover/CoverCarrierDialog'
import { CarrierAssignmentChip } from '@/features/shipments/components/CarrierAssignmentChip'
import { LADDER_FILTER_OPTIONS } from '@/features/shipments/carrierLadder'
import type { CarrierAssignmentStatus } from '@/lib/carrierAssignment'
import { useAuth } from '@/hooks/useAuth'
import { useQuoteWorklist } from '@/hooks/useQuoteWorklist'
import { useShipments } from '@/hooks/useShipments'
import type { ShipmentListRow } from '@/hooks/useShipments'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import { mcpPacketStanding } from '@/lib/mcpPacket'
import type { QuoteRecord, RateConStatus } from '@/types/tms'
import { QuotePostingsCard } from './QuotePostingsCard'
import { coveredRows, needsCoverRows, offersByShipment, openOffers } from './carrierSalesQueue'
import { CarrierLookup } from './CarrierLookup'
import { OffersHub } from './OffersHub'
import { UnmatchedOffers } from './UnmatchedOffers'
import { CarrierOffersPanel } from './CarrierOffersPanel'
import { DemoLoads } from './DemoLoads'
import { targetFromDemo, targetFromRow, type OffersTarget } from './offersTarget'
import { useUnmatchedOffers } from './useUnmatchedOffers'

type TabKey = 'needs-cover' | 'offers' | 'unmatched' | 'covered'
const TAB_KEYS: readonly TabKey[] = ['needs-cover', 'offers', 'unmatched', 'covered']

const DAY_MS = 86_400_000

const RATE_CON_LABEL: Record<RateConStatus, string> = {
  NOT_SENT: 'Not sent',
  SENT: 'Sent',
  OPENED: 'Opened',
  SIGNED: 'Signed',
  DECLINED: 'Declined',
  VOIDED: 'Voided',
  EXPIRED: 'Expired',
}

const PAGE_STEP = 50

function carrierTabPath(shipmentId: string): string {
  return `/tms/shipments/${shipmentId}?tab=carrier`
}

function laneText(row: ShipmentListRow): string {
  const from = row.originCity || row.fromState || '—'
  const to = row.destinationCity || row.toState || '—'
  return `${from} → ${to}`
}

/** Pickup time, red once it is under 24 h away (or already past). */
function PickupCell({ iso, now }: { iso: string | null | undefined; now: number }) {
  if (!iso) return <span className="tms-muted">—</span>
  const at = Date.parse(iso)
  const urgent = Number.isFinite(at) && at - now < DAY_MS
  return <span style={urgent ? { color: 'var(--tms-badge-red)', fontWeight: 600 } : undefined}>{formatDateTime(iso)}</span>
}

function PacketChip({ row }: { row: ShipmentListRow }) {
  if (!row.carrierMc) return null
  const standing = mcpPacketStanding({ mcpStatus: row.mcpStatus })
  return (
    <TmsBadge tone={standing.completed ? 'green' : 'orange'} title={standing.completed ? undefined : standing.reason}>
      {standing.completed ? 'Packet complete' : 'No packet'}
    </TmsBadge>
  )
}

interface OffersState {
  open: QuoteRecord[]
  error: string | null
  refresh: () => Promise<void>
}

/** Only mounted for a user with the Quotes grant: the worklist read is quotes-gated server-side. */
function WithWorklist() {
  const worklist = useQuoteWorklist()
  return <CarrierSalesView offers={{ open: worklist.open, error: worklist.error, refresh: worklist.refresh }} />
}

export function CarrierSalesPage() {
  const { hasPageAccess } = useAuth()
  return hasPageAccess('quotes') ? <WithWorklist /> : <CarrierSalesView offers={null} />
}

function CarrierSalesView({ offers }: { offers: OffersState | null }) {
  const { hasPageAccess, user } = useAuth()
  const { shipments, loading: shipmentsLoading, partial, error, refresh } = useShipments({ kind: 'working' })
  // URL-owned: ?tab=offers&load=<PRO|shipmentId>, ?tab=unmatched
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  const tab: TabKey = TAB_KEYS.find((k) => k === tabParam) ?? 'needs-cover'
  const setTab = (next: TabKey) => setParams(next === 'needs-cover' ? {} : { tab: next }, { replace: true })
  const loadParam = params.get('load')
  const setLoad = (value: string | null) => setParams(value ? { tab: 'offers', load: value } : { tab: 'offers' }, { replace: true })
  const unmatched = useUnmatchedOffers()
  const [search, setSearch] = useState('')
  // Step AM: Cover opens a dialog right here instead of hopping to the shipment, and the Covered tab filters by ladder rung.
  const [coverRow, setCoverRow] = useState<ShipmentListRow | null>(null)
  // Click any load to see its offers by channel (voice + email). Only the labelled demo loads carry (fake) offers.
  const [offersTarget, setOffersTarget] = useState<OffersTarget | null>(null)
  const [ladderFilter, setLadderFilter] = useState<CarrierAssignmentStatus | 'ALL'>('ALL')
  const [pageSize, setPageSize] = useState(PAGE_STEP)
  const [dense, setDense] = useState<DenseFilters>({})
  const [now] = useState(() => Date.now())

  const canOpenShipment = hasPageAccess('loads') || hasPageAccess('tms')

  const needs = useMemo(() => needsCoverRows(shipments) as ShipmentListRow[], [shipments])
  const covered = useMemo(() => coveredRows(shipments) as ShipmentListRow[], [shipments])
  const offerRows = useMemo(() => (offers ? openOffers(offers.open) : []), [offers])
  const offerCounts = useMemo(() => offersByShipment(offers?.open ?? []), [offers])

  const q = search.trim().toLowerCase()
  const matchShipment = (r: ShipmentListRow) =>
    q === '' ||
    [r.number, r.customerName, r.carrierName, r.carrierMc, r.originCity, r.destinationCity, r.equipmentType]
      .some((v) => (v ?? '').toLowerCase().includes(q))
  const ladderLabel = (r: ShipmentListRow) => LADDER_FILTER_OPTIONS.find((o) => o.value === r.carrierAssignmentStatus)?.label ?? ''
  const rateConText = (r: ShipmentListRow) => (r.rateConSignedAt ? 'Signed' : RATE_CON_LABEL[r.rateConStatus ?? 'NOT_SENT'])
  const pickupSort = (r: ShipmentListRow) => (r.pickupAppt ? Date.parse(r.pickupAppt) || null : null)
  const opt = (v: string | null | undefined) => (v ? [{ value: v, label: v }] : [])
  const actionCol = (key: string): DenseColumn<ShipmentListRow> => ({ key, header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 84 })

  const needsDense = useMemo<Array<DenseColumn<ShipmentListRow>>>(() => [
    { key: 'shipment', header: 'Shipment', group: 'Shipment', text: (r) => r.number ?? '' },
    { key: 'customer', header: 'Customer', group: 'Shipment', text: (r) => r.customerName || '—', filter: 'multi', optionsOf: (r) => opt(r.customerName) },
    { key: 'lane', header: 'Lane', group: 'Shipment', text: laneText },
    { key: 'pickup', header: 'Pickup', group: 'Shipment', text: (r) => (r.pickupAppt ? formatDateTime(r.pickupAppt) : '—'), sortValue: pickupSort, filter: 'date', dateOf: (r) => r.pickupAppt ?? null },
    { key: 'equipment', header: 'Equipment', group: 'Shipment', text: (r) => r.equipmentType || '—', filter: 'multi', optionsOf: (r) => opt(r.equipmentType) },
    { key: 'rate', header: 'Customer rate', group: 'Money', text: (r) => (r.customerRateCents == null ? '—' : formatCents(r.customerRateCents)), align: 'right', filter: 'number', numberOf: (r) => (r.customerRateCents == null ? null : r.customerRateCents / 100), numberUnit: '$' },
    { key: 'posted', header: 'Posted', group: 'Offers', text: (r) => (r.datPostedAt ? 'Posted' : ''), extraPx: 16, filter: 'multi', fixedOptions: [{ value: 'Posted', label: 'Posted' }], optionsOf: (r) => (r.datPostedAt ? [{ value: 'Posted', label: 'Posted' }] : []) },
    { key: 'offers', header: 'Offers', group: 'Offers', text: (r) => (offers ? String(offerCounts.get(r.id) ?? 0) : '—'), align: 'right', filter: 'number', numberOf: (r) => (offers ? offerCounts.get(r.id) ?? 0 : null) },
  ], [offers, offerCounts])

  const coveredDense = useMemo<Array<DenseColumn<ShipmentListRow>>>(() => [
    { key: 'shipment', header: 'Shipment', group: 'Shipment', text: (r) => r.number ?? '' },
    { key: 'carrier', header: 'Carrier', group: 'Carrier', text: (r) => `${r.carrierName || '—'}${r.carrierMc ? ` MC ${r.carrierMc}` : ''}`, extraPx: 8 },
    { key: 'pickup', header: 'Pickup', group: 'Shipment', text: (r) => (r.pickupAppt ? formatDateTime(r.pickupAppt) : '—'), sortValue: pickupSort, filter: 'date', dateOf: (r) => r.pickupAppt ?? null },
    { key: 'ratecon', header: 'Rate con', group: 'Carrier', text: rateConText, extraPx: 16, filter: 'multi' },
    { key: 'sent', header: 'Sent', group: 'Carrier', text: (r) => formatDateTime(r.rateConSentAt), sortValue: (r) => r.rateConSentAt ?? '', filter: 'date', dateOf: (r) => r.rateConSentAt ?? null },
    { key: 'ladder', header: 'Carrier status', group: 'Carrier', text: ladderLabel, extraPx: 40, filter: 'multi' },
    { key: 'packet', header: 'Packet', group: 'Carrier', text: (r) => (!r.carrierMc ? '' : mcpPacketStanding({ mcpStatus: r.mcpStatus }).completed ? 'Packet complete' : 'No packet'), extraPx: 16, filter: 'multi' },
  ], [])

  const isCovered = tab === 'covered'
  const catalog = isCovered ? coveredDense : needsDense
  const prefs = useDenseGridPrefs({
    gridId: isCovered ? 'carrier-sales-covered' : 'carrier-sales-needs',
    email: user?.email ?? '',
    defaultColumns: catalog.map((c) => c.key),
    validKeys: catalog.map((c) => c.key),
    defaultSort: null,
  })
  const gridColumns = useMemo(() => [
    ...prefs.columns.map((k) => catalog.find((c) => c.key === k)).filter((c): c is DenseColumn<ShipmentListRow> => c != null),
    ...(canOpenShipment ? [actionCol(isCovered ? 'open' : 'cover')] : []),
  ], [catalog, prefs.columns, canOpenShipment, isCovered])

  const renderCell = (r: ShipmentListRow, key: string): React.ReactNode => {
    switch (key) {
      case 'shipment': return <strong>{r.number}</strong>
      case 'customer': return r.customerName || '—'
      case 'lane': return laneText(r)
      case 'pickup': return <PickupCell iso={r.pickupAppt} now={now} />
      case 'equipment': return r.equipmentType || '—'
      case 'rate': return r.customerRateCents == null ? '—' : formatCents(r.customerRateCents)
      case 'posted': return r.datPostedAt ? <TmsBadge tone="blue">Posted</TmsBadge> : null
      case 'offers': return offers ? offerCounts.get(r.id) ?? 0 : <span className="tms-muted">—</span>
      case 'cover': return <TmsButton variant="primary" size="sm" aria-label={`Cover ${r.number}`} data-testid="cover-row" onClick={(e) => { e.stopPropagation(); setCoverRow(r) }}>Cover</TmsButton>
      case 'carrier': return <span>{r.carrierName || '—'}{r.carrierMc ? <span className="tms-muted" style={{ marginLeft: 4, fontSize: 12 }}>MC {r.carrierMc}</span> : null}</span>
      case 'ratecon': return <TmsBadge tone={r.rateConSignedAt ? 'green' : r.rateConStatus && r.rateConStatus !== 'NOT_SENT' ? 'orange' : 'gray'}>{rateConText(r)}</TmsBadge>
      case 'sent': return formatDateTime(r.rateConSentAt)
      case 'ladder': return <CarrierAssignmentChip ladder={r.carrierAssignmentStatus} shipmentStatus={r.status} />
      case 'packet': return <PacketChip row={r} />
      case 'open': return <Link className="tms-btn tms-btn-secondary tms-btn-sm" to={carrierTabPath(r.id)} aria-label={`Open ${r.number}`} onClick={(e) => e.stopPropagation()}>Open</Link>
      default: return null
    }
  }

  const needsFiltered = needs.filter(matchShipment)
  const coveredFiltered = covered.filter(matchShipment).filter((r) => ladderFilter === 'ALL' || r.carrierAssignmentStatus === ladderFilter)
  const searched = isCovered ? coveredFiltered : needsFiltered
  const filtered = sortDenseRows(filterRows(searched, catalog, dense), catalog, prefs.sort)
  const page = filtered.slice(0, pageSize)

  const setDenseFilter = (key: string, next: DenseColumnFilter | null) => {
    setPageSize(PAGE_STEP)
    setDense((prev) => { const copy = { ...prev }; if (next) copy[key] = next; else delete copy[key]; return copy })
  }
  const clearAll = () => { setSearch(''); setDense({}); setLadderFilter('ALL'); setPageSize(PAGE_STEP) }
  const onTab = (key: string) => { setDense({}); setPageSize(PAGE_STEP); setTab(key as TabKey) }

  const tabs = [
    { key: 'needs-cover', label: 'Needs cover', count: needs.length },
    { key: 'offers', label: 'Offers', count: offers ? offerRows.length : undefined },
    { key: 'unmatched', label: 'Unmatched', count: unmatched.data?.length },
    { key: 'covered', label: 'Covered', count: covered.length },
  ]

  const onRefresh = () => { void refresh(); void offers?.refresh() }
  const gridTab = tab === 'needs-cover' || tab === 'covered'
  const kpis: DenseKpi[] = isCovered
    ? [
        { label: 'Covered loads', value: covered.length },
        { label: 'Rate con signed', value: covered.filter((r) => r.rateConSignedAt).length, tone: 'good' },
        { label: 'No packet', value: covered.filter((r) => r.carrierMc && !mcpPacketStanding({ mcpStatus: r.mcpStatus }).completed).length, tone: 'warn' },
      ]
    : [
        { label: 'Needs cover', value: needs.length },
        { label: 'Pickup < 24 h', value: needs.filter((r) => r.pickupAppt && Date.parse(r.pickupAppt) - now < DAY_MS).length, tone: 'bad' },
        { label: 'Posted', value: needs.filter((r) => r.datPostedAt).length },
        { label: 'With offers', value: needs.filter((r) => (offerCounts.get(r.id) ?? 0) > 0).length, tone: 'good' },
      ]

  const loadFailure = error ? 'Couldn’t load shipments. Try refreshing.' : null
  const emptyFor = (empty: string) => loadFailure ?? (shipmentsLoading || partial ? 'Loading…' : empty)

  return (
    <>
      <div className="tms-dense-page tms-caps">
        <div className="tms-dense-bar">
          <span className="tms-dense-title"><Truck size={18} aria-hidden="true" /> Book · Carrier sales</span>
          <Search size={14} className="tms-muted" aria-hidden="true" />
          <TmsInput className="tms-dense-search" aria-label="Search" placeholder="Search shipment, customer, carrier, lane…" value={search} onChange={(e) => { setSearch(e.target.value); setPageSize(PAGE_STEP) }} />
          <TmsSegmentedTabs aria-label="Carrier sales tabs" size="sm" active={tab} onSelect={onTab} tabs={tabs} />
          {isCovered && (
            <label className="flex items-center gap-2" style={{ fontSize: 12 }}>
              <span className="tms-muted">Carrier status</span>
              <TmsSelect aria-label="Carrier status filter" value={ladderFilter} onChange={(e) => { setLadderFilter(e.target.value as CarrierAssignmentStatus | 'ALL'); setPageSize(PAGE_STEP) }}>
                <option value="ALL">All</option>
                {LADDER_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </TmsSelect>
            </label>
          )}
          {gridTab && <ClearFiltersButton count={activeFilterCount(dense) + (search.trim() ? 1 : 0)} onClear={clearAll} />}
          <span className="tms-dense-spacer" />
          <TmsButton size="sm" variant="secondary" onClick={onRefresh}>Refresh</TmsButton>
          {gridTab && (
            <>
              <SummaryToggle open={prefs.kpiOpen} onToggle={() => prefs.setKpiOpen(!prefs.kpiOpen)} />
              <ColumnsButton catalog={catalog} columns={prefs.columns} widths={prefs.widths} pinned={prefs.pinned} onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })} />
              <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
            </>
          )}
        </div>
        <div className="tms-dense-bar" style={{ display: 'grid', gap: 8 }}>
          <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>
            Need a carrier that is not in the directory?{' '}
            <Link to="/tms/carriers/find?from=carrier-sales" data-testid="launch-find-invite">Find &amp; invite a carrier</Link>
          </p>
          <CarrierLookup needsCover={needs} onCovered={() => { void refresh() }} />
          <QuotePostingsCard />
        </div>
        {gridTab ? (
          <>
            <DenseKpiStrip open={prefs.kpiOpen} items={kpis} />
            {!isCovered && <DemoLoads onOpen={(d) => setOffersTarget(targetFromDemo(d))} />}
            <div className="tms-dense-body">
              <DenseGrid<ShipmentListRow>
                aria-label={isCovered ? 'Covered loads' : 'Loads needing cover'}
                recentKey={`tms:carrier-sales:${tab}:recent:${user?.email || 'anon'}`}
                resetKey={`${tab}|${search}|${ladderFilter}|${JSON.stringify(dense)}`}
                columns={gridColumns}
                rows={page}
                fitRows={searched}
                rowKey={(r) => r.id}
                renderCell={renderCell}
                onRowClick={(r) => setOffersTarget(targetFromRow(r))}
                density={prefs.density}
                userWidths={prefs.widths}
                stickyCount={Math.max(1, prefs.pinned.length + 1)}
                sort={prefs.sort}
                onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
                filters={dense}
                onFilterChange={setDenseFilter}
                onReorder={(from, to) => prefs.setColumns(reorderKeys(prefs.columns, from, to))}
                onResize={prefs.setWidth}
                empty={emptyFor(isCovered ? 'No covered load is waiting on a rate confirmation.' : 'Every live load has a carrier.')}
              />
              {filtered.length > page.length && (
                <div className="tms-dense-bar" data-testid="carrier-sales-more">
                  <span className="tms-muted">Showing {page.length} of {filtered.length}</span>
                  <TmsButton size="sm" variant="secondary" onClick={() => setPageSize((n) => n + PAGE_STEP)}>Show next {PAGE_STEP}</TmsButton>
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{ display: 'grid', gap: 12, padding: 12 }}>
            {tab === 'offers' ? (
              <OffersHub
                shipments={shipments as ShipmentListRow[]}
                loadParam={loadParam}
                onLoadChange={setLoad}
                openOffers={offers ? offers.open : null}
                openOffersError={offers?.error ?? null}
                onChanged={onRefresh}
              />
            ) : (
              <UnmatchedOffers rows={unmatched.data ?? []} loading={unmatched.loading} error={unmatched.error} onChanged={unmatched.refresh} />
            )}
          </div>
        )}
      </div>
      <CarrierOffersPanel target={offersTarget} onClose={() => setOffersTarget(null)} />
      {coverRow && (
        <CoverCarrierDialog
          shipmentId={coverRow.id}
          shipmentNumber={coverRow.number}
          onClose={() => setCoverRow(null)}
          onCovered={() => { void refresh() }}
        />
      )}
    </>
  )
}
