/**
 * `/quotes/:id` — one quote, and `/quotes/new` — the next one.
 *
 * The page is the quote: the freight it covers, the lines behind the number, what the
 * lane has actually paid, and everything that has happened to it. Pricing is live and
 * comes from `priceQuoteLines`, which is the same function `SAVE_QUOTE` prices with, so
 * the totals on screen are the totals that will be stored — including the warnings,
 * which are shown while the number is being written rather than sprung at the send.
 *
 * Every verb is gated by `quoteState`. A quote that expired offers Send and not Convert;
 * a counter that landed offers Accept and Counter and not Send. The page never compares
 * a status to a string to decide what may be done, because the Lambda does not either.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ChevronLeft, Copy, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAuthUser } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useQuote } from '@/hooks/useQuote'
import {
  acceptCounter, cancelQuote, getTmsSettings, graphqlErrorText, restoreQuote, saveQuote,
} from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import { humanChargeCode, priceQuoteLines, quoteState } from '@/lib/quotes'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { MODE_OPTIONS } from '@/features/shipments/orderDraft'
import { LaneHistoryPanel } from './components/LaneHistoryPanel'
import { ConvertQuoteDialog } from './components/ConvertQuoteDialog'
import { CounterDialog } from './components/CounterDialog'
import { DuplicateQuoteDialog } from './components/DuplicateQuoteDialog'
import { MarkLostDialog } from './components/MarkLostDialog'
import { SendQuoteDialog } from './components/SendQuoteDialog'
import { expiryChip, laneLookupKeys, marginChip, quoteLinkUrl, statusLabel, whoseMoveLabel } from './quoteViews'
import type {
  ChargeCalc, ChargeCodeDef, CustomerRecord, LoadChargeInput, QuoteRecord, RateType, ShipmentMode,
  TmsSettings,
} from '@/types/tms'
import type { Stop, StopType } from '@/types'

type DetailDialog =
  | { kind: 'send' }
  | { kind: 'counter' }
  | { kind: 'convert' }
  | { kind: 'duplicate' }
  | { kind: 'markLost' }

interface StopDraft {
  id: string
  type: StopType
  city: string
  state: string
  zip: string
  appt: string
}

interface QuoteForm {
  customerId: string
  contactName: string
  contactEmail: string
  mode: ShipmentMode
  rateType: RateType
  equipmentType: string
  equipmentLengthFt: string
  commodity: string
  weightLbs: string
  miles: string
  customerMessage: string
  internalNotes: string
  targetBuyCents: number | null
}

const CARD = 'rounded-md border border-border bg-card p-4'
const CALC_OPTIONS: ChargeCalc[] = ['FLAT', 'PER_MILE', 'PER_CWT', 'PERCENT']

/** `2026-03-18T15:00:00.000Z` → `2026-03-18T15:00`, which is what a datetime input eats. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function stopsFrom(quote: QuoteRecord | null): StopDraft[] {
  const stops = quote?.stops ?? []
  if (stops.length === 0) {
    return [
      { id: 'pickup', type: 'pickup', city: '', state: '', zip: '', appt: '' },
      { id: 'delivery', type: 'delivery', city: '', state: '', zip: '', appt: '' },
    ]
  }
  return stops.map((stop, index) => ({
    id: stop.id || `stop-${index}`,
    type: stop.type,
    city: stop.address?.city ?? (stop.city ?? '').split(',')[0]?.trim() ?? '',
    state: stop.address?.state ?? (stop.city ?? '').split(',')[1]?.trim() ?? '',
    zip: stop.address?.zip ?? '',
    appt: toLocalInput(stop.appt),
  }))
}

/**
 * `preselectedCustomerId` is what `/quotes/new?customerId=…` asked for: a saved quote
 * carries its own customer, a blank one takes the id the directory handed over.
 */
function formFrom(quote: QuoteRecord | null, preselectedCustomerId = ''): QuoteForm {
  return {
    customerId: quote?.customerId ?? preselectedCustomerId,
    contactName: quote?.contactName ?? '',
    contactEmail: quote?.contactEmail ?? '',
    mode: quote?.mode ?? 'FTL',
    rateType: quote?.rateType ?? 'SPOT',
    equipmentType: quote?.equipmentType ?? '',
    equipmentLengthFt: quote?.equipmentLengthFt != null ? String(quote.equipmentLengthFt) : '',
    commodity: quote?.commodity ?? '',
    weightLbs: quote?.weightLbs != null ? String(quote.weightLbs) : '',
    miles: quote?.miles != null ? String(quote.miles) : '',
    customerMessage: quote?.customerMessage ?? '',
    internalNotes: quote?.internalNotes ?? '',
    targetBuyCents: quote?.targetBuyCents ?? null,
  }
}

function linesFrom(quote: QuoteRecord | null): LoadChargeInput[] {
  const lines = (quote?.lines ?? []).filter((line) => line.side === 'CUSTOMER')
  if (lines.length > 0) return lines
  return [{
    side: 'CUSTOMER', code: 'LINEHAUL', label: null, calculatedBy: 'FLAT', rateCents: 0,
    count: 1, isRate: true, sortOrder: 0, note: null,
  }]
}

export function QuoteDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const user = useAuthUser()
  const quoteId = id ?? null
  const { quote, loading, error, refresh } = useQuote(quoteId)
  const { customers } = useDirectory()
  // `/quotes/new?customerId=…` — the New quote button on a customer's profile hands the
  // customer over so the editor opens on them instead of making the operator find them
  // again. Only a blank quote takes it; a saved one has a customer of its own. The
  // pricing defaults and the default charge lines that follow from the choice are
  // applied by `SAVE_QUOTE`, so the selection is the whole of the prefill.
  const [search] = useSearchParams()
  const presetCustomerId = quoteId ? '' : (search.get('customerId') ?? '')

  const [settings, setSettings] = useState<TmsSettings | null>(null)
  // The editor mirrors the server row until somebody types, exactly as the Financials
  // grid does: a 60 s poll must never wipe what is being written, and a quote nobody has
  // touched must never show a stale copy of itself. The first edit forks a draft; Save
  // drops it and the refreshed row shows through again.
  const [formDraft, setFormDraft] = useState<QuoteForm | null>(null)
  const [stopsDraft, setStopsDraft] = useState<StopDraft[] | null>(null)
  const [linesDraft, setLinesDraft] = useState<LoadChargeInput[] | null>(null)
  const [dialog, setDialog] = useState<DetailDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => new Date().toISOString())

  // Non-async on purpose (react-hooks/set-state-in-effect).
  useEffect(() => {
    let alive = true
    getTmsSettings()
      .then((s) => { if (alive) setSettings(s) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const form = formDraft ?? formFrom(quote, presetCustomerId)
  const stops = useMemo(() => stopsDraft ?? stopsFrom(quote), [stopsDraft, quote])
  const lines = useMemo(() => linesDraft ?? linesFrom(quote), [linesDraft, quote])

  const editForm = (update: (prev: QuoteForm) => QuoteForm) =>
    setFormDraft((prev) => update(prev ?? formFrom(quote, presetCustomerId)))
  const editStops = (update: (prev: StopDraft[]) => StopDraft[]) =>
    setStopsDraft((prev) => update(prev ?? stopsFrom(quote)))
  const editLines = (update: (prev: LoadChargeInput[]) => LoadChargeInput[]) =>
    setLinesDraft((prev) => update(prev ?? linesFrom(quote)))

  const forgetDraft = () => {
    setFormDraft(null)
    setStopsDraft(null)
    setLinesDraft(null)
  }

  const customer: CustomerRecord | null = customers.find((row) => row.id === form.customerId) ?? null
  const catalog: ChargeCodeDef[] = settings?.chargeCodes ?? []
  const milesValue = Number(form.miles) || null
  const weightValue = Number(form.weightLbs) || null

  const pricing = useMemo(
    () => priceQuoteLines(
      lines,
      { miles: milesValue, weightLbs: weightValue },
      customer?.pricingDefaults ?? null,
      settings?.marginFloorBps ?? null,
      customer?.pricingDefaults ?? null,
    ),
    [lines, milesValue, weightValue, customer, settings],
  )

  const laneKeys = useMemo(() => {
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (!first || !last) return { laneKey: null, laneKey3: null }
    return laneLookupKeys({
      originCity: first.city, originState: first.state, originZip: first.zip,
      destCity: last.city, destState: last.state, destZip: last.zip,
    })
  }, [stops])

  const state = quote ? quoteState(quote, now) : null
  const editable = !quote || (state?.canEdit ?? false)

  const toStops = useCallback((): Stop[] => stops.map((draft, index) => ({
    id: draft.id || `stop-${index}`,
    type: draft.type,
    city: draft.state ? `${draft.city}, ${draft.state}` : draft.city,
    address: { city: draft.city, state: draft.state, zip: draft.zip },
    appt: draft.appt ? new Date(draft.appt).toISOString() : '',
    driverId: null,
    sequence: index,
  })), [stops])

  const save = () => {
    setBusy(true)
    const built = toStops()
    saveQuote({
      quoteId: quote?.id,
      expectedVersion: quote?.version,
      side: 'SELL',
      customerId: form.customerId || null,
      customerName: customer?.name ?? null,
      contactName: form.contactName || null,
      contactEmail: form.contactEmail || null,
      customerRepId: quote?.customerRepId ?? user?.email ?? null,
      stops: built,
      pickupAppt: built[0]?.appt || null,
      deliveryAppt: built[built.length - 1]?.appt || null,
      mode: form.mode,
      rateType: form.rateType,
      equipmentType: form.equipmentType || null,
      equipmentLengthFt: Number(form.equipmentLengthFt) || null,
      commodity: form.commodity || null,
      weightLbs: weightValue,
      miles: milesValue,
      lines,
      targetBuyCents: form.targetBuyCents,
      customerMessage: form.customerMessage || null,
      internalNotes: form.internalNotes || null,
    })
      .then((result) => {
        toast.success(`${result.quote.id} saved — ${formatCents(result.pricing.revenueCents)}`)
        // The saved row is the truth now; the local draft has nothing left to say.
        forgetDraft()
        if (!quote) navigate(`/quotes/${result.quote.id}`)
        else return refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not save the quote'))
      .finally(() => setBusy(false))
  }

  const runAcceptCounter = () => {
    if (!quote) return
    setBusy(true)
    acceptCounter({ quoteId: quote.id, expectedVersion: quote.version })
      .then(() => {
        toast.success('Counter accepted — the lines now add up to their number')
        return refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not accept that counter'))
      .finally(() => setBusy(false))
  }

  const runRestore = () => {
    if (!quote) return
    setBusy(true)
    restoreQuote({ quoteId: quote.id, expectedVersion: quote.version })
      .then(() => {
        toast.success('Back on the board')
        return refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not restore the quote'))
      .finally(() => setBusy(false))
  }

  const runCancel = () => {
    if (!quote) return
    setBusy(true)
    cancelQuote({ quoteId: quote.id, expectedVersion: quote.version })
      .then(() => {
        toast.success(`${quote.id} canceled`)
        return refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not cancel the quote'))
      .finally(() => setBusy(false))
  }

  const copyLink = () => {
    const url = quoteLinkUrl(quote?.linkToken, window.location.origin)
    if (!url) { toast.error('This round has no live link'); return }
    navigator.clipboard.writeText(url)
      .then(() => toast.success('Link copied'))
      .catch(() => toast.error('Could not copy the link'))
  }

  const closeAndRefresh = () => {
    setDialog(null)
    setNow(new Date().toISOString())
    void refresh()
  }

  if (quoteId && !quote) {
    return (
      <div className="p-6 text-sm">
        {loading
          ? <span className="flex items-center gap-2 text-muted-foreground"><Loader2 size={14} className="animate-spin" /> Loading quote…</span>
          : <span className="text-destructive">{error ?? 'Quote not found.'}</span>}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Button asChild variant="ghost" size="sm">
          <Link to="/quotes" aria-label="Back to quotes"><ChevronLeft size={14} /> Quotes</Link>
        </Button>
        <h1 className="text-lg font-semibold">{quote?.id ?? 'New quote'}</h1>
        {quote && <Badge variant="outline">{statusLabel(quote)}</Badge>}
        {quote && (() => {
          const chip = expiryChip(quote, now)
          return chip ? <Badge variant={chip.tone === 'danger' ? 'destructive' : 'outline'}>{chip.text}</Badge> : null
        })()}
        {quote && <span className="text-sm text-muted-foreground">{quote.customerName ?? 'No customer'}</span>}
        {quote?.customerRepId && <span className="text-xs text-muted-foreground">rep {quote.customerRepId}</span>}
        {quote && <span className="text-xs text-muted-foreground">whose move: {whoseMoveLabel(quote, now)}</span>}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-9 w-9"
          aria-label="Refresh quote"
          onClick={() => { setNow(new Date().toISOString()); void refresh() }}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <Button aria-label="Save the quote" disabled={busy || !editable} onClick={save}>Save</Button>
        {(!quote || state?.canSend) && (
          <Button
            variant="outline"
            aria-label="Send the quote"
            disabled={busy || !quote}
            onClick={() => setDialog({ kind: 'send' })}
          >
            Send…
          </Button>
        )}
        {state?.canCounter && (
          <Button variant="outline" aria-label="Counter the quote" disabled={busy} onClick={() => setDialog({ kind: 'counter' })}>
            Counter…
          </Button>
        )}
        {state?.canAccept && (
          <Button variant="outline" aria-label="Accept their counter" disabled={busy} onClick={runAcceptCounter}>
            Accept counter
          </Button>
        )}
        {state?.canConvert && (
          <Button variant="outline" aria-label="Convert to shipment" disabled={busy} onClick={() => setDialog({ kind: 'convert' })}>
            Convert to shipment
          </Button>
        )}
        {quote && (
          <Button variant="outline" aria-label="Duplicate the quote" disabled={busy} onClick={() => setDialog({ kind: 'duplicate' })}>
            Duplicate…
          </Button>
        )}
        {state?.canMarkLost && (
          <Button variant="ghost" aria-label="Mark the quote lost" disabled={busy} onClick={() => setDialog({ kind: 'markLost' })}>
            Mark lost
          </Button>
        )}
        {state?.canRestore && (
          <Button variant="ghost" aria-label="Restore the quote" disabled={busy} onClick={runRestore}>Restore</Button>
        )}
        {state?.canCancel && (
          <Button variant="ghost" aria-label="Cancel the quote" disabled={busy} onClick={runCancel}>Cancel</Button>
        )}
        {quote?.linkToken && (
          <Button variant="ghost" aria-label="Copy the public link" disabled={busy} onClick={copyLink}>
            <Copy size={13} /> Copy link
          </Button>
        )}
      </div>

      <div className="grid flex-1 gap-4 px-5 py-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* ── Freight ───────────────────────────────────────────────── */}
          <section className={CARD}>
            <h2 className="mb-3 text-sm font-semibold">Freight</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="quote-customer">Customer</Label>
                <select
                  id="quote-customer"
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                  value={form.customerId}
                  disabled={!editable || busy}
                  onChange={(e) => editForm((prev) => ({ ...prev, customerId: e.target.value }))}
                >
                  <option value="">Pick a customer</option>
                  {customers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                </select>
              </div>
              <Text label="Contact" value={form.contactName} disabled={!editable || busy}
                onChange={(v) => editForm((prev) => ({ ...prev, contactName: v }))} />
              <Text label="Contact e-mail" value={form.contactEmail} disabled={!editable || busy}
                onChange={(v) => editForm((prev) => ({ ...prev, contactEmail: v }))} />
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="quote-mode">Mode</Label>
                <select
                  id="quote-mode"
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                  value={form.mode}
                  disabled={!editable || busy}
                  onChange={(e) => editForm((prev) => ({ ...prev, mode: e.target.value as ShipmentMode }))}
                >
                  {MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="quote-rate-type">Rate type</Label>
                <select
                  id="quote-rate-type"
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                  value={form.rateType}
                  disabled={!editable || busy}
                  onChange={(e) => editForm((prev) => ({ ...prev, rateType: e.target.value as RateType }))}
                >
                  <option value="SPOT">Spot</option>
                  <option value="CONTRACT">Contract</option>
                </select>
              </div>
              <Text label="Equipment" value={form.equipmentType} disabled={!editable || busy}
                onChange={(v) => editForm((prev) => ({ ...prev, equipmentType: v }))} />
              <Text label="Length (ft)" value={form.equipmentLengthFt} disabled={!editable || busy}
                onChange={(v) => editForm((prev) => ({ ...prev, equipmentLengthFt: v }))} />
              <Text label="Commodity" value={form.commodity} disabled={!editable || busy}
                onChange={(v) => editForm((prev) => ({ ...prev, commodity: v }))} />
              <Text label="Weight (lbs)" value={form.weightLbs} disabled={!editable || busy}
                onChange={(v) => editForm((prev) => ({ ...prev, weightLbs: v }))} />
              <Text label="Miles" value={form.miles} disabled={!editable || busy}
                onChange={(v) => editForm((prev) => ({ ...prev, miles: v }))} />
            </div>
          </section>

          {/* ── Stops ─────────────────────────────────────────────────── */}
          <section className={CARD}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold">Stops</h2>
              <span className="text-xs text-muted-foreground">{laneKeys.laneKey ?? 'lane not keyed yet'}</span>
              {editable && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  aria-label="Add a stop"
                  disabled={busy}
                  onClick={() => editStops((prev) => [
                    ...prev.slice(0, -1),
                    { id: `stop-${prev.length}`, type: 'delivery', city: '', state: '', zip: '', appt: '' },
                    prev[prev.length - 1],
                  ])}
                >
                  <Plus size={13} /> Stop
                </Button>
              )}
            </div>
            <div className="space-y-2">
              {stops.map((stop, index) => (
                <div key={stop.id} className="grid grid-cols-12 items-end gap-2">
                  <div className="col-span-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Type</Label>
                    <select
                      aria-label={`Stop ${index + 1} type`}
                      className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                      value={stop.type}
                      disabled={!editable || busy}
                      onChange={(e) => editStops((prev) => prev.map((row, i) => (
                        i === index ? { ...row, type: e.target.value as StopType } : row
                      )))}
                    >
                      <option value="pickup">Pickup</option>
                      <option value="delivery">Delivery</option>
                    </select>
                  </div>
                  <div className="col-span-3">
                    <Text label={`Stop ${index + 1} city`} value={stop.city} disabled={!editable || busy}
                      onChange={(v) => editStops((prev) => prev.map((row, i) => (i === index ? { ...row, city: v } : row)))} />
                  </div>
                  <div className="col-span-2">
                    <Text label={`Stop ${index + 1} state`} value={stop.state} disabled={!editable || busy}
                      onChange={(v) => editStops((prev) => prev.map((row, i) => (i === index ? { ...row, state: v } : row)))} />
                  </div>
                  <div className="col-span-2">
                    <Text label={`Stop ${index + 1} ZIP`} value={stop.zip} disabled={!editable || busy}
                      onChange={(v) => editStops((prev) => prev.map((row, i) => (i === index ? { ...row, zip: v } : row)))} />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Appointment</Label>
                    <Input
                      type="datetime-local"
                      aria-label={`Stop ${index + 1} appointment`}
                      className="h-9 text-sm"
                      value={stop.appt}
                      disabled={!editable || busy}
                      onChange={(e) => editStops((prev) => prev.map((row, i) => (
                        i === index ? { ...row, appt: e.target.value } : row
                      )))}
                    />
                  </div>
                  <div className="col-span-1">
                    {editable && stops.length > 2 && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-9 w-9"
                        aria-label={`Remove stop ${index + 1}`}
                        disabled={busy}
                        onClick={() => editStops((prev) => prev.filter((_, i) => i !== index))}
                      >
                        <Trash2 size={13} />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── The price ─────────────────────────────────────────────── */}
          <section className={CARD}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold">Customer lines</h2>
              {editable && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  aria-label="Add a charge line"
                  disabled={busy}
                  onClick={() => editLines((prev) => [...prev, {
                    side: 'CUSTOMER', code: '', label: null, calculatedBy: 'FLAT', rateCents: 0,
                    count: 1, isRate: false, sortOrder: prev.length, note: null,
                  }])}
                >
                  <Plus size={13} /> Line
                </Button>
              )}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-1 py-1 text-left">Code</th>
                  <th className="px-1 py-1 text-left">How</th>
                  <th className="px-1 py-1 text-right">Rate</th>
                  <th className="px-1 py-1 text-right">Count</th>
                  <th className="px-1 py-1" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={`${line.code}-${index}`} className="border-b border-border/60">
                    <td className="px-1 py-1">
                      <select
                        aria-label={`Line ${index + 1} code`}
                        className="h-8 w-full rounded-md border border-border bg-background px-1 text-sm"
                        value={line.code}
                        disabled={!editable || busy}
                        onChange={(e) => editLines((prev) => prev.map((row, i) => (
                          i === index ? { ...row, code: e.target.value } : row
                        )))}
                      >
                        <option value="">Pick a code</option>
                        {catalog.map((code) => <option key={code.code} value={code.code}>{code.label}</option>)}
                        {line.code && !catalog.some((code) => code.code === line.code) && (
                          <option value={line.code}>{humanChargeCode(line.code)}</option>
                        )}
                      </select>
                    </td>
                    <td className="px-1 py-1">
                      <select
                        aria-label={`Line ${index + 1} calculation`}
                        className="h-8 w-full rounded-md border border-border bg-background px-1 text-sm"
                        value={line.calculatedBy}
                        disabled={!editable || busy}
                        onChange={(e) => editLines((prev) => prev.map((row, i) => (
                          i === index ? { ...row, calculatedBy: e.target.value as ChargeCalc } : row
                        )))}
                      >
                        {CALC_OPTIONS.map((calc) => <option key={calc} value={calc}>{calc}</option>)}
                      </select>
                    </td>
                    <td className="px-1 py-1">
                      <MoneyField
                        value={line.rateCents}
                        disabled={!editable || busy}
                        onChange={(cents) => editLines((prev) => prev.map((row, i) => (
                          i === index ? { ...row, rateCents: cents ?? 0 } : row
                        )))}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <Input
                        type="number"
                        aria-label={`Line ${index + 1} count`}
                        className="h-8 w-20 text-right text-sm"
                        value={line.count ?? 1}
                        disabled={!editable || busy}
                        onChange={(e) => editLines((prev) => prev.map((row, i) => (
                          i === index ? { ...row, count: Number(e.target.value) || 0 } : row
                        )))}
                      />
                    </td>
                    <td className="px-1 py-1 text-right">
                      {editable && lines.length > 1 && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          aria-label={`Remove line ${index + 1}`}
                          disabled={busy}
                          onClick={() => editLines((prev) => prev.filter((_, i) => i !== index))}
                        >
                          <Trash2 size={13} />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Money label="Revenue" cents={pricing.revenueCents} />
              <Money label="Cost" cents={pricing.costCents} />
              <Money label="Profit" cents={pricing.profitCents} />
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Margin</div>
                <div className="tabular-nums">{(pricing.marginBps / 100).toFixed(1)}%</div>
              </div>
              <Money label="Top spend" cents={pricing.topSpendCents} />
              {pricing.targetBuyCents != null && <Money label="Target buy" cents={pricing.targetBuyCents} />}
              <div className="md:col-span-2">
                <MoneyField
                  label="Target buy override"
                  value={form.targetBuyCents}
                  disabled={!editable || busy}
                  onChange={(cents) => editForm((prev) => ({ ...prev, targetBuyCents: cents }))}
                />
              </div>
            </div>

            {pricing.warnings.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                {pricing.warnings.map((warning) => (
                  <li key={warning.key}>
                    {warning.message}
                    {warning.adminOnly && <Badge variant="outline" className="ml-1 text-[10px]">owner / admin</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Notes ─────────────────────────────────────────────────── */}
          <section className={CARD}>
            <h2 className="mb-3 text-sm font-semibold">Notes</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="quote-message">
                  What the customer reads
                </Label>
                <Textarea
                  id="quote-message"
                  rows={3}
                  className="text-sm"
                  value={form.customerMessage}
                  disabled={busy}
                  onChange={(e) => editForm((prev) => ({ ...prev, customerMessage: e.target.value }))}
                />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="quote-internal">
                  Internal — never leaves the building
                </Label>
                <Textarea
                  id="quote-internal"
                  rows={3}
                  className="text-sm"
                  value={form.internalNotes}
                  disabled={busy}
                  onChange={(e) => editForm((prev) => ({ ...prev, internalNotes: e.target.value }))}
                />
              </div>
            </div>
          </section>
        </div>

        {/* ── Lane history and the thread ───────────────────────────── */}
        <div className="space-y-4">
          <LaneHistoryPanel
            laneKey={quote?.laneKey ?? laneKeys.laneKey}
            laneKey3={quote?.laneKey3 ?? laneKeys.laneKey3}
            miles={milesValue}
            equipmentType={form.equipmentType || null}
            rateType={form.rateType}
          />

          {quote && <Thread quote={quote} />}
        </div>
      </div>

      {quote && dialog?.kind === 'send' && (
        <SendQuoteDialog open quote={quote} onOpenChange={(o) => { if (!o) setDialog(null) }} onDone={closeAndRefresh} />
      )}
      {quote && dialog?.kind === 'counter' && (
        <CounterDialog open quote={quote} onOpenChange={(o) => { if (!o) setDialog(null) }} onDone={closeAndRefresh} />
      )}
      {quote && dialog?.kind === 'convert' && (
        <ConvertQuoteDialog
          open
          quote={quote}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={(shipmentId) => {
            setDialog(null)
            if (shipmentId) navigate(`/shipments/${shipmentId}`)
            else void refresh()
          }}
        />
      )}
      {quote && dialog?.kind === 'duplicate' && (
        <DuplicateQuoteDialog open quote={quote} onOpenChange={(o) => { if (!o) setDialog(null) }} onDone={closeAndRefresh} />
      )}
      {quote && dialog?.kind === 'markLost' && (
        <MarkLostDialog open quote={quote} onOpenChange={(o) => { if (!o) setDialog(null) }} onDone={closeAndRefresh} />
      )}
    </div>
  )
}

function Text({ label, value, disabled, onChange }: {
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      <Input
        aria-label={label}
        className="h-9 text-sm"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function Money({ label, cents }: { label: string; cents: number }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="tabular-nums">{formatCents(cents)}</div>
    </div>
  )
}

/**
 * Everything that has happened to this quote, newest last: what we did, what we sent and
 * who answered. The sends and the response are kept as fields on the row rather than as
 * events, so they are drawn here beside the thread rather than inside it.
 */
function Thread({ quote }: { quote: QuoteRecord }) {
  const events = quote.events ?? []
  const marginBadge = marginChip(quote, null)
  return (
    <section className={CARD}>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        Thread
        <Badge variant="outline" className="text-[10px]">round {quote.rounds}</Badge>
        {marginBadge && <Badge variant="outline" className="text-[10px]">{marginBadge.text}</Badge>}
      </h2>

      <dl className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="uppercase tracking-wider text-muted-foreground">Sent</dt>
          <dd>
            {quote.sentAt ? formatDateTime(quote.sentAt) : 'never'}
            {quote.sendCount ? ` · ${quote.sendCount} send${quote.sendCount === 1 ? '' : 's'}` : ''}
            {quote.lastSendStatus === 'NOT_SENT' && (
              <Badge variant="destructive" className="ml-1 text-[10px]">Not sent</Badge>
            )}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-muted-foreground">To</dt>
          <dd className="truncate">{quote.sentTo ?? quote.contactEmail ?? '—'}</dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-muted-foreground">Answered</dt>
          <dd>{quote.respondedAt ? `${quote.response ?? ''} ${formatDateTime(quote.respondedAt)}` : 'not yet'}</dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-muted-foreground">By</dt>
          <dd className="truncate">{quote.responderName ?? quote.responderEmail ?? '—'}</dd>
        </div>
      </dl>

      <ol className="space-y-2 text-xs">
        {events.length === 0 && <li className="text-muted-foreground">Nothing has happened to this quote yet.</li>}
        {events.map((event, index) => (
          <li key={`${event.at}-${index}`} className="border-l-2 border-border pl-2">
            <div className="font-medium">
              {event.kind.replace(/_/g, ' ').toLowerCase()}
              {event.amountCents != null && <span className="ml-1 tabular-nums">{formatCents(event.amountCents)}</span>}
            </div>
            <div className="text-muted-foreground">{formatDateTime(event.at)} · {event.by}</div>
            {event.note && <div className="mt-0.5">{event.note}</div>}
          </li>
        ))}
      </ol>
    </section>
  )
}
