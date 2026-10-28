/**
 * `/quotes` — the quote desk (spec §6.6 sell side, §6.5 buy side).
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
import { FileText, Link2, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useQuoteWorklist } from '@/hooks/useQuoteWorklist'
import {
  acceptCounter, getTmsSettings, graphqlErrorText, listQuotesByMonth, rejectOffer, restoreQuote,
} from '@/lib/apiClient'
import { chicagoDateStr, formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import { quoteState } from '@/lib/quotes'
import { cn } from '@/lib/utils'
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

const TH = 'px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-2 align-top'
const MONEY = 'px-2 py-2 text-right tabular-nums align-top'

const CHIP_VARIANT: Record<QuoteChip['tone'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  muted: 'outline',
  warn: 'secondary',
  danger: 'destructive',
  good: 'outline',
}

function Chip({ chip }: { chip: QuoteChip | null }) {
  if (!chip) return null
  return <Badge variant={CHIP_VARIANT[chip.tone]} className="ml-1 text-[10px]">{chip.text}</Badge>
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
      if (quote.lostReason && !seen.includes(quote.lostReason)) seen.push(quote.lostReason)
    }
    return seen
  }, [rows])

  const closedRows = lostFacet
    ? rows['won-lost'].filter((quote) => quote.lostReason === lostFacet)
    : rows['won-lost']

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <FileText size={18} />
        <h1 className="text-lg font-semibold">Quotes</h1>
        <Badge variant="outline">{formatCents(totals.openCents)} open</Badge>
        <Badge variant="outline">{totals.openCount} on the table</Badge>
        <Button asChild size="sm" className="ml-auto">
          <Link to="/quotes/new" aria-label="New quote"><Plus size={14} /> New quote</Link>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label="Refresh quotes"
          onClick={() => void refreshAll()}
        >
          <RefreshCw size={14} className={worklist.loading ? 'animate-spin' : undefined} />
        </Button>
      </header>

      <section aria-label="Quote totals" className="grid grid-cols-2 gap-3 border-b border-border px-5 py-3 md:grid-cols-4">
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

      <nav role="tablist" aria-label="Quote views" className="flex gap-1 overflow-x-auto border-b border-border px-5">
        {QUOTE_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            aria-label={t.label}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              tab === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground',
            )}
          >
            {t.label}
            <Badge variant="outline" className="text-[10px]">{counts[t.key]}</Badge>
          </button>
        ))}
      </nav>

      {worklist.error && <p className="px-5 py-3 text-sm text-destructive">{worklist.error}</p>}

      <div className="flex-1 overflow-auto px-5 py-3">
        {tab === 'to-price' && <ToPriceTab rows={rows['to-price']} now={now} />}

        {tab === 'sent' && (
          <SentTab
            rows={rows.sent}
            now={now}
            busy={busy}
            marginFloorBps={marginFloorBps}
            onCopyLink={copyLink}
            onSend={(quote) => setDialog({ kind: 'send', quote })}
            onConvert={(quote) => setDialog({ kind: 'convert', quote })}
            onMarkLost={(quote) => setDialog({ kind: 'markLost', quote })}
          />
        )}

        {tab === 'replies' && (
          <RepliesTab
            rows={rows.replies}
            now={now}
            busy={busy}
            onConvert={(quote) => setDialog({ kind: 'convert', quote })}
            onAcceptCounter={runAcceptCounter}
            onCounter={(quote) => setDialog({ kind: 'counter', quote })}
            onMarkLost={(quote) => setDialog({ kind: 'markLost', quote })}
          />
        )}

        {tab === 'drafts' && (
          <DraftsTab
            rows={rows.drafts}
            now={now}
            busy={busy}
            onSend={(quote) => setDialog({ kind: 'send', quote })}
          />
        )}

        {tab === 'won-lost' && (
          <WonLostTab
            rows={closedRows}
            months={months}
            month={month}
            loading={monthLoading}
            busy={busy}
            now={now}
            facets={lostFacets}
            facet={lostFacet}
            onFacet={setLostFacet}
            onMonth={(ym) => { setMonthLoading(true); setMonth(ym) }}
            onRestore={runRestore}
          />
        )}

        {tab === 'offers' && (
          <OffersTab
            rows={rows.offers}
            now={now}
            busy={busy}
            onAccept={(quote) => setDialog({ kind: 'acceptOffer', quote })}
            onCounter={(quote) => setDialog({ kind: 'counter', quote })}
            onReject={runRejectOffer}
            onCopyLink={copyLink}
          />
        )}
      </div>

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
            if (shipmentId) navigate(`/shipments/${shipmentId}`)
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
    </div>
  )
}

function Totals({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{note}</div>
    </div>
  )
}

/** The quote number, always a link to the one page that can change it. */
function QuoteLink({ quote }: { quote: QuoteRecord }) {
  return (
    <Link className="text-primary hover:underline" to={`/quotes/${quote.id}`}>{quote.id}</Link>
  )
}

function Empty({ columns, children }: { columns: number; children: string }) {
  return (
    <tr><td colSpan={columns} className="py-8 text-center text-sm text-muted-foreground">{children}</td></tr>
  )
}

/* ── To price ────────────────────────────────────────────────────────────── */

function ToPriceTab({ rows, now }: { rows: QuoteRecord[]; now: string }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className={TH} scope="col">Quote</th>
          <th className={TH} scope="col">Customer</th>
          <th className={TH} scope="col">Lane</th>
          <th className={TH} scope="col">Pickup</th>
          <th className={TH} scope="col">Equipment</th>
          <th className={TH} scope="col">Age</th>
          <th className={TH} scope="col"><span className="sr-only">Price</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty columns={7}>Nothing is waiting to be priced.</Empty>}
        {rows.map((quote) => {
          const age = ageHours(quote, now)
          return (
            <tr key={quote.id} className="border-b border-border/60">
              <td className={TD}><QuoteLink quote={quote} /></td>
              <td className={TD}>{quote.customerName || '—'}</td>
              <td className={TD}>{laneText(quote)}</td>
              <td className={TD}>{dayText(quote.pickupAppt)}</td>
              <td className={TD}>{quote.equipmentType || '—'}</td>
              <td className={TD}>{age === null ? '—' : `${Math.round(age)}h`}</td>
              <td className={cn(TD, 'whitespace-nowrap text-right')}>
                <Button asChild size="sm" variant="outline">
                  <Link to={`/quotes/${quote.id}`} aria-label={`Price quote ${quote.id}`}>Price</Link>
                </Button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* ── Sent ────────────────────────────────────────────────────────────────── */

function SentTab({ rows, now, busy, marginFloorBps, onCopyLink, onSend, onConvert, onMarkLost }: {
  rows: QuoteRecord[]
  now: string
  busy: boolean
  marginFloorBps: number | null
  onCopyLink: (quote: QuoteRecord) => void
  onSend: (quote: QuoteRecord) => void
  onConvert: (quote: QuoteRecord) => void
  onMarkLost: (quote: QuoteRecord) => void
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className={TH} scope="col">Quote</th>
          <th className={TH} scope="col">Customer</th>
          <th className={TH} scope="col">Lane</th>
          <th className={cn(TH, 'text-right')} scope="col">Amount</th>
          <th className={TH} scope="col">Expires</th>
          <th className={TH} scope="col">Last sent</th>
          <th className={TH} scope="col">Link</th>
          <th className={TH} scope="col"><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty columns={8}>No quote is sitting with a customer.</Empty>}
        {rows.map((quote) => {
          const state = quoteState(quote, now)
          return (
            <tr key={quote.id} className="border-b border-border/60">
              <td className={TD}><QuoteLink quote={quote} /></td>
              <td className={TD}>{quote.customerName || '—'}</td>
              <td className={TD}>{laneText(quote)}</td>
              <td className={MONEY}>
                {formatCents(quote.amountCents)}
                <Chip chip={marginChip(quote, marginFloorBps)} />
              </td>
              <td className={TD}><Chip chip={expiryChip(quote, now)} /></td>
              <td className={TD}>
                {dayText(quote.sentAt)}
                {quote.lastSendStatus === 'NOT_SENT' && (
                  <Badge variant="destructive" className="ml-1 text-[10px]">Not sent</Badge>
                )}
              </td>
              <td className={TD}>
                {quote.linkToken
                  ? <span className="text-xs text-muted-foreground">Live · round {quote.rounds}</span>
                  : <span className="text-xs text-muted-foreground">Spent</span>}
              </td>
              <td className={cn(TD, 'whitespace-nowrap text-right')}>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Copy link for ${quote.id}`}
                  disabled={busy || !quote.linkToken}
                  onClick={() => onCopyLink(quote)}
                >
                  <Link2 size={13} /> Copy link
                </Button>
                {state.canSend && (
                  <Button size="sm" variant="ghost" aria-label={`Re-send ${quote.id}`} disabled={busy} onClick={() => onSend(quote)}>
                    Re-send
                  </Button>
                )}
                {state.canConvert && (
                  <Button size="sm" variant="ghost" aria-label={`Convert ${quote.id}`} disabled={busy} onClick={() => onConvert(quote)}>
                    Convert
                  </Button>
                )}
                {state.canMarkLost && (
                  <Button size="sm" variant="ghost" aria-label={`Mark ${quote.id} lost`} disabled={busy} onClick={() => onMarkLost(quote)}>
                    Mark lost
                  </Button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* ── Replies ─────────────────────────────────────────────────────────────── */

function RepliesTab({ rows, now, busy, onConvert, onAcceptCounter, onCounter, onMarkLost }: {
  rows: QuoteRecord[]
  now: string
  busy: boolean
  onConvert: (quote: QuoteRecord) => void
  onAcceptCounter: (quote: QuoteRecord) => void
  onCounter: (quote: QuoteRecord) => void
  onMarkLost: (quote: QuoteRecord) => void
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className={TH} scope="col">Quote</th>
          <th className={TH} scope="col">Customer</th>
          <th className={cn(TH, 'text-right')} scope="col">Ours</th>
          <th className={cn(TH, 'text-right')} scope="col">Theirs</th>
          <th className={TH} scope="col">Message</th>
          <th className={TH} scope="col">Answered by</th>
          <th className={TH} scope="col"><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty columns={7}>Nobody has come back to us.</Empty>}
        {rows.map((quote) => {
          const state = quoteState(quote, now)
          const theirs = theirNumberCents(quote)
          const lastEvent = (quote.events ?? []).filter((e) => e.note).slice(-1)[0] ?? null
          return (
            <tr key={quote.id} className="border-b border-border/60">
              <td className={TD}><QuoteLink quote={quote} /></td>
              <td className={TD}>{quote.customerName || '—'}</td>
              <td className={MONEY}>{formatCents(quote.amountCents)}</td>
              <td className={cn(MONEY, 'font-medium')}>{theirs === null ? '—' : formatCents(theirs)}</td>
              <td className={cn(TD, 'max-w-[20rem] text-xs text-muted-foreground')}>{lastEvent?.note ?? '—'}</td>
              <td className={TD}>
                {quote.responderName || quote.responderEmail || '—'}
                <div className="text-xs text-muted-foreground">{dayText(quote.respondedAt)}</div>
              </td>
              <td className={cn(TD, 'whitespace-nowrap text-right')}>
                {state.canConvert && (
                  <Button size="sm" variant="ghost" aria-label={`Convert ${quote.id}`} disabled={busy} onClick={() => onConvert(quote)}>
                    Convert
                  </Button>
                )}
                {state.canAccept && (
                  <Button size="sm" variant="ghost" aria-label={`Accept counter on ${quote.id}`} disabled={busy} onClick={() => onAcceptCounter(quote)}>
                    Accept counter
                  </Button>
                )}
                {state.canCounter && (
                  <Button size="sm" variant="ghost" aria-label={`Counter ${quote.id}`} disabled={busy} onClick={() => onCounter(quote)}>
                    Counter
                  </Button>
                )}
                {state.canMarkLost && (
                  <Button size="sm" variant="ghost" aria-label={`Mark ${quote.id} lost`} disabled={busy} onClick={() => onMarkLost(quote)}>
                    Mark lost
                  </Button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* ── Drafts ──────────────────────────────────────────────────────────────── */

function DraftsTab({ rows, now, busy, onSend }: {
  rows: QuoteRecord[]
  now: string
  busy: boolean
  onSend: (quote: QuoteRecord) => void
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className={TH} scope="col">Quote</th>
          <th className={TH} scope="col">Customer</th>
          <th className={TH} scope="col">Lane</th>
          <th className={cn(TH, 'text-right')} scope="col">Amount</th>
          <th className={TH} scope="col">Written</th>
          <th className={TH} scope="col"><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty columns={6}>No draft is waiting to go out.</Empty>}
        {rows.map((quote) => {
          const state = quoteState(quote, now)
          return (
            <tr key={quote.id} className="border-b border-border/60">
              <td className={TD}><QuoteLink quote={quote} /></td>
              <td className={TD}>{quote.customerName || '—'}</td>
              <td className={TD}>{laneText(quote)}</td>
              <td className={MONEY}>{formatCents(quote.amountCents)}</td>
              <td className={TD}>{quote.quoteDate}</td>
              <td className={cn(TD, 'whitespace-nowrap text-right')}>
                <Button asChild size="sm" variant="ghost">
                  <Link to={`/quotes/${quote.id}`} aria-label={`Price quote ${quote.id}`}>Price</Link>
                </Button>
                {state.canSend && (
                  <Button size="sm" variant="outline" aria-label={`Send ${quote.id}`} disabled={busy} onClick={() => onSend(quote)}>
                    Send
                  </Button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* ── Won / Lost ──────────────────────────────────────────────────────────── */

function WonLostTab({ rows, months, month, loading, busy, now, facets, facet, onFacet, onMonth, onRestore }: {
  rows: QuoteRecord[]
  months: string[]
  month: string
  loading: boolean
  busy: boolean
  now: string
  facets: string[]
  facet: string
  onFacet: (value: string) => void
  onMonth: (ym: string) => void
  onRestore: (quote: QuoteRecord) => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Quote month"
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          value={month}
          onChange={(e) => onMonth(e.target.value)}
        >
          {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
        </select>
        <select
          aria-label="Lost reason"
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          value={facet}
          onChange={(e) => onFacet(e.target.value)}
        >
          <option value="">Every outcome</option>
          {facets.map((reason) => (
            <option key={reason} value={reason}>{LOST_REASON_LABEL[reason as keyof typeof LOST_REASON_LABEL] ?? reason}</option>
          ))}
        </select>
        {loading && <span className="text-xs text-muted-foreground">Reading {monthLabel(month)}…</span>}
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH} scope="col">Quote</th>
            <th className={TH} scope="col">Customer</th>
            <th className={TH} scope="col">Lane</th>
            <th className={cn(TH, 'text-right')} scope="col">Amount</th>
            <th className={TH} scope="col">Outcome</th>
            <th className={TH} scope="col">Closed</th>
            <th className={TH} scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <Empty columns={7}>Nothing closed in this month.</Empty>}
          {rows.map((quote) => {
            const state = quoteState(quote, now)
            return (
              <tr key={quote.id} className="border-b border-border/60">
                <td className={TD}><QuoteLink quote={quote} /></td>
                <td className={TD}>{quote.customerName || '—'}</td>
                <td className={TD}>{laneText(quote)}</td>
                <td className={MONEY}>{formatCents(quote.amountCents)}</td>
                <td className={TD}>
                  {statusLabel(quote)}
                  {quote.lostReason && (
                    <Badge variant="outline" className="ml-1 text-[10px]">{LOST_REASON_LABEL[quote.lostReason]}</Badge>
                  )}
                </td>
                <td className={TD}>{dayText(quote.closedAt ?? quote.wonAt)}</td>
                <td className={cn(TD, 'whitespace-nowrap text-right')}>
                  {quote.shipmentId && (
                    <Button asChild size="sm" variant="ghost">
                      <Link to={`/shipments/${quote.shipmentId}`} aria-label={`Shipment for ${quote.id}`}>Shipment</Link>
                    </Button>
                  )}
                  {state.canRestore && (
                    <Button size="sm" variant="ghost" aria-label={`Restore ${quote.id}`} disabled={busy} onClick={() => onRestore(quote)}>
                      Restore
                    </Button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ── Carrier offers ──────────────────────────────────────────────────────── */

function OffersTab({ rows, now, busy, onAccept, onCounter, onReject, onCopyLink }: {
  rows: QuoteRecord[]
  now: string
  busy: boolean
  onAccept: (quote: QuoteRecord) => void
  onCounter: (quote: QuoteRecord) => void
  onReject: (quote: QuoteRecord) => void
  onCopyLink: (quote: QuoteRecord) => void
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className={TH} scope="col">Load</th>
          <th className={TH} scope="col">Carrier</th>
          <th className={cn(TH, 'text-right')} scope="col">Ours</th>
          <th className={cn(TH, 'text-right')} scope="col">Theirs</th>
          <th className={TH} scope="col">Status</th>
          <th className={TH} scope="col">Expires</th>
          <th className={TH} scope="col">Whose move</th>
          <th className={TH} scope="col"><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty columns={8}>No offer is out with a carrier.</Empty>}
        {rows.map((quote) => {
          const actions = offerActions(quote, now)
          const theirs = theirNumberCents(quote)
          return (
            <tr key={quote.id} className="border-b border-border/60">
              <td className={TD}>
                {quote.shipmentId
                  ? (
                    <Link className="text-primary hover:underline" to={`/shipments/${quote.shipmentId}`}>
                      {quote.shipmentNumber ?? quote.loadNumber ?? quote.shipmentId}
                    </Link>
                  )
                  : quote.loadNumber ?? '—'}
              </td>
              <td className={TD}>
                {quote.carrierName || '—'}
                {quote.carrierMc && <span className="ml-1 text-xs text-muted-foreground">MC {quote.carrierMc}</span>}
              </td>
              <td className={MONEY}>{formatCents(quote.amountCents)}</td>
              <td className={cn(MONEY, 'font-medium')}>{theirs === null ? '—' : formatCents(theirs)}</td>
              <td className={TD}>{statusLabel(quote)}</td>
              <td className={TD}><Chip chip={expiryChip(quote, now)} /></td>
              <td className={TD}>{whoseMoveLabel(quote, now)}</td>
              <td className={cn(TD, 'whitespace-nowrap text-right')}>
                {actions.canAccept && (
                  <Button size="sm" variant="ghost" aria-label={`Accept offer ${quote.id}`} disabled={busy} onClick={() => onAccept(quote)}>
                    Accept
                  </Button>
                )}
                {actions.canCounter && (
                  <Button size="sm" variant="ghost" aria-label={`Counter offer ${quote.id}`} disabled={busy} onClick={() => onCounter(quote)}>
                    Counter
                  </Button>
                )}
                {actions.canReject && (
                  <Button size="sm" variant="ghost" aria-label={`Reject offer ${quote.id}`} disabled={busy} onClick={() => onReject(quote)}>
                    Reject
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Copy link for ${quote.id}`}
                  disabled={busy || !actions.canCopyLink}
                  onClick={() => onCopyLink(quote)}
                >
                  <Link2 size={13} /> Copy link
                </Button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
