/**
 * `/tms/carrier-sales` — the loads that still need a truck, the offers waiting on us and
 * the covered loads on the carrier assignment ladder (Step AM). Cover opens the Cover dialog (MC lookup,
 * MyCarrierPackets preview, setup packet, assign); the Covered tab shows each load's rung and filters by it,
 * and Open goes to the shipment's Carrier tab where the ladder's buttons live. Sending, signing and driver
 * info happen there, never from this list.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TmsBadge, TmsButton, TmsCard, TmsListPage, TmsSelect } from '@/features/tms/kit'
import { CoverCarrierDialog } from '@/features/carriers/cover/CoverCarrierDialog'
import { CarrierAssignmentChip } from '@/features/shipments/components/CarrierAssignmentChip'
import { LADDER_FILTER_OPTIONS } from '@/features/shipments/carrierLadder'
import type { CarrierAssignmentStatus } from '@/lib/carrierAssignment'
import type { ColumnDef } from '@/features/tms/kit'
import { expiryChip, statusLabel, theirNumberCents, whoseMoveLabel } from '@/features/quotes/quoteViews'
import type { QuoteChip } from '@/features/quotes/quoteViews'
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

type TabKey = 'needs-cover' | 'offers' | 'covered'

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

const CHIP_TONE: Record<QuoteChip['tone'], 'gray' | 'orange' | 'red' | 'green'> = {
  muted: 'gray',
  warn: 'orange',
  danger: 'red',
  good: 'green',
}

const MONEY_CELL: React.CSSProperties = { display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

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

/** The Step T notice: findable, honest, inert. */
function StepTCard() {
  return (
    <TmsCard title="Step T — backburnered">
      <p className="tms-muted" style={{ fontSize: 13, margin: 0 }}>
        Distribution e-mail, threshold routing, the voice agent and a unified e-mail + call history per load are
        backburnered (Step T). Nothing on this page sends, calls or routes automatically.
      </p>
    </TmsCard>
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
  const { hasPageAccess } = useAuth()
  const { shipments, loading: shipmentsLoading, partial, error, refresh } = useShipments({ kind: 'working' })
  const [tab, setTab] = useState<TabKey>('needs-cover')
  const [search, setSearch] = useState('')
  // Step AM: Cover opens a dialog right here instead of hopping to the shipment, and the Covered tab filters by ladder rung.
  const [coverRow, setCoverRow] = useState<ShipmentListRow | null>(null)
  const [ladderFilter, setLadderFilter] = useState<CarrierAssignmentStatus | 'ALL'>('ALL')
  const [pageSize, setPageSize] = useState(50)
  const [now] = useState(() => Date.now())
  const [nowIso] = useState(() => new Date().toISOString())

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
  const matchOffer = (o: QuoteRecord) =>
    q === '' ||
    [o.id, o.shipmentNumber, o.loadNumber, o.carrierName, o.carrierMc].some((v) => (v ?? '').toLowerCase().includes(q))

  const shipmentLink = (id: string, label: string) =>
    canOpenShipment ? <Link to={carrierTabPath(id)}>{label}</Link> : <span>{label}</span>

  const needsColumns: Array<ColumnDef<ShipmentListRow>> = [
    { key: 'shipment', header: 'SHIPMENT', width: 130, render: (r) => <strong>{r.number}</strong> },
    { key: 'customer', header: 'CUSTOMER', width: 190, render: (r) => r.customerName || '—' },
    { key: 'lane', header: 'LANE', width: 230, render: laneText },
    { key: 'pickup', header: 'PICKUP', width: 190, render: (r) => <PickupCell iso={r.pickupAppt} now={now} /> },
    { key: 'equipment', header: 'EQUIPMENT', width: 120, render: (r) => r.equipmentType || '—' },
    {
      key: 'rate',
      header: 'CUSTOMER RATE',
      width: 130,
      render: (r) => <span style={MONEY_CELL}>{r.customerRateCents == null ? '—' : formatCents(r.customerRateCents)}</span>,
    },
    { key: 'posted', header: 'POSTED', width: 90, render: (r) => (r.datPostedAt ? <TmsBadge tone="blue">Posted</TmsBadge> : null) },
    {
      key: 'offers',
      header: 'OFFERS',
      width: 90,
      render: (r) => (offers ? offerCounts.get(r.id) ?? 0 : <span className="tms-muted">—</span>),
    },
    {
      key: 'cover',
      header: '',
      width: 100,
      render: (r) => (canOpenShipment
        ? <TmsButton variant="primary" size="sm" aria-label={`Cover ${r.number}`} data-testid="cover-row" onClick={() => setCoverRow(r)}>Cover</TmsButton>
        : null),
    },
  ]

  const offerColumns: Array<ColumnDef<QuoteRecord>> = [
    { key: 'offer', header: 'OFFER', width: 130, render: (o) => <Link to={`/tms/rates/${o.id}`}>{o.id}</Link> },
    {
      key: 'shipment',
      header: 'SHIPMENT',
      width: 140,
      render: (o) => (o.shipmentId
        ? shipmentLink(o.shipmentId, o.shipmentNumber ?? o.loadNumber ?? o.shipmentId)
        : o.loadNumber ?? '—'),
    },
    {
      key: 'carrier',
      header: 'CARRIER',
      width: 220,
      render: (o) => (
        <span>
          {o.carrierName || '—'}
          {o.carrierMc ? <span className="tms-muted" style={{ marginLeft: 4, fontSize: 12 }}>MC {o.carrierMc}</span> : null}
        </span>
      ),
    },
    {
      key: 'theirs',
      header: 'THEIR NUMBER',
      width: 130,
      render: (o) => {
        const theirs = theirNumberCents(o)
        return <span style={{ ...MONEY_CELL, fontWeight: 600 }}>{theirs === null ? '—' : formatCents(theirs)}</span>
      },
    },
    { key: 'status', header: 'STATUS', width: 150, render: (o) => statusLabel(o) },
    { key: 'move', header: 'WHOSE MOVE', width: 140, render: (o) => whoseMoveLabel(o, nowIso) },
    {
      key: 'expires',
      header: 'EXPIRES',
      width: 120,
      render: (o) => {
        const chip = expiryChip(o, nowIso)
        return chip ? <TmsBadge tone={CHIP_TONE[chip.tone]}>{chip.text}</TmsBadge> : null
      },
    },
    {
      key: 'review',
      header: '',
      width: 130,
      render: (o) => (o.shipmentId && canOpenShipment
        ? <Link className="tms-btn tms-btn-secondary tms-btn-sm" to={carrierTabPath(o.shipmentId)} aria-label={`Review offer ${o.id}`}>Review offer</Link>
        : null),
    },
  ]

  const coveredColumns: Array<ColumnDef<ShipmentListRow>> = [
    { key: 'shipment', header: 'SHIPMENT', width: 130, render: (r) => <strong>{r.number}</strong> },
    {
      key: 'carrier',
      header: 'CARRIER',
      width: 240,
      render: (r) => (
        <span>
          {r.carrierName || '—'}
          {r.carrierMc ? <span className="tms-muted" style={{ marginLeft: 4, fontSize: 12 }}>MC {r.carrierMc}</span> : null}
        </span>
      ),
    },
    { key: 'pickup', header: 'PICKUP', width: 190, render: (r) => <PickupCell iso={r.pickupAppt} now={now} /> },
    {
      key: 'ratecon',
      header: 'RATE CON',
      width: 130,
      render: (r) => (
        <TmsBadge tone={r.rateConSignedAt ? 'green' : r.rateConStatus && r.rateConStatus !== 'NOT_SENT' ? 'orange' : 'gray'}>
          {r.rateConSignedAt ? 'Signed' : RATE_CON_LABEL[r.rateConStatus ?? 'NOT_SENT']}
        </TmsBadge>
      ),
    },
    { key: 'sent', header: 'SENT', width: 190, render: (r) => formatDateTime(r.rateConSentAt) },
    {
      key: 'ladder',
      header: 'CARRIER STATUS',
      width: 290,
      render: (r) => <CarrierAssignmentChip ladder={r.carrierAssignmentStatus} shipmentStatus={r.status} />,
    },
    { key: 'packet', header: 'PACKET', width: 140, render: (r) => <PacketChip row={r} /> },
    {
      key: 'open',
      header: '',
      width: 90,
      render: (r) => (canOpenShipment
        ? <Link className="tms-btn tms-btn-secondary tms-btn-sm" to={carrierTabPath(r.id)} aria-label={`Open ${r.number}`}>Open</Link>
        : null),
    },
  ]

  const needsFiltered = needs.filter(matchShipment)
  const coveredFiltered = covered.filter(matchShipment).filter((r) => ladderFilter === 'ALL' || r.carrierAssignmentStatus === ladderFilter)
  const offersFiltered = offerRows.filter(matchOffer)

  const tabs = [
    { key: 'needs-cover', label: 'Needs cover', count: needs.length },
    { key: 'offers', label: 'Offers', count: offers ? offerRows.length : undefined },
    { key: 'covered', label: 'Covered', count: covered.length },
  ]

  const common = {
    title: 'Carrier Sales',
    search: { value: search, onChange: setSearch, placeholder: 'Search shipment, customer, carrier, lane…' },
    onRefresh: () => { void refresh(); void offers?.refresh() },
    quickTabs: { tabs, active: tab, onSelect: (key: string) => setTab(key as TabKey) },
    banner: (
      <>
        <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>
          Need a carrier that is not in the directory?{' '}
          <Link to="/tms/carriers/find?from=carrier-sales" data-testid="launch-find-invite">Find &amp; invite a carrier</Link>
        </p>
        {tab === 'covered' ? (
          <label className="flex items-center gap-2" style={{ fontSize: 12 }}>
            <span className="tms-muted">Carrier status</span>
            <TmsSelect
              aria-label="Carrier status filter"
              value={ladderFilter}
              onChange={(e) => setLadderFilter(e.target.value as CarrierAssignmentStatus | 'ALL')}
            >
              <option value="ALL">All</option>
              {LADDER_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </TmsSelect>
          </label>
        ) : null}
        {tab === 'offers' ? (
          <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>
            Accepting, countering and sending the setup packet happen on the shipment’s Carrier tab.{' '}
            {hasPageAccess('quotes') ? <Link to="/tms/rates">Open in Quotes › Carrier offers</Link> : null}
          </p>
        ) : null}
        <StepTCard />
        <QuotePostingsCard />
      </>
    ),
    onClearFilters: () => setSearch(''),
  }

  const loadFailure = error ? 'Couldn’t load shipments. Try refreshing.' : null
  const emptyFor = (empty: string) => loadFailure ?? (shipmentsLoading || partial ? 'Loading…' : empty)

  if (tab === 'offers') {
    return (
      <TmsListPage<QuoteRecord>
        {...common}
        columns={offerColumns}
        rows={offersFiltered.slice(0, pageSize)}
        rowKey={(o) => o.id}
        page={{ from: offersFiltered.length === 0 ? 0 : 1, to: Math.min(pageSize, offersFiltered.length), total: offersFiltered.length, pageSize, onPageSize: setPageSize }}
        emptyText={
          offers
            ? offers.error ?? 'No carrier offer is waiting.'
            : 'Needs the Quotes grant'
        }
      />
    )
  }

  const rows = tab === 'needs-cover' ? needsFiltered : coveredFiltered
  return (
    <>
      <TmsListPage<ShipmentListRow>
        {...common}
        columns={tab === 'needs-cover' ? needsColumns : coveredColumns}
        rows={rows.slice(0, pageSize)}
        rowKey={(r) => r.id}
        page={{ from: rows.length === 0 ? 0 : 1, to: Math.min(pageSize, rows.length), total: rows.length, pageSize, onPageSize: setPageSize }}
        emptyText={emptyFor(tab === 'needs-cover' ? 'Every live load has a carrier.' : 'No covered load is waiting on a rate confirmation.')}
      />
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
