/**
 * `/tms/rates` — the quote desk (spec §6.6 sell side, §6.5 buy side).
 *
 * Six tabs that follow one number from "somebody asked" to "we hauled it": what nobody
 * has priced, what is sitting with a customer, what came back, what was never sent, how
 * the month ended, and the carrier offers out across every shipment. The open tabs come
 * from one sparse-index read (`useQuoteWorklist`, which also sweeps lapsed quotes once
 * per mount); the Won / Lost tab is a month read, because a closed quote leaves the
 * open index entirely.
 *
 * Every button is gated by `quoteState` — the same function the Lambda refuses with —
 * so this board cannot offer a verb the server would reject. Nothing here does its own
 * arithmetic: the tab split, the strip and the chips are all `quoteViews`.
 *
 * On dev SES is denied, so a send comes back NOT_SENT with the link and the body. The
 * send dialog shows exactly that rather than claiming a mail went out.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Link2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge, TmsButton, TmsDialog, TmsField, TmsListPage, TmsSelect,
} from '@/features/tms/kit'
import type { ColumnDef, TmsTone } from '@/features/tms/kit'
import { useQuoteWorklist } from '@/hooks/useQuoteWorklist'
import {
  acceptCounter, getTmsSettings, graphqlErrorText, listQuotesByMonth, rejectOffer, restoreQuote,
} from '@/lib/apiClient'
import { chicagoDateStr, formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import { quoteState } from '@/lib/quotes'
import { lastThreeMonths, monthLabel } from '@/features/ar/arViews'
import {
  LOST_REASON_LABEL, QUOTE_TABS, ageHours, expiryChip, marginChip, quoteLinkUrl, quoteTabCounts,
  quoteTotals, splitQuoteTabs, statusLabel, theirNumberCents, whoseMoveLabel, offerActions,
  type QuoteChip, type QuoteTabKey,
} from './quoteViews'
import { AcceptOfferDialog } from './components/AcceptOfferDialog'
import { ConvertQuoteDialog } from './components/ConvertQuoteDialog'
import { CounterDialog } from './components/CounterDialog'
import { MarkLostDialog } from './components/MarkLostDialog'
import { SendQuoteDialog } from './components/SendQuoteDialog'
import type { QuoteRecord } from '@/types/tms'

/** Which dialog is open, and the one quote it is open about. */
type QuotesDialog =
  | { kind: 'send'; quote: QuoteRecord }
  | { kind: 'counter'; quote: QuoteRecord }
  | { kind: 'convert'; quote: QuoteRecord }
  | { kind: 'markLost'; quote: QuoteRecord }
  | { kind: 'acceptOffer'; quote: QuoteRecord }

const CHIP_TONE: Record<QuoteChip['tone'], TmsTone> = {
  muted: 'gray',
  warn: 'orange',
  danger: 'red',
  good: 'green',
}

function Chip({ chip }: { chip: QuoteChip | null }) {
  if (!chip) return null
  return <TmsBadge tone={CHIP_TONE[chip.tone]}>{chip.text}</TmsBadge>
}

/** `Chicago, IL → Danville, IL` off whatever the row knows about its lane. */
function laneText(quote: QuoteRecord): string {
  const stops = quote.stops ?? []
  if (stops.length >= 2) {
    const first = stops[0]
    const last = stops[stops.length - 1]
    return `${first.city ?? '—'} → ${last.city ?? '—'}`
  }
  return quote.laneKey ? quote.laneKey.replace('>', ' → ').replace(/\|/g, ', ') : '—'
}

function dayText(iso: string | null | undefined): string {
  return iso ? formatDateTime(iso) : '—'
}

const MONEY_CELL: React.CSSProperties = { display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const ACTIONS_CELL: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 4, whiteSpace: 'nowrap' }

/** The quote number, always a link to the one page that can change it. */
function QuoteLink({ quote }: { quote: QuoteRecord }) {
  return <Link to={`/tms/rates/${quote.id}`}>{quote.id}</Link>
}

const EMPTY_TEXT: Record<QuoteTabKey, string> = {
  'to-price': 'Nothing is waiting to be priced.',
  sent: 'No quote is sitting with a customer.',
  replies: 'Nobody has come back to us.',
  drafts: 'No draft is waiting to go out.',
  'won-lost': 'Nothing closed in this month.',
  offers: 'No offer is out with a carrier.',
}

export function QuotesPage() {
  // One clock for the whole board: every chip, every gate and the strip answer as of the
  // same instant, so a row cannot read "Expires in 1h" beside a disabled Convert.
  const [now, setNow] = useState(() => new Date().toISOString())
  const [asOf] = useState(() => chicagoDateStr(new Date()))

  const navigate = useNavigate()
  const worklist = useQuoteWorklist()
  const [tab, setTab] = useState<QuoteTabKey>('to-price')
  const [dialog, setDialog] = useState<QuotesDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [marginFloorBps, setMarginFloorBps] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [pageSize, setPageSize] = useState(50)

  const months = useMemo(() => lastThreeMonths(asOf), [asOf])
  const [month, setMonth] = useState(() => months[0])
  const [monthRows, setMonthRows] = useState<QuoteRecord[]>([])
  const [monthLoading, setMonthLoading] = useState(true)
  const [lostFacet, setLostFacet] = useState('')

  // No synchronous setState in an effect (react-hooks/set-state-in-effect): every write
  // happens inside the promise chain.
  const loadMonth = useCallback(() =>
    listQuotesByMonth(month)
      .then((rows) => setMonthRows(rows))
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load that month'))
      .finally(() => setMonthLoading(false)),
  [month])
  useEffect(() => { loadMonth() }, [loadMonth])

  // The floor a quote's margin is read against; a failed read leaves the chip neutral
  // rather than inventing a threshold nobody configured.
  useEffect(() => {
    let alive = true
    getTmsSettings()
      .then((s) => { if (alive) setMarginFloorBps(s?.marginFloorBps ?? null) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const rows = useMemo(() => splitQuoteTabs(worklist.open, monthRows), [worklist.open, monthRows])
  const counts = useMemo(() => quoteTabCounts(rows), [rows])
  const totals = useMemo(() => quoteTotals(worklist.open, monthRows), [worklist.open, monthRows])

  const refreshAll = useCallback(() => {
    setNow(new Date().toISOString())
    return Promise.all([worklist.refresh(), loadMonth()]).then(() => undefined)
  }, [worklist, loadMonth])

  const closeAndRefresh = () => {
    setDialog(null)
    void refreshAll()
  }

  const copyLink = (quote: QuoteRecord) => {
    const url = quoteLinkUrl(quote.linkToken, window.location.origin)
    if (!url) { toast.error('This round has no live link — send it again to mint one'); return }
    navigator.clipboard.writeText(url)
      .then(() => toast.success('Link copied'))
      .catch(() => toast.error('Could not copy the link'))
  }

  const runAcceptCounter = (quote: QuoteRecord) => {
    setBusy(true)
    acceptCounter({ quoteId: quote.id, expectedVersion: quote.version })
      .then(() => {
        toast.success(`Counter accepted on ${quote.id}`)
        return refreshAll()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not accept that counter'))
      .finally(() => setBusy(false))
  }

  const runRestore = (quote: QuoteRecord) => {
    setBusy(true)
    restoreQuote({ quoteId: quote.id, expectedVersion: quote.version })
      .then(() => {
        toast.success(`${quote.id} is back on the board`)
        return refreshAll()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not restore that quote'))
      .finally(() => setBusy(false))
  }

  const runRejectOffer = (quote: QuoteRecord) => {
    setBusy(true)
    rejectOffer({ quoteId: quote.id, expectedVersion: quote.version, reason: 'TOO_HIGH' })
      .then(() => {
        toast.success(`Offer from ${quote.carrierName ?? 'the carrier'} rejected`)
        return refreshAll()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not reject that offer'))
      .finally(() => setBusy(false))
  }

  const lostFacets = useMemo(() => {
    const seen: string[] = []
    for (const quote of rows['won-lost']) {
      if (quote.lostReason && seen.includes(quote.lostReason) === false) seen.push(quote.lostReason)
    }
    return seen
  }, [rows])

  const tabRows = useMemo(() => {
    const base = tab === 'won-lost'
      ? (lostFacet ? rows['won-lost'].filter((quote) => quote.lostReason === lostFacet) : rows['won-lost'])
      : rows[tab]
    const q = query.trim().toLowerCase()
    if (q.length === 0) return base
    return base.filter((quote) => [
      quote.id, quote.customerName, quote.carrierName, quote.shipmentNumber, quote.loadNumber, laneText(quote),
    ].some((v) => (v ?? '').toLowerCase().includes(q)))
  }, [tab, rows, lostFacet, query])

  const pageRows = useMemo(() => tabRows.slice(0, pageSize), [tabRows, pageSize])

  /* ── Columns, one set per tab; every row is a QuoteRecord. ───────────────── */

  const quoteCol: ColumnDef<QuoteRecord> = { key: 'quote', header: 'QUOTE', width: 120, render: (q) => <QuoteLink quote={q} /> }
  const customerCol: ColumnDef<QuoteRecord> = { key: 'customer', header: 'CUSTOMER', width: 180, render: (q) => q.customerName || '—' }
  const laneCol: ColumnDef<QuoteRecord> = { key: 'lane', header: 'LANE', width: 220, render: (q) => laneText(q) }

  const columnsByTab: Record<QuoteTabKey, Array<ColumnDef<QuoteRecord>>> = {
    'to-price': [
      quoteCol, customerCol, laneCol,
      { key: 'pickup', header: 'PICK UP', width: 170, render: (q) => dayText(q.pickupAppt) },
      { key: 'equipment', header: 'EQUIPMENT', width: 130, render: (q) => q.equipmentType || '—' },
      {
        key: 'age',
        header: 'AGE',
        width: 90,
        render: (q) => { const age = ageHours(q, now); return age === null ? '—' : `${Math.round(age)}h` },
      },
      {
        key: 'actions',
        header: '',
        width: 120,
        render: (q) => (
          <div style={ACTIONS_CELL}>
            <Link className="tms-btn tms-btn-secondary tms-btn-sm" to={`/tms/rates/${q.id}`} aria-label={`Price quote ${q.id}`}>Price</Link>
          </div>
        ),
      },
    ],
    sent: [
      quoteCol, customerCol, laneCol,
      {
        key: 'amount',
        header: 'AMOUNT',
        width: 150,
        render: (q) => (
          <span style={MONEY_CELL}>
            {formatCents(q.amountCents)} <Chip chip={marginChip(q, marginFloorBps)} />
          </span>
        ),
      },
      { key: 'expires', header: 'EXPIRES', width: 130, render: (q) => <Chip chip={expiryChip(q, now)} /> },
      {
        key: 'sent',
        header: 'LAST SENT',
        width: 180,
        render: (q) => (
          <span>
            {dayText(q.sentAt)}
            {q.lastSendStatus === 'NOT_SENT' && <TmsBadge tone="red">Not sent</TmsBadge>}
          </span>
        ),
      },
      {
        key: 'link',
        header: 'LINK',
        width: 130,
        render: (q) => <span className="tms-muted" style={{ fontSize: 12 }}>{q.linkToken ? `Live · round ${q.rounds}` : 'Spent'}</span>,
      },
      {
        key: 'actions',
        header: '',
        width: 330,
        render: (q) => {
          const state = quoteState(q, now)
          return (
            <div style={ACTIONS_CELL}>
              <TmsButton
                variant="ghost"
                size="sm"
                aria-label={`Copy link for ${q.id}`}
                disabled={busy || q.linkToken == null}
                onClick={() => copyLink(q)}
              >
                <Link2 size={13} /> Copy link
              </TmsButton>
              {state.canSend && (
                <TmsButton variant="ghost" size="sm" aria-label={`Re-send ${q.id}`} disabled={busy} onClick={() => setDialog({ kind: 'send', quote: q })}>
                  Re-send
                </TmsButton>
              )}
              {state.canConvert && (
                <TmsButton variant="ghost" size="sm" aria-label={`Convert ${q.id}`} disabled={busy} onClick={() => setDialog({ kind: 'convert', quote: q })}>
                  Convert
                </TmsButton>
              )}
              {state.canMarkLost && (
                <TmsButton variant="ghost" size="sm" aria-label={`Mark ${q.id} lost`} disabled={busy} onClick={() => setDialog({ kind: 'markLost', quote: q })}>
                  Mark lost
                </TmsButton>
              )}
            </div>
          )
        },
      },
    ],
    replies: [
      quoteCol, customerCol,
      { key: 'ours', header: 'OURS', width: 120, render: (q) => <span style={MONEY_CELL}>{formatCents(q.amountCents)}</span> },
      {
        key: 'theirs',
        header: 'THEIRS',
        width: 120,
        render: (q) => {
          const theirs = theirNumberCents(q)
          return <span style={{ ...MONEY_CELL, fontWeight: 600 }}>{theirs === null ? '—' : formatCents(theirs)}</span>
        },
      },
      {
        key: 'message',
        header: 'MESSAGE',
        width: 260,
        render: (q) => {
          const lastEvent = (q.events ?? []).filter((e) => e.note).slice(-1)[0] ?? null
          return <span className="tms-muted" style={{ fontSize: 12 }}>{lastEvent?.note ?? '—'}</span>
        },
      },
      {
        key: 'answered',
        header: 'ANSWERED BY',
        width: 190,
        render: (q) => (
          <span>
            {q.responderName || q.responderEmail || '—'}
            <span className="tms-muted" style={{ display: 'block', fontSize: 12 }}>{dayText(q.respondedAt)}</span>
          </span>
        ),
      },
      {
        key: 'actions',
        header: '',
        width: 330,
        render: (q) => {
          const state = quoteState(q, now)
          return (
            <div style={ACTIONS_CELL}>
              {state.canConvert && (
                <TmsButton variant="ghost" size="sm" aria-label={`Convert ${q.id}`} disabled={busy} onClick={() => setDialog({ kind: 'convert', quote: q })}>
                  Convert
                </TmsButton>
              )}
              {state.canAccept && (
                <TmsButton variant="ghost" size="sm" aria-label={`Accept counter on ${q.id}`} disabled={busy} onClick={() => runAcceptCounter(q)}>
                  Accept counter
                </TmsButton>
              )}
              {state.canCounter && (
                <TmsButton variant="ghost" size="sm" aria-label={`Counter ${q.id}`} disabled={busy} onClick={() => setDialog({ kind: 'counter', quote: q })}>
                  Counter
                </TmsButton>
              )}
              {state.canMarkLost && (
                <TmsButton variant="ghost" size="sm" aria-label={`Mark ${q.id} lost`} disabled={busy} onClick={() => setDialog({ kind: 'markLost', quote: q })}>
                  Mark lost
                </TmsButton>
              )}
            </div>
          )
        },
      },
    ],
    drafts: [
      quoteCol, customerCol, laneCol,
      { key: 'amount', header: 'AMOUNT', width: 120, render: (q) => <span style={MONEY_CELL}>{formatCents(q.amountCents)}</span> },
      { key: 'written', header: 'WRITTEN', width: 130, render: (q) => q.quoteDate },
      {
        key: 'actions',
        header: '',
        width: 180,
        render: (q) => {
          const state = quoteState(q, now)
          return (
            <div style={ACTIONS_CELL}>
              <Link className="tms-btn tms-btn-ghost tms-btn-sm" to={`/tms/rates/${q.id}`} aria-label={`Price quote ${q.id}`}>Price</Link>
              {state.canSend && (
                <TmsButton size="sm" aria-label={`Send ${q.id}`} disabled={busy} onClick={() => setDialog({ kind: 'send', quote: q })}>
                  Send
                </TmsButton>
              )}
            </div>
          )
        },
      },
    ],
    'won-lost': [
      quoteCol, customerCol, laneCol,
      { key: 'amount', header: 'AMOUNT', width: 120, render: (q) => <span style={MONEY_CELL}>{formatCents(q.amountCents)}</span> },
      {
        key: 'outcome',
        header: 'OUTCOME',
        width: 180,
        render: (q) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {statusLabel(q)}
            {q.lostReason && <TmsBadge tone="gray">{LOST_REASON_LABEL[q.lostReason]}</TmsBadge>}
          </span>
        ),
      },
      { key: 'closed', header: 'CLOSED', width: 170, render: (q) => dayText(q.closedAt ?? q.wonAt) },
      {
        key: 'actions',
        header: '',
        width: 200,
        render: (q) => {
          const state = quoteState(q, now)
          return (
            <div style={ACTIONS_CELL}>
              {q.shipmentId && (
                <Link className="tms-btn tms-btn-ghost tms-btn-sm" to={`/tms/shipments/${q.shipmentId}`} aria-label={`Shipment for ${q.id}`}>Shipment</Link>
              )}
              {state.canRestore && (
                <TmsButton variant="ghost" size="sm" aria-label={`Restore ${q.id}`} disabled={busy} onClick={() => runRestore(q)}>
                  Restore
                </TmsButton>
              )}
            </div>
          )
        },
      },
    ],
    offers: [
      {
        key: 'shipment',
        header: 'SHIPMENT',
        width: 150,
        render: (q) => (q.shipmentId
          ? <Link to={`/tms/shipments/${q.shipmentId}`}>{q.shipmentNumber ?? q.loadNumber ?? q.shipmentId}</Link>
          : q.loadNumber ?? '—'),
      },
      {
        key: 'carrier',
        header: 'CARRIER',
        width: 200,
        render: (q) => (
          <span>
            {q.carrierName || '—'}
            {q.carrierMc && <span className="tms-muted" style={{ marginLeft: 4, fontSize: 12 }}>MC {q.carrierMc}</span>}
          </span>
        ),
      },
      { key: 'ours', header: 'OURS', width: 120, render: (q) => <span style={MONEY_CELL}>{formatCents(q.amountCents)}</span> },
      {
        key: 'theirs',
        header: 'THEIRS',
        width: 120,
        render: (q) => {
          const theirs = theirNumberCents(q)
          return <span style={{ ...MONEY_CELL, fontWeight: 600 }}>{theirs === null ? '—' : formatCents(theirs)}</span>
        },
      },
      { key: 'status', header: 'STATUS', width: 150, render: (q) => statusLabel(q) },
      { key: 'expires', header: 'EXPIRES', width: 130, render: (q) => <Chip chip={expiryChip(q, now)} /> },
      { key: 'move', header: 'WHOSE MOVE', width: 150, render: (q) => whoseMoveLabel(q, now) },
      {
        key: 'actions',
        header: '',
        width: 330,
        render: (q) => {
          const actions = offerActions(q, now)
          return (
            <div style={ACTIONS_CELL}>
              {actions.canAccept && (
                <TmsButton variant="ghost" size="sm" aria-label={`Accept offer ${q.id}`} disabled={busy} onClick={() => setDialog({ kind: 'acceptOffer', quote: q })}>
                  Accept
                </TmsButton>
              )}
              {actions.canCounter && (
                <TmsButton variant="ghost" size="sm" aria-label={`Counter offer ${q.id}`} disabled={busy} onClick={() => setDialog({ kind: 'counter', quote: q })}>
                  Counter
                </TmsButton>
              )}
              {actions.canReject && (
                <TmsButton variant="ghost" size="sm" aria-label={`Reject offer ${q.id}`} disabled={busy} onClick={() => runRejectOffer(q)}>
                  Reject
                </TmsButton>
              )}
              <TmsButton
                variant="ghost"
                size="sm"
                aria-label={`Copy link for ${q.id}`}
                disabled={busy || actions.canCopyLink === false}
                onClick={() => copyLink(q)}
              >
                <Link2 size={13} /> Copy link
              </TmsButton>
            </div>
          )
        },
      },
    ],
  }

  const banner = (
    <section aria-label="Quote totals" className="tms-grid tms-grid-4">
      <Totals label="Open quotes" value={formatCents(totals.openCents)} note={`${totals.openCount} live`} />
      <Totals
        label={`Won ${monthLabel(month)}`}
        value={formatCents(totals.wonCents)}
        note={`${totals.wonCount} quote${totals.wonCount === 1 ? '' : 's'}`}
      />
      <Totals
        label="Win rate"
        value={`${totals.winRatePct}%`}
        note={`${totals.wonCount} won / ${totals.lostCount} lost`}
      />
      <Totals
        label="Median hours to reply"
        value={totals.medianReplyHours === null ? '—' : `${totals.medianReplyHours}h`}
        note={totals.medianReplyHours === null ? 'nobody has answered yet' : 'from send to answer'}
      />
    </section>
  )

  const chips = tab === 'won-lost'
    ? [
      { key: 'month', label: 'Month is', value: monthLabel(month), onClick: () => setFiltersOpen(true) },
      {
        key: 'outcome',
        label: 'Outcome is',
        value: lostFacet ? (LOST_REASON_LABEL[lostFacet as keyof typeof LOST_REASON_LABEL] ?? lostFacet) : null,
        onClick: () => setFiltersOpen(true),
      },
    ]
    : []

  return (
    <>
      <TmsListPage<QuoteRecord>
        title="Rates"
        primaryAction={{ label: 'Quote', onClick: () => navigate('/tms/rates/new') }}
        actions={
          <Link className="tms-btn tms-btn-secondary" to="/tms/rates/lanes">Lane rates</Link>
        }
        search={{ value: query, onChange: setQuery, placeholder: 'Search quotes, customers, lanes' }}
        onRefresh={() => void refreshAll()}
        filterChips={chips}
        onAddFilter={tab === 'won-lost' ? () => setFiltersOpen(true) : undefined}
        quickTabs={{
          tabs: QUOTE_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] })),
          active: tab,
          onSelect: (key) => setTab(key as QuoteTabKey),
        }}
        banner={banner}
        columns={columnsByTab[tab]}
        rows={pageRows}
        rowKey={(q) => q.id}
        page={{ from: pageRows.length === 0 ? 0 : 1, to: pageRows.length, total: tabRows.length, pageSize, onPageSize: setPageSize }}
        emptyText={
          worklist.error
            ?? (tab === 'won-lost' && monthLoading ? `Reading ${monthLabel(month)}…` : EMPTY_TEXT[tab])
        }
        onClearFilters={() => { setQuery(''); setLostFacet('') }}
      />

      <TmsDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title="Filter closed quotes"
        footer={<TmsButton variant="primary" onClick={() => setFiltersOpen(false)}>Done</TmsButton>}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <TmsField label="Month">
            <TmsSelect
              aria-label="Quote month"
              value={month}
              onChange={(e) => { setMonthLoading(true); setMonth(e.target.value) }}
              options={months.map((ym) => ({ value: ym, label: monthLabel(ym) }))}
            />
          </TmsField>
          <TmsField label="Outcome">
            <TmsSelect
              aria-label="Lost reason"
              value={lostFacet}
              onChange={(e) => setLostFacet(e.target.value)}
              placeholder="Every outcome"
              options={lostFacets.map((reason) => ({
                value: reason,
                label: LOST_REASON_LABEL[reason as keyof typeof LOST_REASON_LABEL] ?? reason,
              }))}
            />
          </TmsField>
        </div>
      </TmsDialog>

      {dialog?.kind === 'send' && (
        <SendQuoteDialog
          open
          quote={dialog.quote}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'counter' && (
        <CounterDialog
          open
          quote={dialog.quote}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'convert' && (
        <ConvertQuoteDialog
          open
          quote={dialog.quote}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={(shipmentId) => {
            setDialog(null)
            void refreshAll()
            if (shipmentId) navigate(`/tms/shipments/${shipmentId}`)
          }}
        />
      )}
      {dialog?.kind === 'markLost' && (
        <MarkLostDialog
          open
          quote={dialog.quote}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'acceptOffer' && (
        <AcceptOfferDialog
          open
          quote={dialog.quote}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
    </>
  )
}

function Totals({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="tms-card">
      <div className="tms-card-body">
        <div className="tms-field-label">{label}</div>
        <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        <div className="tms-muted" style={{ fontSize: 12 }}>{note}</div>
      </div>
    </div>
  )
}
