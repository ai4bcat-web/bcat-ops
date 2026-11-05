/**
 * Carrier Sales › Offers (Step AL): type a load ID (or pick an active posting) and see every carrier offer
 * on it — e-mailed, phoned, posted-board or logged by hand — with the carrier's packet standing and risk,
 * plus the load's e-mail + call thread. Accept / Counter / Reject are the existing dialogs and actions;
 * nothing here sends mail from the listening mailbox. With no load selected it is the open-offers table.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Mail, Phone, X } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsCard, TmsInput, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { CoverCarrierDialog } from '@/features/carriers/cover/CoverCarrierDialog'
import { AcceptOfferDialog } from '@/features/quotes/components/AcceptOfferDialog'
import { CounterDialog } from '@/features/quotes/components/CounterDialog'
import { offerActions, statusLabel, theirNumberCents, whoseMoveLabel } from '@/features/quotes/quoteViews'
import { useAuth } from '@/hooks/useAuth'
import type { ShipmentListRow } from '@/hooks/useShipments'
import {
  listCarrierOffers, listShipmentsByNumber, mcpPreviewCarrier, rejectOffer,
} from '@/lib/apiClient'
import type { CarrierOfferRow } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import { mcpPacketStanding } from '@/lib/mcpPacket'
import { normalizePro } from '@/lib/proNumber'
import { isOpenQuoteStatus } from '@/lib/quotes'
import type { QuoteRecord, ShipmentRecord } from '@/types/tms'
import { CarrierLookupPanel } from './CarrierLookupPanel'
import { useCarrierInboxStatus } from './useCarrierInboxStatus'
import { useActivePostings } from './useActivePostings'
import { useLoadThread } from './useLoadThread'
import { usePolled } from './usePolled'
import { flagChips, groupByCarrier, offerOf, riskOf, riskOfCard, summaryLine, toneOf, withdrawnCarriers } from './riskOf'
import type { RiskCell } from './riskOf'

/** A working-list row carries the load mirrors; an exact-PRO lookup of a non-working shipment does not. */
type HubLoad = ShipmentRecord & { activeLoadCarrierId?: string | null; carrierName?: string | null; equipmentType?: string | null }

type Dialog = { kind: 'accept' | 'counter'; quote: QuoteRecord } | null

const MONEY: React.CSSProperties = { display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const SOURCE_LABEL: Record<string, string> = { EMAIL: 'E-mail', PHONE: 'Phone', BOARD: 'DAT / board', MANUAL: 'Logged by hand' }

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

function laneOf(r: { originCity?: string | null; destinationCity?: string | null }): string {
  return `${r.originCity || '—'} → ${r.destinationCity || '—'}`
}

/** Typed PRO / shipment id -> the shipment: the working list first, then an exact PRO lookup. */
function useResolvedLoad(param: string | null, shipments: readonly ShipmentListRow[]) {
  const local = useMemo(() => {
    if (!param) return null
    const raw = param.trim().toLowerCase()
    const pro = normalizePro(param)?.toLowerCase() ?? null
    return shipments.find((s) => s.id === param
      || [s.number, s.loadAljexId].some((v) => v && (v.toLowerCase() === raw || (pro !== null && normalizePro(v)?.toLowerCase() === pro)))) ?? null
  }, [param, shipments])

  const [remote, setRemote] = useState<{ param: string; row: ShipmentRecord | null } | null>(null)
  useEffect(() => {
    if (!param || local) return
    let alive = true
    const tries = [...new Set([param.trim(), normalizePro(param) ?? ''].filter(Boolean))]
    void tries.reduce<Promise<ShipmentRecord | null>>(
      (p, t) => p.then((found) => found ?? listShipmentsByNumber(t).then((rows) => rows.find((r) => !r.voidedAt) ?? null)),
      Promise.resolve(null),
    ).catch(() => null).then((row) => { if (alive) setRemote({ param, row }) })
    return () => { alive = false }
  }, [param, local])

  const row: HubLoad | null = local ?? (remote && remote.param === param ? remote.row : null)
  const searching = !!param && !local && (remote === null || remote.param !== param)
  return { row, searching }
}

export interface OffersHubProps {
  shipments: ShipmentListRow[]
  /** `?load=` — a PRO or a shipment id. */
  loadParam: string | null
  onLoadChange: (value: string | null) => void
  /** Open BUY quotes across loads (needs the Quotes grant); null without it. */
  openOffers: QuoteRecord[] | null
  openOffersError: string | null
  onChanged: () => void
}

export function OffersHub({ shipments, loadParam, onLoadChange, openOffers, openOffersError, onChanged }: OffersHubProps) {
  const { isAdmin, isOwner } = useAuth()
  const [typed, setTyped] = useState(loadParam ?? '')
  const [typedFor, setTypedFor] = useState(loadParam)
  if (typedFor !== loadParam) { setTypedFor(loadParam); setTyped(loadParam ?? '') }

  const postings = useActivePostings()
  const status = useCarrierInboxStatus(isAdmin || isOwner)
  const { row: load, searching } = useResolvedLoad(loadParam, shipments)

  const submit = (value: string) => {
    const v = value.trim()
    onLoadChange(v === '' ? null : v)
  }

  const activePostings = useMemo(() => {
    const open = new Map<string, number>()
    for (const o of openOffers ?? []) if (o.shipmentId) open.set(o.shipmentId, (open.get(o.shipmentId) ?? 0) + 1)
    const byShipment = new Map<string, NonNullable<typeof postings.data>[number]>()
    for (const p of postings.data ?? []) if (!p.shipmentId.startsWith('quote:') && !byShipment.has(p.shipmentId)) byShipment.set(p.shipmentId, p)
    return [...byShipment.values()]
      .flatMap((p) => {
        const s = shipments.find((x) => x.id === p.shipmentId)
        if (!s) return []
        const n = open.get(s.id) ?? p.offerCount ?? 0
        const pickup = p.pickupAppt ? ` · pickup ${formatDateTime(p.pickupAppt)}` : ''
        return [{ value: s.number, n, label: `${s.number} · ${p.originCity || '—'} → ${p.destinationCity || '—'}${pickup} · ${n} ${n === 1 ? 'offer' : 'offers'}` }]
      })
      .sort((a, b) => b.n - a.n)
  }, [postings, shipments, openOffers])

  const mailbox = status.data
  const mailboxProblem = mailbox
    ? Object.values(mailbox.state.mailboxes).some((m) => m.status === 'NEEDS_RECONNECT')
      ? 'Mailbox needs reconnecting — offers by e-mail are not arriving.'
      : Object.values(mailbox.state.mailboxes).some((m) => m.lastPollOk === false)
        ? 'The last mailbox check failed — newer offers by e-mail may be missing.'
        : null
    : null

  return (
    <div style={{ display: 'grid', gap: 12 }} data-testid="cs-offers-hub">
      {mailboxProblem ? (
        <TmsAlert tone="orange" title="Carrier mailbox">
          <span data-testid="cs-mailbox-banner">{mailboxProblem}</span>{' '}
          {isAdmin || isOwner ? <Link to="/tms/brokerage/carrier-sales">Open Settings › Carrier Sales</Link> : null}
        </TmsAlert>
      ) : null}

      <form
        style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
        onSubmit={(e) => { e.preventDefault(); submit(typed) }}
      >
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <span className="tms-muted">Load ID</span>
          <TmsInput
            data-testid="cs-offers-load-input"
            list="cs-offers-postings-list"
            placeholder="PRO or posting — e.g. L123456"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => { if (typed.trim() !== (loadParam ?? '')) submit(typed) }}
            style={{ minWidth: 280 }}
          />
        </label>
        <datalist id="cs-offers-postings-list" data-testid="cs-offers-postings-list">
          {activePostings.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </datalist>
        <TmsButton type="submit" size="sm">Show offers</TmsButton>
        {loadParam ? <TmsButton type="button" size="sm" variant="ghost" onClick={() => { setTyped(''); onLoadChange(null) }}>Clear</TmsButton> : null}
      </form>

      {!loadParam ? (
        <AllOffers openOffers={openOffers} error={openOffersError} onPick={(n) => { setTyped(n); onLoadChange(n) }} />
      ) : searching ? (
        <p className="tms-muted" style={{ fontSize: 13 }}>Looking up {loadParam}…</p>
      ) : !load ? (
        <p className="tms-field-error" data-testid="cs-offers-no-load">No load with that ID.</p>
      ) : (
        <LoadOffers
          key={load.id}
          load={load}
          postingRateCents={(postings.data ?? []).find((p) => p.shipmentId === load.id)?.rateCents ?? null}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

function AllOffers({ openOffers, error, onPick }: { openOffers: QuoteRecord[] | null; error: string | null; onPick: (n: string) => void }) {
  const [nowIso] = useState(() => new Date().toISOString())
  const columns: Array<ColumnDef<QuoteRecord>> = [
    { key: 'offer', header: 'OFFER', width: 110, render: (o) => <Link to={`/tms/rates/${o.id}`}>{o.id}</Link> },
    { key: 'shipment', header: 'LOAD', width: 130, render: (o) => o.shipmentNumber ?? o.loadNumber ?? '—' },
    {
      key: 'carrier', header: 'CARRIER', width: 220,
      render: (o) => <span>{o.carrierName || '—'}{o.carrierMc ? <span className="tms-muted" style={{ marginLeft: 4, fontSize: 12 }}>MC {o.carrierMc}</span> : null}</span>,
    },
    { key: 'theirs', header: 'THEIR NUMBER', width: 120, render: (o) => { const t = theirNumberCents(o); return <span style={{ ...MONEY, fontWeight: 600 }}>{t === null ? '—' : formatCents(t)}</span> } },
    { key: 'source', header: 'SOURCE', width: 120, render: (o) => (o.offerSource ? SOURCE_LABEL[o.offerSource] ?? o.offerSource : '—') },
    { key: 'status', header: 'STATUS', width: 140, render: (o) => statusLabel(o) },
    { key: 'move', header: 'WHOSE MOVE', width: 130, render: (o) => whoseMoveLabel(o, nowIso) },
    {
      key: 'open', header: '', width: 110,
      render: (o) => { const n = o.shipmentNumber ?? o.loadNumber; return n ? <TmsButton size="sm" onClick={() => onPick(n)}>Open hub</TmsButton> : null },
    },
  ]
  const rows = (openOffers ?? []).filter((o) => isOpenQuoteStatus(o.status))
  return (
    <TmsTable
      columns={columns}
      rows={rows}
      rowKey={(o) => o.id}
      empty={<span className="tms-muted">{openOffers ? error ?? 'No carrier offer is waiting.' : 'Needs the Quotes grant'}</span>}
    />
  )
}

function LoadOffers({ load, postingRateCents, onChanged }: { load: HubLoad; postingRateCents: number | null; onChanged: () => void }) {
  const offersRead = useCallback(() => listCarrierOffers(load.id).then((r) => r.offers), [load.id])
  const offers = usePolled(offersRead)
  const thread = useLoadThread(load.id)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // Step AS: the carrier whose lookup card (directory standing, packet, MCP e-mails, send / cover) is open.
  const [lookupOf, setLookupOf] = useState<CarrierOfferRow | null>(null)
  const [coverOpen, setCoverOpen] = useState<string | null>(null)
  const [mcp, setMcp] = useState<Record<string, RiskCell | 'loading' | { error: string }>>({})
  const checked = useRef(new Set<string>())
  const [nowIso] = useState(() => new Date().toISOString())

  const rows = useMemo(() => offers.data ?? [], [offers.data])
  const threadRows = useMemo(() => thread.data ?? [], [thread.data])
  const withdrawn = useMemo(() => withdrawnCarriers(threadRows), [threadRows])
  const flagsByMessage = useMemo(() => new Map(threadRows.map((m) => [m.id, offerOf(m)] as const)), [threadRows])
  const sorted = useMemo(() => [...rows].sort((a, b) => Number(isOpenQuoteStatus(b.status)) - Number(isOpenQuoteStatus(a.status)) || a.amountCents - b.amountCents), [rows])
  const groups = useMemo(() => groupByCarrier(sorted), [sorted])
  const covered = !!load.activeLoadCarrierId

  const refresh = async () => { await Promise.all([offers.refresh(), thread.refresh()]); onChanged() }

  const checkMcp = (mc: string) => {
    if (checked.current.has(mc)) return
    checked.current.add(mc)
    setMcp((m) => ({ ...m, [mc]: 'loading' }))
    mcpPreviewCarrier({ mcNumber: mc })
      .then((r) => setMcp((m) => ({ ...m, [mc]: riskOfCard(r.card) })))
      .catch((e: unknown) => setMcp((m) => ({ ...m, [mc]: { error: messageOf(e) } })))
  }

  const reject = async (q: QuoteRecord) => {
    setBusy(true)
    try {
      await rejectOffer({ quoteId: q.id, expectedVersion: q.version })
      toast.success(`Offer from ${q.carrierName ?? 'the carrier'} rejected`)
      await refresh()
    } catch (e) { toast.error(messageOf(e)) } finally { setBusy(false) }
  }

  const columns: Array<ColumnDef<{ row: CarrierOfferRow; earlier: number }>> = [
    {
      key: 'carrier', header: 'CARRIER', width: 250,
      render: ({ row: o, earlier }) => {
        const msg = o.offerMessageRef ? flagsByMessage.get(o.offerMessageRef) : null
        const key = o.carrierMc ? `mc:${o.carrierMc.replace(/\D/g, '')}` : null
        return (
          <div data-testid={`cs-offer-carrier-${o.id}`} style={{ display: 'grid', gap: 2 }}>
            <strong>{o.carrierName || '—'}</strong>
            <span className="tms-muted" style={{ fontSize: 12 }}>{o.carrierMc ? `MC ${o.carrierMc}` : 'No MC'}</span>
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {!o.vetting.known ? <TmsBadge tone="orange">Not in directory</TmsBadge> : null}
              {flagChips(msg?.extraction.flags).map((c) => <TmsBadge key={c.flag} tone={c.tone} title={c.title}>{c.label}</TmsBadge>)}
              {key && withdrawn.has(key) && isOpenQuoteStatus(o.status) ? <TmsBadge tone="orange">Carrier withdrew?</TmsBadge> : null}
            </span>
            {earlier > 0 ? (
              <button type="button" className="tms-muted" style={{ fontSize: 12, textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                onClick={() => setExpanded((e) => ({ ...e, [o.id]: !e[o.id] }))}>
                {earlier} earlier
              </button>
            ) : null}
          </div>
        )
      },
    },
    {
      key: 'rate', header: 'OFFERED RATE', width: 150,
      render: ({ row: o }) => {
        const msg = o.offerMessageRef ? flagsByMessage.get(o.offerMessageRef) : null
        const delta = postingRateCents && o.amountCents > 0 ? Math.round(((o.amountCents - postingRateCents) / postingRateCents) * 100) : null
        return (
          <span data-testid={`cs-offer-rate-${o.id}`}>
            <span style={{ ...MONEY, fontWeight: 600 }}>{o.amountCents > 0 ? formatCents(o.amountCents) : '—'}</span>
            {delta !== null ? <span className="tms-muted" style={{ ...MONEY, fontSize: 12 }}>{delta > 0 ? '+' : ''}{delta}% vs posted</span> : null}
            {msg?.extraction.flags.includes('RATE_OUTLIER') ? <TmsBadge tone="orange">Rate outlier</TmsBadge> : null}
          </span>
        )
      },
    },
    {
      key: 'source', header: 'SOURCE', width: 170,
      render: ({ row: o }) => {
        const msg = o.offerMessageRef ? flagsByMessage.get(o.offerMessageRef) : null
        const label = o.offerSource === 'BOARD' && msg?.boardProvider ? msg.boardProvider : o.offerSource ? SOURCE_LABEL[o.offerSource] ?? o.offerSource : '—'
        return (
          <span data-testid={`cs-offer-source-${o.id}`} style={{ display: 'grid' }}>
            <span>{label}</span>
            {o.offerContactName || o.offerContactPhone ? <span className="tms-muted" style={{ fontSize: 12 }}>{[o.offerContactName, o.offerContactPhone].filter(Boolean).join(' · ')}</span> : null}
          </span>
        )
      },
    },
    { key: 'received', header: 'RECEIVED', width: 150, render: ({ row: o }) => formatDateTime(o.createdAt) },
    {
      key: 'packet', header: 'PACKET', width: 150,
      render: ({ row: o }) => {
        const standing = mcpPacketStanding({ mcpStatus: o.carrierRisk?.mcpStatus ?? o.vetting.mcpStatus })
        const complete = o.carrierRisk?.packetComplete ?? standing.completed
        return (
          <span data-testid={`cs-offer-packet-${o.id}`}>
            {!o.vetting.known
              ? <TmsBadge tone="orange">No packet — not in directory</TmsBadge>
              : <TmsBadge tone={complete ? 'green' : 'orange'} title={complete ? undefined : standing.reason}>{complete ? 'Packet complete' : 'No packet'}</TmsBadge>}
          </span>
        )
      },
    },
    {
      key: 'risk', header: 'RISK', width: 170,
      render: ({ row: o }) => {
        const known = riskOf(o)
        const asked = o.carrierMc ? mcp[o.carrierMc] : undefined
        return (
          <span data-testid={`cs-offer-risk-${o.id}`} style={{ display: 'grid', gap: 2 }}>
            {known ? <TmsBadge tone={toneOf(known.tone)}>{known.points == null ? 'No score' : `${known.points} pts`}</TmsBadge> : null}
            {!known && asked && asked !== 'loading' && !('error' in asked) ? (
              <span style={{ display: 'flex', gap: 4 }}>
                <TmsBadge tone={toneOf(asked.tone)}>{asked.points == null ? 'No score' : `${asked.points} pts`}</TmsBadge>
                {asked.stub ? <TmsBadge tone="gray" title="No MyCarrierPackets call was made">STUB</TmsBadge> : null}
              </span>
            ) : null}
            {!known && asked && asked !== 'loading' && 'error' in asked ? <span className="tms-field-error">{asked.error}</span> : null}
            {!known && o.carrierMc && !asked ? (
              <TmsButton size="sm" data-testid={`cs-offer-check-mcp-${o.id}`} onClick={() => checkMcp(o.carrierMc!)}>Check MCP</TmsButton>
            ) : null}
            {!known && asked === 'loading' ? <span className="tms-muted" style={{ fontSize: 12 }}>Checking…</span> : null}
            {!known && !o.carrierMc ? <span className="tms-muted" style={{ fontSize: 12 }}>No MC to check</span> : null}
          </span>
        )
      },
    },
    { key: 'status', header: 'STATUS', width: 150, render: ({ row: o }) => <span>{statusLabel(o)}<span className="tms-muted" style={{ display: 'block', fontSize: 12 }}>{whoseMoveLabel(o, nowIso)}</span></span> },
    {
      key: 'actions', header: '', width: 330,
      render: ({ row: o }) => {
        const can = offerActions(o, nowIso)
        const blocked = !o.vetting.known || !o.vetting.bookable
        const why = blocked ? (o.vetting.blockers.join(' ') || 'This carrier cannot be booked yet.') : undefined
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <TmsButton variant="primary" size="sm" data-testid={`cs-offer-accept-${o.id}`} disabled={busy || !can.canAccept || blocked || covered} title={why}
              onClick={() => setDialog({ kind: 'accept', quote: o })}><Check size={13} />Accept</TmsButton>
            <TmsButton size="sm" data-testid={`cs-offer-counter-${o.id}`} disabled={busy || !can.canCounter || covered}
              title="Counters go out by e-mail through the app, not from the listening mailbox."
              onClick={() => setDialog({ kind: 'counter', quote: o })}>Counter</TmsButton>
            <TmsButton size="sm" data-testid={`cs-offer-reject-${o.id}`} disabled={busy || !can.canReject}
              onClick={() => { void reject(o) }}><X size={13} />Reject</TmsButton>
            {blocked ? (
              <>
                <TmsButton size="sm" data-testid={`cs-offer-setup-packet-${o.id}`} disabled={busy || !o.carrierMc}
                  title={o.carrierMc ? 'Shows where this carrier stands and the e-mail addresses MyCarrierPackets returns' : 'No MC on this offer: use Find & invite'}
                  onClick={() => setLookupOf(o)}>Send setup packet</TmsButton>
                {!o.vetting.known && o.carrierMc ? <Link className="tms-btn tms-btn-secondary tms-btn-sm" to={`/tms/carriers/find?from=carrier-sales&mc=${encodeURIComponent(o.carrierMc)}`}>Find &amp; invite</Link> : null}
              </>
            ) : null}
          </div>
        )
      },
    },
  ]

  const tableRows = groups.flatMap(({ head, earlier }) => [
    { row: head, earlier: earlier.length },
    ...(expanded[head.id] ? earlier.map((e) => ({ row: e, earlier: 0 })) : []),
  ])

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <TmsCard title={`Load ${load.number}`}>
        <div data-testid="cs-offers-load-card" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
          <span>{laneOf(load)}</span>
          <span className="tms-muted">Pickup {load.pickupAppt ? formatDateTime(load.pickupAppt) : '—'}</span>
          {load.equipmentType ? <span className="tms-muted">{load.equipmentType}</span> : null}
          {postingRateCents ? <span className="tms-muted">Posted at {formatCents(postingRateCents)}</span> : null}
          {(load.postedBoards ?? []).length > 0 ? <TmsBadge tone="blue">Posted: {(load.postedBoards ?? []).join(', ')}</TmsBadge> : null}
          {covered ? <TmsBadge tone="green">Covered{load.carrierName ? ` — ${load.carrierName}` : ''}</TmsBadge> : <TmsBadge tone="orange">Needs cover</TmsBadge>}
          <Link to={`/tms/shipments/${load.id}?tab=carrier`}>Open shipment</Link>
        </div>
      </TmsCard>

      {offers.error ? <p className="tms-field-error">{offers.error}</p> : null}
      {lookupOf?.carrierMc ? (
        <TmsCard title={`${lookupOf.carrierName || 'Carrier'} · MC ${lookupOf.carrierMc}`} actions={<TmsButton size="sm" variant="ghost" onClick={() => setLookupOf(null)}>Close</TmsButton>}>
          <div data-testid="cs-offer-lookup">
            <CarrierLookupPanel
              key={lookupOf.id}
              lookup={{ mcNumber: lookupOf.carrierMc }}
              shipmentId={load.id}
              carrierName={lookupOf.carrierName ?? undefined}
              onCover={covered ? undefined : () => setCoverOpen(lookupOf.carrierMc ?? null)}
              onChanged={() => { void refresh() }}
            />
          </div>
        </TmsCard>
      ) : null}
      {coverOpen ? (
        <CoverCarrierDialog shipmentId={load.id} shipmentNumber={load.number} initialQuery={`MC ${coverOpen.replace(/^MC/i, '')}`}
          onClose={() => setCoverOpen(null)} onCovered={() => { setCoverOpen(null); void refresh() }} />
      ) : null}
      <div data-testid="cs-offers-table">
        <TmsTable
          columns={columns}
          rows={tableRows}
          rowKey={({ row }) => row.id}
          empty={<span className="tms-muted">{offers.loading ? 'Loading offers…' : 'No offers on this load yet.'}</span>}
        />
      </div>

      <TmsCard title="E-mail and calls on this load">
        <div data-testid="cs-thread" style={{ display: 'grid', gap: 8 }}>
          {thread.error ? <p className="tms-field-error">{thread.error}</p> : null}
          {threadRows.length === 0 ? <p className="tms-muted" style={{ fontSize: 13, margin: 0 }}>{thread.loading ? 'Loading…' : 'Nothing has come in on this load.'}</p> : null}
          {threadRows.map((m) => {
            const o = offerOf(m)
            const isCall = m.channel === 'VOICE'
            const link = o?.call?.recordingUrl && /^https:\/\//i.test(o.call.recordingUrl) ? o.call.recordingUrl : null
            return (
              <details key={m.id} data-testid={`cs-thread-item-${m.id}`} style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: 8 }}>
                <summary style={{ cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
                  {isCall ? <Phone size={13} aria-label="Phone call" /> : <Mail size={13} aria-label="E-mail" />}
                  <span className="tms-muted">{formatDateTime(m.at)}</span>
                  <span>{m.from ?? m.subject ?? 'Unknown sender'}</span>
                  {o ? <span>{summaryLine(o)}</span> : null}
                  {o && o.match.how !== 'NONE' ? <TmsBadge tone="gray" title={o.match.top?.signals.map((s) => s.detail).join(' · ')}>{o.match.how} · {Math.round(o.match.score * 100)}%</TmsBadge> : null}
                  {o?.match.state === 'COVERED_LATE' ? <TmsBadge tone="orange">Arrived after cover — backup</TmsBadge> : null}
                  {flagChips(o?.extraction.flags).map((c) => <TmsBadge key={c.flag} tone={c.tone} title={c.title}>{c.label}</TmsBadge>)}
                  {o?.quoteId ? <span className="tms-muted">{o.quoteNumber ?? o.quoteId}</span> : null}
                </summary>
                <div style={{ marginTop: 8, fontSize: 13, whiteSpace: 'pre-wrap' }}>
                  {m.subject ? <strong style={{ display: 'block' }}>{m.subject}</strong> : null}
                  {m.body ?? ''}
                  {link ? <a href={link} target="_blank" rel="noreferrer noopener" style={{ display: 'block', marginTop: 4 }}>Recording</a> : null}
                </div>
              </details>
            )
          })}
        </div>
      </TmsCard>

      {dialog?.kind === 'accept' ? (
        <AcceptOfferDialog quote={dialog.quote} open onOpenChange={(n) => { if (!n) setDialog(null) }} onDone={() => { setDialog(null); void refresh() }} />
      ) : null}
      {dialog?.kind === 'counter' ? (
        <CounterDialog quote={dialog.quote} open onOpenChange={(n) => { if (!n) setDialog(null) }} onDone={() => { setDialog(null); void refresh() }} />
      ) : null}
    </div>
  )
}
