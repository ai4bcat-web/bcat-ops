/**
 * Step AR card 6 body: Rate history. The lane is the Route card's first pickup and last delivery.
 * Two side-by-side blocks: what we ran it for (Step AE `LANE_INTELLIGENCE`: one indexed server read,
 * last 24 months, never a table scan) and the DAT RateView market (`PRICE_FROM_MARKET`, the same call
 * the Rate-intelligence panel makes). Both are read once per lane + equipment (+ customer, who sets
 * the margin the market is priced at), cached 60 s, and re-read 400 ms after the stops or equipment
 * stop changing. A stub DAT answer shows no numbers: only the "DAT not connected" badge.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import { getLaneIntelligence, graphqlErrorText, priceFromMarket } from '@/lib/apiClient'
import type { MarketRateResult } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { laneInputOfStops, laneInputKey } from '@/lib/laneIntel'
import type { LaneInput, LaneIntelligence, LaneRunStats } from '@/lib/laneIntel'
import { centsToDollars, dollarsToCents, isLocked } from '../model'
import type { CardProps } from './cardRegistry'
import { cachedRead as cached, clearRateHistoryCache } from './rateHistoryCache'
import { laneClassOfDivision } from './laneClass'
import './rateHistoryCard.css'

const DEBOUNCE_MS = 400
const LAST_ROWS = 5
/** Fewest matching loads an average is trusted to suggest a rate from (the Spot suggestion's own floor). */
const MIN_HISTORY_LOADS = 3
const LANE_HISTORY_PATH = '/tms/rates'
const DAT_SETTINGS_PATH = '/tms/brokerage/integrations/dat'

const money = (cents: number | null | undefined): string => (cents == null ? '—' : formatCents(cents))
const percent = (bps: number | null): string => (bps == null ? '—' : `${(bps / 100).toFixed(1)}%`)

// ── the lane ────────────────────────────────────────────────────────────────

const hasState = (s: string | null | undefined): boolean => /^[A-Za-z]{2}$/.test((s ?? '').trim())
const placed = (city: string | null | undefined, state: string | null | undefined, zip: string | null | undefined): boolean =>
  Boolean((city ?? '').trim() && hasState(state)) || Boolean((zip ?? '').trim())

interface Input {
  key: string
  lane: LaneInput | null
  equipmentType: string
  customerId: string
  /** Brokerage loads are compared with brokerage runs and Ivan loads with Ivan runs (null: division not picked or neither). */
  laneClass: 'BROKERAGE' | 'IVAN' | null
  /** City + state on both ends and an equipment: what DAT needs. */
  marketReady: boolean
}

function RateHistoryCardImpl({ values, update, locked }: CardProps) {
  const { stops } = values
  const equipmentType = values.ship.equipmentType.trim()
  const customerId = values.customer.id
  const laneClass = laneClassOfDivision(values.ship.revDivision)

  const live = useMemo<Input>(() => {
    const raw = laneInputOfStops(stops)
    const ready = !!raw
      && placed(raw.originCity, raw.originState, raw.originZip)
      && placed(raw.destinationCity, raw.destinationState, raw.destinationZip)
    const lane = ready ? raw : null
    const marketReady = !!lane && !!equipmentType
      && !!lane.originCity?.trim() && hasState(lane.originState)
      && !!lane.destinationCity?.trim() && hasState(lane.destinationState)
    return { key: lane ? `${laneInputKey(lane)}#${equipmentType.toUpperCase()}#${customerId}#${laneClass ?? ''}` : '', lane, equipmentType, customerId, laneClass, marketReady }
  }, [stops, equipmentType, customerId, laneClass])

  // First paint reads at once; every later change waits for 400 ms of quiet.
  const [input, setInput] = useState<Input>(live)
  useEffect(() => {
    if (live.key === input.key) return undefined
    const timer = setTimeout(() => setInput(live), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [live, input.key])

  const [intelRead, setIntelRead] = useState<{ key: string; intel: LaneIntelligence | null; error: string | null } | null>(null)
  const [datRead, setDatRead] = useState<{ key: string; market: MarketRateResult | null; error: string | null; at: string } | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!input.key || !input.lane) return undefined
    const { lane, key } = input
    let alive = true
    cached(`intel#${key}`, () => getLaneIntelligence({ ...lane, equipmentType: input.equipmentType || null, laneClass: input.laneClass }))
      .then((intel) => { if (alive) setIntelRead({ key, intel, error: null }) })
      .catch((err: unknown) => { if (alive) setIntelRead({ key, intel: null, error: graphqlErrorText(err) }) })
    return () => { alive = false }
  }, [input])

  useEffect(() => {
    if (!input.key || !input.lane || !input.marketReady) return undefined
    const { lane, key } = input
    let alive = true
    cached(`dat#${key}`, () => priceFromMarket({
      customerId: input.customerId || null,
      originCity: lane.originCity as string,
      originState: lane.originState as string,
      destinationCity: lane.destinationCity as string,
      destinationState: lane.destinationState as string,
      equipmentType: input.equipmentType,
      mode: 'FTL',
    }).then((market) => ({ market, at: new Date(Date.now()).toISOString() })))
      .then(({ market, at }) => { if (alive) setDatRead({ key, market, error: null, at }) })
      .catch((err: unknown) => { if (alive) setDatRead({ key, market: null, error: graphqlErrorText(err) || 'DAT unavailable', at: '' }) })
    return () => { alive = false }
    // `retry` re-runs the read after the failed entry was dropped from the cache.
  }, [input, retry])

  const intel = intelRead && intelRead.key === input.key ? intelRead : null
  const dat = datRead && datRead.key === input.key ? datRead : null
  const stale = live.key !== input.key

  if (!input.lane) {
    return (
      <div className="tms-card-rh" data-testid="card-rateHistory-root">
        <p className="tms-card-rh-empty" data-testid="card-rateHistory-nolane">Add pickup and delivery to see lane history</p>
      </div>
    )
  }

  const suggestion = suggest(dat?.market ?? null, intel?.intel ?? null)

  return (
    <div className="tms-card-rh" data-testid="card-rateHistory-root" data-stale={stale ? 'true' : undefined}>
      <div className="tms-card-rh-blocks">
        <section className="tms-card-rh-block" data-testid="card-rateHistory-ran" aria-label="What we ran it for">
          <h4 className="tms-card-rh-label">What we ran it for</h4>
          <RanBlock read={intel} />
          <Link className="ship-link" to={LANE_HISTORY_PATH} data-testid="card-rateHistory-all">All lane history</Link>
        </section>
        <section className="tms-card-rh-block" data-testid="card-rateHistory-dat" aria-label="DAT RateView">
          <h4 className="tms-card-rh-label">DAT RateView</h4>
          <DatBlock
            read={dat}
            ready={input.marketReady}
            missingEquipment={!input.equipmentType}
            onRetry={() => { clearRateHistoryCache(`dat#${input.key}`); setDatRead(null); setRetry((n) => n + 1) }}
          />
        </section>
      </div>
      {suggestion && (
        <SuggestedLine
          suggestion={suggestion}
          currentLh={values.rates.carrier.lhRate}
          disabled={isLocked(locked, 'rates') || isLocked(locked, 'carrierRates')}
          onUse={(cents) => update((p) => ({
            ...p,
            rates: { ...p.rates, carrier: { ...p.rates.carrier, rateType: 'FLAT', lhRate: centsToDollars(cents) } },
          }))}
        />
      )}
    </div>
  )
}

// ── what we ran it for ──────────────────────────────────────────────────────

function RanBlock({ read }: { read: { intel: LaneIntelligence | null; error: string | null } | null }) {
  if (!read) return <p className="tms-card-rh-muted" data-testid="card-rateHistory-ran-loading">Reading the lane history…</p>
  if (read.error || !read.intel) {
    return <p className="tms-card-rh-error" role="alert" data-testid="card-rateHistory-ran-error">Lane history failed to load: {read.error}</p>
  }
  const { intel } = read
  const { stats, rows, windows } = intel.runs
  if (stats.count === 0) {
    return <p className="tms-card-rh-muted" data-testid="card-rateHistory-ran-empty">No shipments on this lane in the last {intel.months} months</p>
  }
  const last = rows.slice(0, LAST_ROWS)
  return (
    <>
      <div className="tms-card-rh-scroll">
        <table className="tms-card-rh-table" data-testid="card-rateHistory-ran-table">
          <thead>
            <tr><th>PRO</th><th>Date</th><th>Customer</th><th>Equip.</th><th>Customer rate</th><th>Carrier rate</th><th>Margin</th></tr>
          </thead>
          <tbody>
            {last.map((r) => (
              <tr key={r.id} data-testid="card-rateHistory-ran-row">
                <td>{r.shipmentNumber ?? '—'}</td>
                <td>{r.date}</td>
                <td className="tms-card-rh-clip">{r.customerName ?? '—'}</td>
                <td>{r.equipmentType ?? '—'}</td>
                <td className="tms-card-rh-num">{money(r.customerRateCents)}</td>
                <td className="tms-card-rh-num">{money(r.carrierCostCents)}</td>
                <td className="tms-card-rh-num">{money(r.marginCents)}{r.marginBps != null ? ` · ${percent(r.marginBps)}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <table className="tms-card-rh-table" data-testid="card-rateHistory-averages">
        <thead>
          <tr><th>Average</th><th>Loads</th><th>Customer rate</th><th>Carrier cost</th><th>Margin</th></tr>
        </thead>
        <tbody>
          <AverageRow label="30 days" id="d30" stats={windows.d30} />
          <AverageRow label="90 days" id="d90" stats={windows.d90} />
          <AverageRow label="Last year" id="d365" stats={windows.d365} />
        </tbody>
      </table>
    </>
  )
}

function AverageRow({ label, id, stats }: { label: string; id: string; stats: LaneRunStats }) {
  return (
    <tr data-testid={`card-rateHistory-avg-${id}`}>
      <td>{label}</td>
      <td>{stats.count}</td>
      <td className="tms-card-rh-num">{money(stats.customer.avgCents)}</td>
      <td className="tms-card-rh-num">{money(stats.carrier.avgCents)}</td>
      <td className="tms-card-rh-num">{percent(stats.marginAvgBps)}</td>
    </tr>
  )
}

// ── DAT RateView ────────────────────────────────────────────────────────────

function DatBlock({ read, ready, missingEquipment, onRetry }: {
  read: { market: MarketRateResult | null; error: string | null; at: string } | null
  ready: boolean
  missingEquipment: boolean
  onRetry: () => void
}) {
  if (!ready) {
    return (
      <p className="tms-card-rh-muted" data-testid="card-rateHistory-dat-needs">
        {missingEquipment ? 'Choose an equipment type to see DAT rates.' : 'DAT needs a city and state on both ends.'}
      </p>
    )
  }
  if (!read) return <p className="tms-card-rh-muted" data-testid="card-rateHistory-dat-loading">Looking up DAT…</p>
  if (read.error || !read.market) {
    return (
      <div className="tms-card-rh-row" data-testid="card-rateHistory-dat-error">
        <TmsBadge tone="red">DAT unavailable</TmsBadge>
        <TmsButton size="sm" onClick={onRetry} data-testid="card-rateHistory-dat-retry">Retry</TmsButton>
      </div>
    )
  }
  const { answer } = read.market
  if (answer.stub) {
    return (
      <div className="tms-card-rh-row" data-testid="card-rateHistory-dat-stub">
        <TmsBadge tone="gray" title={answer.message}>{answer.message?.startsWith('DAT is connected') ? 'DAT: no live rate' : 'DAT not connected'}</TmsBadge>
        <Link className="ship-link" to={DAT_SETTINGS_PATH} data-testid="card-rateHistory-dat-settings">Settings &gt; Integrations</Link>
        {answer.message?.startsWith('DAT is connected') && <p className="tms-card-rh-muted" data-testid="card-rateHistory-dat-reason">{answer.message.split('. ')[0]}.</p>}
      </div>
    )
  }
  return (
    <>
      <table className="tms-card-rh-table" data-testid="card-rateHistory-dat-table">
        <thead>
          <tr><th>Rate</th><th>Low</th><th>Average</th><th>High</th></tr>
        </thead>
        <tbody>
          <tr data-testid="card-rateHistory-dat-spot">
            <td>Spot</td>
            <td className="tms-card-rh-num">{money(answer.lowCents)}</td>
            <td className="tms-card-rh-num">{money(answer.averageCents)}</td>
            <td className="tms-card-rh-num">{money(answer.highCents)}</td>
          </tr>
          <tr data-testid="card-rateHistory-dat-contract">
            <td>Contract</td>
            <td className="tms-card-rh-num">—</td>
            <td className="tms-card-rh-num">—</td>
            <td className="tms-card-rh-num">—</td>
          </tr>
        </tbody>
      </table>
      <p className="tms-card-rh-muted" data-testid="card-rateHistory-dat-refreshed">
        Refreshed {read.at.slice(0, 10)} · {answer.days}-day average · {answer.reports} reports · contract rates are not part of the DAT lookup yet
      </p>
    </>
  )
}

// ── suggested rate ──────────────────────────────────────────────────────────

type Basis = 'LIVE' | 'STUB' | 'HISTORY'

interface Suggestion {
  basis: Basis
  sellCents: number
  /** The buy-side figure the same basis supports; null when it is only a simulation or has no cost data. */
  carrierCents: number | null
}

const BASIS_LABEL: Record<Basis, string> = { LIVE: 'DAT live', STUB: 'STUB', HISTORY: 'Lane history' }

/** The Step AE order: a live DAT answer, else our own history (3+ loads), else the labelled stub. */
function suggest(market: MarketRateResult | null, intel: LaneIntelligence | null): Suggestion | null {
  if (market && !market.answer.stub) {
    return { basis: 'LIVE', sellCents: market.suggestedSellCents, carrierCents: market.answer.averageCents }
  }
  const windows = intel?.runs.windows
  const history = windows && [windows.d90, windows.d365].find((w) => w.customer.count >= MIN_HISTORY_LOADS && w.customer.avgCents != null)
  if (history && history.customer.avgCents != null) {
    return {
      basis: 'HISTORY',
      sellCents: history.customer.avgCents,
      carrierCents: history.carrier.count >= MIN_HISTORY_LOADS ? history.carrier.avgCents : null,
    }
  }
  if (market) return { basis: 'STUB', sellCents: market.suggestedSellCents, carrierCents: null }
  return null
}

function SuggestedLine({ suggestion, currentLh, disabled, onUse }: {
  suggestion: Suggestion
  currentLh: string
  disabled: boolean
  onUse: (cents: number) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const { carrierCents } = suggestion
  const typed = dollarsToCents(currentLh)
  const hasTyped = typed !== undefined && typed > 0
  const apply = () => { if (carrierCents != null) { onUse(carrierCents); setConfirming(false) } }

  return (
    <div className="tms-card-rh-suggest" data-testid="card-rateHistory-suggested">
      <span className="tms-card-rh-label">Suggested rate</span>
      <span data-testid="card-rateHistory-suggested-text">
        Customer {money(suggestion.sellCents)}
        {carrierCents != null ? ` · Carrier ${money(carrierCents)}` : ''}
      </span>
      <TmsBadge tone={suggestion.basis === 'LIVE' ? 'green' : 'gray'} data-testid="card-rateHistory-suggested-basis">
        {BASIS_LABEL[suggestion.basis]}
      </TmsBadge>
      {carrierCents != null && !confirming && (
        <TmsButton
          size="sm"
          disabled={disabled || typed === carrierCents}
          onClick={() => (hasTyped ? setConfirming(true) : apply())}
          data-testid="card-rateHistory-use"
        >
          Use as carrier rate
        </TmsButton>
      )}
      {carrierCents != null && confirming && (
        <span className="tms-card-rh-row" role="alert" data-testid="card-rateHistory-use-confirm">
          Replace {money(typed)} with {money(carrierCents)}?
          <TmsButton size="sm" variant="primary" onClick={apply} data-testid="card-rateHistory-use-yes">Replace</TmsButton>
          <TmsButton size="sm" onClick={() => setConfirming(false)} data-testid="card-rateHistory-use-no">Keep</TmsButton>
        </span>
      )}
    </div>
  )
}

export const RateHistoryCard = memo(RateHistoryCardImpl)
