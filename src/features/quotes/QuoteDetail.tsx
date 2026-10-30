/**
 * `/tms/rates/:id` — one quote, and `/tms/rates/new` — the next one.
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
 *
 * `/tms/rates/new?run=<id>` is the QUOTE agent's door (Step K). The run's proposal is
 * pre-typed into the blank editor and nothing else: the agent holds no write grant on
 * Quote and cannot invoke anything. `SAVE_QUOTE` runs from this page with the operator's
 * own token, lands the quote in REQUESTED, and the run is linked to the saved id after.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ChevronLeft, Copy, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge, TmsButton, TmsCard, TmsField, TmsIconButton, TmsInput, TmsPage, TmsSelect, TmsTextarea,
} from '@/features/tms/kit'
import { useAuthUser } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useQuote } from '@/hooks/useQuote'
import {
  acceptCounter, cancelQuote, getTmsSettings, getWorkflowRun, graphqlErrorText, linkWorkflowRun,
  priceFromMarket, restoreQuote, saveQuote,
} from '@/lib/apiClient'
import type { MarketRateResult } from '@/lib/apiClient'
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
  ChargeCalc, ChargeCodeDef, CustomerRecord, LoadChargeInput, QuoteProposal, QuoteRecord, RateType,
  ShipmentMode, TmsSettings, WorkflowRunRecord,
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
 * `preselectedCustomerId` is what `/tms/rates/new?customerId=…` asked for: a saved quote
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

/** What `/tms/rates/new?run=…` seeds into the blank editor, and the run it came from. */
interface RunSeed {
  run: WorkflowRunRecord
  form: QuoteForm
  stops: StopDraft[]
  /** The name the agent read, carried only when the party was never matched to an id. */
  customerName: string | null
}

/**
 * Why a `?run=…` seeded nothing, or null when the run may seed the form.
 *
 * A stale link is ordinary — a colleague applied the run an hour ago, or dismissed it —
 * so the page opens as a blank New quote and says why rather than failing.
 */
function seedRefusal(runId: string, run: WorkflowRunRecord | null): string | null {
  if (run == null) return `Workflow run ${runId} was not found, so nothing was seeded.`
  if (run.proposalKind !== 'QUOTE' || run.proposal?.kind !== 'QUOTE') {
    return `Workflow run ${runId} did not propose a quote, so nothing was seeded.`
  }
  if (run.outcome !== 'PROPOSED') {
    const outcome = (run.outcome ?? 'unresolved').toLowerCase()
    return `Workflow run ${runId} is already ${outcome}, so nothing was seeded.`
  }
  return null
}

/**
 * A rate request carries a date, never an appointment time: `2026-03-18` is the day the
 * customer asked for, and the stop's clock is left at midnight for a person to set.
 */
function apptFromProposal(value: string | null | undefined): string {
  const stated = (value ?? '').trim()
  if (!stated) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(stated)) return `${stated}T00:00`
  return toLocalInput(stated)
}

/**
 * The target the customer named, and anything else the agent read, as an internal note.
 *
 * Their number is not our price, so it never touches a charge line or the target buy —
 * it is recorded where the desk can read it while pricing and the customer cannot.
 */
function requestNoteFrom(proposal: QuoteProposal): string {
  const parts: string[] = []
  if (proposal.targetRateCents != null) {
    parts.push(`Target rate named in the e-mail: ${formatCents(proposal.targetRateCents)}`)
  }
  const notes = (proposal.notes ?? '').trim()
  if (notes) parts.push(notes)
  return parts.join('\n\n')
}

/**
 * The blank editor, filled in with what the agent read out of the e-mail.
 *
 * Only fields the proposal actually states are seeded: `mode` and the rate type stay on
 * the form's own defaults because a rate request names neither, and a guess here would be
 * indistinguishable from something the customer wrote. The customer picker takes an id
 * only when the run matched the party by e-mail address — the same rule tenders apply in
 * `proposalToPrefill`, because a domain or a name is a candidate, never an answer.
 */
function seedFromRun(run: WorkflowRunRecord, proposal: QuoteProposal): RunSeed {
  const matchedId = run.partyKind === 'CUSTOMER' && run.partyMatchHow === 'EMAIL' ? (run.partyId ?? '') : ''
  const [pickup, delivery] = stopsFrom(null)
  const place = (part: QuoteProposal['origin'], dateStr: string | null | undefined) => ({
    city: (part?.city ?? '').trim(),
    state: (part?.state ?? '').trim(),
    zip: (part?.zip ?? '').trim(),
    appt: apptFromProposal(dateStr),
  })
  return {
    run,
    form: {
      ...formFrom(null, matchedId),
      contactName: (run.fromName ?? '').trim(),
      contactEmail: (run.fromEmail ?? '').trim(),
      equipmentType: (proposal.equipmentType ?? '').trim(),
      commodity: (proposal.commodity ?? '').trim(),
      weightLbs: proposal.weightLbs != null ? String(proposal.weightLbs) : '',
      internalNotes: requestNoteFrom(proposal),
    },
    stops: [
      { ...pickup, ...place(proposal.origin, proposal.pickupDate) },
      { ...delivery, ...place(proposal.destination, proposal.deliveryDate) },
    ],
    // Nothing was matched to a directory row, so the name the agent read is all there is.
    // It rides along to SAVE_QUOTE so a REQUESTED quote still says who asked.
    customerName: matchedId ? null : ((proposal.customerName ?? run.partyName ?? '').trim() || null),
  }
}

export function QuoteDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const user = useAuthUser()
  const quoteId = id ?? null
  const { quote, loading, error, refresh } = useQuote(quoteId)
  const { customers } = useDirectory()
  // `/tms/rates/new?customerId=…` — the New quote button on a customer's profile hands
  // the customer over so the editor opens on them instead of making the operator find
  // them again. Only a blank quote takes it; a saved one has a customer of its own. The
  // pricing defaults and the default charge lines that follow from the choice are
  // applied by `SAVE_QUOTE`, so the selection is the whole of the prefill.
  const [search] = useSearchParams()
  const presetCustomerId = quoteId ? '' : (search.get('customerId') ?? '')
  // `/tms/rates/new?run=…` — the Create quote button on a QUOTE proposal. The agent never
  // writes the quote: this opens the same editor the desk opens, pre-typed with what it
  // read, and SAVE_QUOTE runs below from the browser under the operator's own identity.
  const seedRunId = quoteId ? '' : (search.get('run') ?? '')

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
  const [seed, setSeed] = useState<RunSeed | null>(null)
  const [seedNote, setSeedNote] = useState<string | null>(null)

  // Non-async on purpose (react-hooks/set-state-in-effect).
  useEffect(() => {
    let alive = true
    getTmsSettings()
      .then((s) => { if (alive) setSettings(s) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // Non-async on purpose, as above. The seed is applied once, into empty drafts: a run
  // that resolves after the operator has started typing must not overwrite them.
  useEffect(() => {
    if (!seedRunId) return
    let alive = true
    getWorkflowRun(seedRunId)
      .then((run) => {
        if (!alive) return
        const refusal = seedRefusal(seedRunId, run)
        if (refusal != null) { setSeedNote(refusal); return }
        // `seedRefusal` already proved both of these; the re-check is what narrows the type.
        if (run == null || run.proposal?.kind !== 'QUOTE') return
        const next = seedFromRun(run, run.proposal)
        setSeed(next)
        setFormDraft((prev) => prev ?? next.form)
        setStopsDraft((prev) => prev ?? next.stops)
      })
      .catch(() => {
        if (alive) setSeedNote(`Workflow run ${seedRunId} could not be read, so nothing was seeded.`)
      })
    return () => { alive = false }
  }, [seedRunId])

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
    if (first == null || last == null) return { laneKey: null, laneKey3: null }
    return laneLookupKeys({
      originCity: first.city, originState: first.state, originZip: first.zip,
      destCity: last.city, destState: last.state, destZip: last.zip,
    })
  }, [stops])

  const state = quote ? quoteState(quote, now) : null
  const editable = quote == null || (state?.canEdit ?? false)
  const locked = editable === false || busy

  const toStops = useCallback((): Stop[] => stops.map((draft, index) => ({
    id: draft.id || `stop-${index}`,
    type: draft.type,
    city: draft.state ? `${draft.city}, ${draft.state}` : draft.city,
    address: { city: draft.city, state: draft.state, zip: draft.zip },
    appt: draft.appt ? new Date(draft.appt).toISOString() : '',
    driverId: null,
    sequence: index,
  })), [stops])

  /**
   * Point the run at the quote a person just saved from it.
   *
   * The quote is the record and it is already written; the link is bookkeeping. A failed
   * LINK_RUN says so and stops there — nothing is rolled back and no second quote is
   * raised, exactly as the tender card handles the same case.
   */
  const linkSeededRun = async (seeded: RunSeed, savedQuoteId: string) => {
    try {
      await linkWorkflowRun(seeded.run.id, { quoteId: savedQuoteId }, seeded.run.version ?? 0)
      toast.success(`${seeded.run.id} linked to ${savedQuoteId}`)
    } catch (e: unknown) {
      toast.error(graphqlErrorText(e) || `${savedQuoteId} was saved, but the run could not be linked to it`)
    }
  }

  const save = () => {
    setBusy(true)
    const built = toStops()
    // A seeded run only applies to the quote being created here; an edit of a saved row
    // never re-links, because the row already carries the run it was raised from.
    const seeded = quote == null ? seed : null
    saveQuote({
      quoteId: quote?.id,
      expectedVersion: quote?.version,
      side: 'SELL',
      customerId: form.customerId || null,
      customerName: customer?.name ?? seeded?.customerName ?? null,
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
      // `intake` is what makes a request somebody e-mailed in land in REQUESTED rather
      // than DRAFT: nobody has priced it yet. `workflowRunId` is stamped on the row once,
      // by the server, so the quote itself says which run it was raised from.
      ...(seeded ? { intake: true, workflowRunId: seeded.run.id } : {}),
    })
      .then(async (result) => {
        toast.success(`${result.quote.id} saved — ${formatCents(result.pricing.revenueCents)}`)
        // The saved row is the truth now; the local draft has nothing left to say.
        forgetDraft()
        if (seeded) await linkSeededRun(seeded, result.quote.id)
        if (quote == null) navigate(`/tms/rates/${result.quote.id}`)
        else await refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not save the quote'))
      .finally(() => setBusy(false))
  }

  const runAcceptCounter = () => {
    if (quote == null) return
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
    if (quote == null) return
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
    if (quote == null) return
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

  const [marketResult, setMarketResult] = useState<MarketRateResult | null>(null)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketError, setMarketError] = useState<string | null>(null)

  const marketInputFromQuote = useCallback((q: QuoteRecord) => {
    const stops = q.stops ?? []
    const pickup = stops.find((s) => s.type === 'pickup') ?? stops[0]
    const delivery = stops.find((s) => s.type === 'delivery') ?? stops[stops.length - 1]
    if (!pickup || !delivery) return null
    const parseCityState = (stop: typeof pickup) => {
      const addr = stop.address
      if (addr?.city && addr?.state) return { city: addr.city, state: addr.state }
      const parts = (stop.city ?? '').split(',')
      return { city: parts[0]?.trim() ?? '', state: parts[1]?.trim() ?? '' }
    }
    const origin = parseCityState(pickup)
    const dest = parseCityState(delivery)
    if (!origin.city || !origin.state || !dest.city || !dest.state) return null
    return {
      quoteId: q.id,
      customerId: q.customerId,
      originCity: origin.city,
      originState: origin.state,
      destinationCity: dest.city,
      destinationState: dest.state,
      equipmentType: q.equipmentType ?? '',
      miles: q.miles,
      mode: q.mode,
    }
  }, [])

  const runPriceFromMarket = useCallback(async () => {
    if (!quote) return
    const input = marketInputFromQuote(quote)
    if (!input) {
      setMarketError('This quote has no lane to price.')
      return
    }
    setMarketLoading(true)
    setMarketError(null)
    try {
      const result = await priceFromMarket(input)
      setMarketResult(result)
    } catch (e: unknown) {
      setMarketError(graphqlErrorText(e))
    } finally {
      setMarketLoading(false)
    }
  }, [quote, marketInputFromQuote])

  const sendSuggested = async () => {
    if (!quote || !marketResult || marketResult.belowFloor) return
    const input = marketInputFromQuote(quote)
    if (!input) return
    setBusy(true)
    try {
      await priceFromMarket({ ...input, save: true, expectedUpdatedAt: quote.updatedAt })
      await refresh()
      setDialog({ kind: 'send' })
    } catch (e: unknown) {
      toast.error(graphqlErrorText(e) || 'Could not fill the suggested rate')
    } finally {
      setBusy(false)
    }
  }

  if (quoteId && quote == null) {
    return (
      <TmsPage title="Quote">
        {loading
          ? <span className="tms-muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Loader2 size={14} /> Loading quote…</span>
          : <span className="tms-field-error">{error ?? 'Quote not found.'}</span>}
      </TmsPage>
    )
  }

  const chip = quote ? expiryChip(quote, now) : null

  return (
    <TmsPage
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Link to="/tms/rates" aria-label="Back to quotes" className="tms-btn tms-btn-ghost tms-btn-sm">
            <ChevronLeft size={14} /> Rates
          </Link>
          {quote?.id ?? 'New quote'}
          {quote && <TmsBadge tone="blue">{statusLabel(quote)}</TmsBadge>}
          {chip && <TmsBadge tone={chip.tone === 'danger' ? 'red' : 'gray'}>{chip.text}</TmsBadge>}
        </span>
      }
      actions={
        <TmsIconButton
          aria-label="Refresh quote"
          onClick={() => { setNow(new Date().toISOString()); void refresh() }}
        >
          <RefreshCw size={14} />
        </TmsIconButton>
      }
    >
      {quote && (
        <div className="tms-muted" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12 }}>
          <span>{quote.customerName ?? 'No customer'}</span>
          {quote.customerRepId && <span>rep {quote.customerRepId}</span>}
          <span>whose move: {whoseMoveLabel(quote, now)}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <TmsButton variant="primary" aria-label="Save the quote" disabled={busy || editable === false} onClick={save}>Save</TmsButton>
        {(quote == null || state?.canSend) && (
          <TmsButton aria-label="Send the quote" disabled={busy || quote == null} onClick={() => setDialog({ kind: 'send' })}>
            Send…
          </TmsButton>
        )}
        {quote?.side === 'SELL' && (quote == null || state?.canSend) && (
          <TmsButton
            aria-label="Price this lane from the market"
            disabled={busy || marketLoading}
            onClick={runPriceFromMarket}
          >
            {marketLoading ? <Loader2 size={13} className="animate-spin" /> : null}
            Price from market
          </TmsButton>
        )}
        {state?.canCounter && (
          <TmsButton aria-label="Counter the quote" disabled={busy} onClick={() => setDialog({ kind: 'counter' })}>Counter…</TmsButton>
        )}
        {state?.canAccept && (
          <TmsButton aria-label="Accept their counter" disabled={busy} onClick={runAcceptCounter}>Accept counter</TmsButton>
        )}
        {state?.canConvert && (
          <TmsButton aria-label="Convert to shipment" disabled={busy} onClick={() => setDialog({ kind: 'convert' })}>
            Convert to shipment
          </TmsButton>
        )}
        {quote && (
          <TmsButton aria-label="Duplicate the quote" disabled={busy} onClick={() => setDialog({ kind: 'duplicate' })}>Duplicate…</TmsButton>
        )}
        {state?.canMarkLost && (
          <TmsButton variant="ghost" aria-label="Mark the quote lost" disabled={busy} onClick={() => setDialog({ kind: 'markLost' })}>
            Mark lost
          </TmsButton>
        )}
        {state?.canRestore && (
          <TmsButton variant="ghost" aria-label="Restore the quote" disabled={busy} onClick={runRestore}>Restore</TmsButton>
        )}
        {state?.canCancel && (
          <TmsButton variant="ghost" aria-label="Cancel the quote" disabled={busy} onClick={runCancel}>Cancel</TmsButton>
        )}
        {quote?.linkToken && (
          <TmsButton variant="ghost" aria-label="Copy the public link" disabled={busy} onClick={copyLink}>
            <Copy size={13} /> Copy link
          </TmsButton>
        )}
      </div>

      {seedNote && <p className="tms-muted" style={{ fontSize: 12 }}>{seedNote}</p>}

      {marketResult && (
        <div className="tms-card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: 12 }}>
          <span className="tms-muted" style={{ fontSize: 12 }}>Market rate</span>
          <span style={{ fontWeight: 600 }}>{formatCents(marketResult.answer.averageCents)}</span>
          {marketResult.answer.stub && <TmsBadge tone="gray">STUB</TmsBadge>}
          <span className="tms-muted" style={{ fontSize: 12 }}>
            target {(marketResult.targetBps / 100).toFixed(2)}% / floor {(marketResult.floorBps / 100).toFixed(2)}%
          </span>
          <span style={{ fontWeight: 600 }}>suggested {formatCents(marketResult.suggestedSellCents)}</span>
          {!marketResult.belowFloor && (
            <TmsButton
              variant="primary"
              aria-label="Send the suggested rate"
              disabled={busy}
              onClick={sendSuggested}
            >
              Send suggested
            </TmsButton>
          )}
          {marketResult.belowFloor && (
            <span className="tms-field-error" style={{ fontSize: 12 }}>
              Below floor — send only after raising the rate above {formatCents(marketResult.floorSellCents)}
            </span>
          )}
        </div>
      )}

      {marketError && <p className="tms-field-error" style={{ fontSize: 12 }}>{marketError}</p>}

      {seed && (
        <TmsCard
          title="Seeded from an e-mail"
          actions={<Link to={`/tms/workflows/runs/${seed.run.id}`} className="tms-btn tms-btn-ghost tms-btn-sm">{seed.run.id}</Link>}
        >
          <p style={{ margin: 0 }}>
            The fields below were read by the AI agent out of{' '}
            {seed.run.subject ? <em>{seed.run.subject}</em> : 'a message'}
            {seed.run.fromEmail ? `, sent by ${seed.run.fromEmail}` : ''} — text somebody outside this
            company wrote, not anything BCAT entered. Read the e-mail before you price it.
          </p>
          {seed.customerName && (
            <p className="tms-muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
              The agent read the customer as {seed.customerName} but matched no directory row to that
              address, so the picker is yours to set.
            </p>
          )}
          <p className="tms-muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
            Save raises the quote in REQUESTED under your own login, then links {seed.run.id} to it.
          </p>
        </TmsCard>
      )}

      <div className="tms-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <TmsCard title="Freight">
            <div className="tms-grid tms-grid-3">
              <TmsField label="Customer" htmlFor="quote-customer">
                <TmsSelect
                  id="quote-customer"
                  value={form.customerId}
                  disabled={locked}
                  onChange={(e) => editForm((prev) => ({ ...prev, customerId: e.target.value }))}
                  placeholder="Pick a customer"
                  options={customers.map((row) => ({ value: row.id, label: row.name }))}
                />
              </TmsField>
              <Text label="Contact" value={form.contactName} disabled={locked}
                onChange={(v) => editForm((prev) => ({ ...prev, contactName: v }))} />
              <Text label="Contact e-mail" value={form.contactEmail} disabled={locked}
                onChange={(v) => editForm((prev) => ({ ...prev, contactEmail: v }))} />
              <TmsField label="Mode" htmlFor="quote-mode">
                <TmsSelect
                  id="quote-mode"
                  value={form.mode}
                  disabled={locked}
                  onChange={(e) => editForm((prev) => ({ ...prev, mode: e.target.value as ShipmentMode }))}
                  options={MODE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                />
              </TmsField>
              <TmsField label="Rate type" htmlFor="quote-rate-type">
                <TmsSelect
                  id="quote-rate-type"
                  value={form.rateType}
                  disabled={locked}
                  onChange={(e) => editForm((prev) => ({ ...prev, rateType: e.target.value as RateType }))}
                  options={[{ value: 'SPOT', label: 'Spot' }, { value: 'CONTRACT', label: 'Contract' }]}
                />
              </TmsField>
              <Text label="Equipment" value={form.equipmentType} disabled={locked}
                onChange={(v) => editForm((prev) => ({ ...prev, equipmentType: v }))} />
              <Text label="Length (ft)" value={form.equipmentLengthFt} disabled={locked}
                onChange={(v) => editForm((prev) => ({ ...prev, equipmentLengthFt: v }))} />
              <Text label="Commodity" value={form.commodity} disabled={locked}
                onChange={(v) => editForm((prev) => ({ ...prev, commodity: v }))} />
              <Text label="Weight (lbs)" value={form.weightLbs} disabled={locked}
                onChange={(v) => editForm((prev) => ({ ...prev, weightLbs: v }))} />
              <Text label="Miles" value={form.miles} disabled={locked}
                onChange={(v) => editForm((prev) => ({ ...prev, miles: v }))} />
            </div>
          </TmsCard>

          <TmsCard
            title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                Stops
                <span className="tms-muted" style={{ fontSize: 12, fontWeight: 400 }}>{laneKeys.laneKey ?? 'lane not keyed yet'}</span>
              </span>
            }
            actions={editable ? (
              <TmsButton
                size="sm"
                aria-label="Add a stop"
                disabled={busy}
                onClick={() => editStops((prev) => [
                  ...prev.slice(0, -1),
                  { id: `stop-${prev.length}`, type: 'delivery', city: '', state: '', zip: '', appt: '' },
                  prev[prev.length - 1],
                ])}
              >
                <Plus size={13} /> Stop
              </TmsButton>
            ) : null}
          >
            <div style={{ display: 'grid', gap: 8 }}>
              {stops.map((stop, index) => (
                <div key={stop.id} style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                  <TmsField label="Type">
                    <TmsSelect
                      aria-label={`Stop ${index + 1} type`}
                      value={stop.type}
                      disabled={locked}
                      onChange={(e) => editStops((prev) => prev.map((row, i) => (
                        i === index ? { ...row, type: e.target.value as StopType } : row
                      )))}
                      options={[{ value: 'pickup', label: 'Pickup' }, { value: 'delivery', label: 'Delivery' }]}
                    />
                  </TmsField>
                  <Text label={`Stop ${index + 1} city`} value={stop.city} disabled={locked}
                    onChange={(v) => editStops((prev) => prev.map((row, i) => (i === index ? { ...row, city: v } : row)))} />
                  <Text label={`Stop ${index + 1} state`} value={stop.state} disabled={locked}
                    onChange={(v) => editStops((prev) => prev.map((row, i) => (i === index ? { ...row, state: v } : row)))} />
                  <Text label={`Stop ${index + 1} ZIP`} value={stop.zip} disabled={locked}
                    onChange={(v) => editStops((prev) => prev.map((row, i) => (i === index ? { ...row, zip: v } : row)))} />
                  <TmsField label="Appointment">
                    <TmsInput
                      type="datetime-local"
                      aria-label={`Stop ${index + 1} appointment`}
                      value={stop.appt}
                      disabled={locked}
                      onChange={(e) => editStops((prev) => prev.map((row, i) => (
                        i === index ? { ...row, appt: e.target.value } : row
                      )))}
                    />
                  </TmsField>
                  {editable && stops.length > 2 && (
                    <TmsButton
                      variant="ghost"
                      aria-label={`Remove stop ${index + 1}`}
                      disabled={busy}
                      onClick={() => editStops((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <Trash2 size={13} />
                    </TmsButton>
                  )}
                </div>
              ))}
            </div>
          </TmsCard>

          <TmsCard
            title="Customer lines"
            actions={editable ? (
              <TmsButton
                size="sm"
                aria-label="Add a charge line"
                disabled={busy}
                onClick={() => editLines((prev) => [...prev, {
                  side: 'CUSTOMER', code: '', label: null, calculatedBy: 'FLAT', rateCents: 0,
                  count: 1, isRate: false, sortOrder: prev.length, note: null,
                }])}
              >
                <Plus size={13} /> Line
              </TmsButton>
            ) : null}
          >
            <div className="tms-table-wrap">
              <table className="tms-table">
                <thead>
                  <tr>
                    <th scope="col">CODE</th>
                    <th scope="col">HOW</th>
                    <th scope="col">RATE</th>
                    <th scope="col">COUNT</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={`${line.code}-${index}`}>
                      <td>
                        <TmsSelect
                          aria-label={`Line ${index + 1} code`}
                          value={line.code}
                          disabled={locked}
                          onChange={(e) => editLines((prev) => prev.map((row, i) => (
                            i === index ? { ...row, code: e.target.value } : row
                          )))}
                        >
                          <option value="">Pick a code</option>
                          {catalog.map((code) => <option key={code.code} value={code.code}>{code.label}</option>)}
                          {line.code && catalog.some((code) => code.code === line.code) === false && (
                            <option value={line.code}>{humanChargeCode(line.code)}</option>
                          )}
                        </TmsSelect>
                      </td>
                      <td>
                        <TmsSelect
                          aria-label={`Line ${index + 1} calculation`}
                          value={line.calculatedBy}
                          disabled={locked}
                          onChange={(e) => editLines((prev) => prev.map((row, i) => (
                            i === index ? { ...row, calculatedBy: e.target.value as ChargeCalc } : row
                          )))}
                          options={CALC_OPTIONS.map((calc) => ({ value: calc, label: calc }))}
                        />
                      </td>
                      <td>
                        <MoneyField
                          value={line.rateCents}
                          disabled={locked}
                          onChange={(cents) => editLines((prev) => prev.map((row, i) => (
                            i === index ? { ...row, rateCents: cents ?? 0 } : row
                          )))}
                        />
                      </td>
                      <td>
                        <TmsInput
                          type="number"
                          aria-label={`Line ${index + 1} count`}
                          style={{ width: 80, textAlign: 'right' }}
                          value={line.count ?? 1}
                          disabled={locked}
                          onChange={(e) => editLines((prev) => prev.map((row, i) => (
                            i === index ? { ...row, count: Number(e.target.value) || 0 } : row
                          )))}
                        />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {editable && lines.length > 1 && (
                          <TmsButton
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove line ${index + 1}`}
                            disabled={busy}
                            onClick={() => editLines((prev) => prev.filter((_, i) => i !== index))}
                          >
                            <Trash2 size={13} />
                          </TmsButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="tms-grid tms-grid-4" style={{ marginTop: 12 }}>
              <Money label="Revenue" cents={pricing.revenueCents} />
              <Money label="Cost" cents={pricing.costCents} />
              <Money label="Profit" cents={pricing.profitCents} />
              <div>
                <div className="tms-field-label">Margin</div>
                <div style={{ fontVariantNumeric: 'tabular-nums' }}>{(pricing.marginBps / 100).toFixed(1)}%</div>
              </div>
              <Money label="Top spend" cents={pricing.topSpendCents} />
              {pricing.targetBuyCents != null && <Money label="Target buy" cents={pricing.targetBuyCents} />}
              <MoneyField
                label="Target buy override"
                value={form.targetBuyCents}
                disabled={locked}
                onChange={(cents) => editForm((prev) => ({ ...prev, targetBuyCents: cents }))}
              />
            </div>

            {pricing.warnings.length > 0 && (
              <ul style={{ marginTop: 12, display: 'grid', gap: 4, borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-badge-orange)', background: 'rgba(255,136,10,0.12)', padding: '8px 8px 8px 24px', fontSize: 12 }}>
                {pricing.warnings.map((warning) => (
                  <li key={warning.key}>
                    {warning.message}
                    {warning.adminOnly && <TmsBadge tone="gray">owner / admin</TmsBadge>}
                  </li>
                ))}
              </ul>
            )}
          </TmsCard>

          <TmsCard title="Notes">
            <div className="tms-grid tms-grid-2">
              <TmsField label="What the customer reads" htmlFor="quote-message">
                <TmsTextarea
                  id="quote-message"
                  rows={3}
                  value={form.customerMessage}
                  disabled={busy}
                  onChange={(e) => editForm((prev) => ({ ...prev, customerMessage: e.target.value }))}
                />
              </TmsField>
              <TmsField label="Internal — never leaves the building" htmlFor="quote-internal">
                <TmsTextarea
                  id="quote-internal"
                  rows={3}
                  value={form.internalNotes}
                  disabled={busy}
                  onChange={(e) => editForm((prev) => ({ ...prev, internalNotes: e.target.value }))}
                />
              </TmsField>
            </div>
          </TmsCard>
        </div>

        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
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
            if (shipmentId) navigate(`/tms/shipments/${shipmentId}`)
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
    </TmsPage>
  )
}

function Text({ label, value, disabled, onChange }: {
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <TmsField label={label}>
      <TmsInput value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </TmsField>
  )
}

function Money({ label, cents }: { label: string; cents: number }) {
  return (
    <div>
      <div className="tms-field-label">{label}</div>
      <div style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCents(cents)}</div>
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
    <TmsCard
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Thread
          <TmsBadge tone="gray">round {quote.rounds}</TmsBadge>
          {marginBadge && <TmsBadge tone="gray">{marginBadge.text}</TmsBadge>}
        </span>
      }
    >
      <dl className="tms-grid tms-grid-2" style={{ marginBottom: 12, fontSize: 12 }}>
        <div>
          <dt className="tms-field-label">Sent</dt>
          <dd style={{ margin: 0 }}>
            {quote.sentAt ? formatDateTime(quote.sentAt) : 'never'}
            {quote.sendCount ? ` · ${quote.sendCount} send${quote.sendCount === 1 ? '' : 's'}` : ''}
            {quote.lastSendStatus === 'NOT_SENT' && <TmsBadge tone="red">Not sent</TmsBadge>}
          </dd>
        </div>
        <div>
          <dt className="tms-field-label">To</dt>
          <dd style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{quote.sentTo ?? quote.contactEmail ?? '—'}</dd>
        </div>
        <div>
          <dt className="tms-field-label">Answered</dt>
          <dd style={{ margin: 0 }}>{quote.respondedAt ? `${quote.response ?? ''} ${formatDateTime(quote.respondedAt)}` : 'not yet'}</dd>
        </div>
        <div>
          <dt className="tms-field-label">By</dt>
          <dd style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{quote.responderName ?? quote.responderEmail ?? '—'}</dd>
        </div>
      </dl>

      <ol style={{ display: 'grid', gap: 8, fontSize: 12, listStyle: 'none', padding: 0, margin: 0 }}>
        {events.length === 0 && <li className="tms-muted">Nothing has happened to this quote yet.</li>}
        {events.map((event, index) => (
          <li key={`${event.at}-${index}`} style={{ borderLeft: '2px solid var(--tms-border)', paddingLeft: 8 }}>
            <div style={{ fontWeight: 600 }}>
              {event.kind.replace(/_/g, ' ').toLowerCase()}
              {event.amountCents != null && <span style={{ marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>{formatCents(event.amountCents)}</span>}
            </div>
            <div className="tms-muted">{formatDateTime(event.at)} · {event.by}</div>
            {event.note && <div style={{ marginTop: 2 }}>{event.note}</div>}
          </li>
        ))}
      </ol>
    </TmsCard>
  )
}
