/**
 * Rate intelligence for one lane, in the three sections a rep prices from:
 *
 *   1. Market  — DAT RateView for the lane + equipment. LIVE when the DAT login exists; otherwise the
 *                simulated number, labelled STUB in the same words as the Pricing card.
 *   2. What we ran this lane for    — our own loads on it (imported Aljex history + live), 24 months.
 *   3. What we quoted this lane for — prior customer quotes with their outcome and the win rate.
 *
 * Sections 2 and 3 are one server read (`LANE_INTELLIGENCE`, indexed and windowed); the browser never
 * scans a table. Section 1 is handed in when the page already asked DAT (the Spot inbox does, for its
 * Pricing card) so one request costs one market call; without it the panel asks, unsaved.
 *
 * Lives on the Spot inbox request and on the Quote detail page.
 */
import { useEffect, useState } from 'react'
import { TmsBadge, TmsCard } from '@/features/tms/kit'
import { getLaneIntelligence, graphqlErrorText, priceFromMarket } from '@/lib/apiClient'
import type { MarketRateResult } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { laneInputKey } from '@/lib/laneIntel'
import type { LaneInput, LaneIntelligence } from '@/lib/laneIntel'
import type { LaneMatchTier } from '@/lib/laneMatch'
import { OUTCOME_TONE } from '../quoteViews'

const money = (cents: number | null | undefined): string => (cents == null ? '—' : formatCents(cents))
const percent = (rate: number | null): string => (rate == null ? '—' : `${Math.round(rate * 100)} %`)
const bpsText = (bps: number | null): string => (bps == null ? '—' : `${(bps / 100).toFixed(1)} %`)
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`

const MATCH_LABEL: Record<LaneMatchTier, string> = { CITY: 'Exact lane', ZIP3: 'ZIP3 area', RADIUS: 'Nearby' }

interface Props {
  lane: LaneInput | null
  equipmentType: string | null
  customerId?: string | null
  pickupDate?: string | null
  /** The quote this panel sits on: it is not its own history. */
  excludeQuoteId?: string | null
  /**
   * The market answer when the page already has it. `undefined` = the panel asks DAT itself;
   * `null` = the page asked and has nothing (failed / not priceable).
   */
  market?: MarketRateResult | null
  marketLoading?: boolean
  marketError?: string | null
}

interface Loaded {
  key: string
  intel: LaneIntelligence | null
  market: MarketRateResult | null
  error: string | null
  marketError: string | null
}

const endsReady = (lane: LaneInput | null): lane is LaneInput =>
  !!lane
  && !!((lane.originCity && lane.originState) || lane.originZip)
  && !!((lane.destinationCity && lane.destinationState) || lane.destinationZip)

export function RateIntelligencePanel({
  lane, equipmentType, customerId, pickupDate, excludeQuoteId, market, marketLoading, marketError,
}: Props) {
  const ready = endsReady(lane)
  const marketReady = ready
    && !!equipmentType
    && !!lane.originCity && !!lane.originState && !!lane.destinationCity && !!lane.destinationState
  const ownMarket = market === undefined
  const key = ready
    ? [laneInputKey(lane), equipmentType ?? '', excludeQuoteId ?? '', ownMarket && marketReady ? `${customerId ?? ''}|${pickupDate ?? ''}` : 'nm'].join('#')
    : ''
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!key || !lane) return
    let live = true
    const intelP = getLaneIntelligence({ ...lane, equipmentType, excludeQuoteId })
      .then((intel) => ({ intel, error: null as string | null }))
      .catch((err: unknown) => ({ intel: null, error: graphqlErrorText(err) }))
    const marketP = ownMarket && marketReady
      ? priceFromMarket({
          customerId: customerId ?? null,
          originCity: lane.originCity as string,
          originState: lane.originState as string,
          destinationCity: lane.destinationCity as string,
          destinationState: lane.destinationState as string,
          equipmentType: equipmentType as string,
          pickupDate: pickupDate ?? null,
          mode: 'FTL',
        })
          .then((m) => ({ market: m as MarketRateResult | null, marketError: null as string | null }))
          .catch((err: unknown) => ({ market: null, marketError: graphqlErrorText(err) }))
      : Promise.resolve({ market: null, marketError: null as string | null })
    void Promise.all([intelP, marketP]).then(([i, m]) => {
      if (live) setLoaded({ key, intel: i.intel, error: i.error, market: m.market, marketError: m.marketError })
    })
    return () => { live = false }
    // The key string stands for every input read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const current = key && loaded?.key === key ? loaded : null
  const intel = current?.intel ?? null
  const answer = (ownMarket ? current?.market : market)?.answer ?? null
  const marketMsg = ownMarket ? current?.marketError ?? null : marketError ?? null
  const marketBusy = ownMarket ? marketReady && current == null : !!marketLoading

  return (
    <TmsCard title="Rate intelligence">
      <div data-testid="rate-intel" className="tms-stack">
        {!ready ? (
          <p className="tms-muted tms-flush" data-testid="rate-intel-nolane">
            Add a pickup and a delivery (city and state, or ZIP) to see what this lane has paid and been quoted.
          </p>
        ) : null}

        <section data-testid="rate-intel-dat" className="tms-stack">
          <h4 className="tms-field-label">Market · DAT RateView</h4>
          {answer ? (
            <p className="tms-flush">
              {answer.stub ? (
                <TmsBadge tone="gray" data-testid="rate-intel-stub">STUB</TmsBadge>
              ) : (
                <TmsBadge tone="green" data-testid="rate-intel-live">LIVE</TmsBadge>
              )}{' '}
              <span className="tms-spot-numbers">{money(answer.averageCents)} avg · {money(answer.lowCents)}–{money(answer.highCents)}</span>
              {answer.perMileCents ? <span className="tms-muted"> · ${(answer.perMileCents / 100).toFixed(2)}/mi</span> : null}
              {answer.stub ? <span className="tms-muted"> — simulated market price, no DAT call was made</span> : null}
            </p>
          ) : marketBusy ? (
            <p className="tms-muted tms-flush">Looking up the market…</p>
          ) : marketMsg ? (
            <p className="tms-field-error tms-flush">Market lookup failed: {marketMsg}</p>
          ) : (
            <p className="tms-muted tms-flush">
              {ready && !marketReady ? 'Needs an equipment type and a city and state on both ends.' : 'No market rate for this lane.'}
            </p>
          )}
        </section>

        {ready ? (
          <>
            <section data-testid="rate-intel-ran" className="tms-stack">
              <h4 className="tms-field-label">What we ran this lane for</h4>
              {current == null ? <p className="tms-muted tms-flush">Reading the lane history…</p> : null}
              {current?.error ? <p className="tms-field-error tms-flush">Lane history failed to load: {current.error}</p> : null}
              {intel ? <RanSection intel={intel} /> : null}
            </section>

            <section data-testid="rate-intel-quoted" className="tms-stack">
              <h4 className="tms-field-label">What we quoted this lane for</h4>
              {intel ? <QuotedSection intel={intel} /> : current == null ? <p className="tms-muted tms-flush">Reading prior quotes…</p> : null}
            </section>
          </>
        ) : null}
      </div>
    </TmsCard>
  )
}

function RanSection({ intel }: { intel: LaneIntelligence }) {
  const { stats, rows } = intel.runs
  if (stats.count === 0) {
    return <p className="tms-muted tms-flush" data-testid="rate-intel-ran-empty">No loads on this lane in the last {intel.months} months.</p>
  }
  return (
    <>
      <p className="tms-flush" data-testid="rate-intel-ran-summary">
        <strong>{plural(stats.count, 'load')}</strong>
        {' · '}customer avg {money(stats.customer.avgCents)} ({money(stats.customer.lowCents)}–{money(stats.customer.highCents)})
        {' · '}carrier avg {money(stats.carrier.avgCents)} ({money(stats.carrier.lowCents)}–{money(stats.carrier.highCents)})
        {' · '}margin {bpsText(stats.marginAvgBps)}
      </p>
      <div className="tms-table-wrap">
        <table className="tms-table" data-testid="rate-intel-ran-table">
          <thead>
            <tr><th>Date</th><th>Customer</th><th>Carrier cost</th><th>Customer rate</th><th>Margin</th><th>Match</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.date}</td>
                <td>{r.customerName ?? '—'}</td>
                <td className="tms-spot-numbers">{money(r.carrierCostCents)}</td>
                <td className="tms-spot-numbers">{money(r.customerRateCents)}</td>
                <td className="tms-spot-numbers">{money(r.marginCents)}{r.marginBps != null ? ` · ${bpsText(r.marginBps)}` : ''}</td>
                <td>{r.match === 'CITY' ? '' : <TmsBadge tone="gray">{MATCH_LABEL[r.match]}</TmsBadge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {stats.count > rows.length || intel.truncated ? (
        <p className="tms-muted tms-flush">
          Showing the newest {rows.length} of {stats.count}; the figures above cover all of them{intel.truncated ? ' that could be read' : ''}.
        </p>
      ) : null}
    </>
  )
}

function QuotedSection({ intel }: { intel: LaneIntelligence }) {
  const { stats, rows } = intel.quotes
  if (stats.count === 0) {
    return <p className="tms-muted tms-flush" data-testid="rate-intel-quoted-empty">No quotes on this lane in the last {intel.months} months.</p>
  }
  const decided = stats.won + stats.lost + stats.expired
  return (
    <>
      <p className="tms-flush" data-testid="rate-intel-quoted-summary">
        <strong>{plural(stats.count, 'quote')}</strong>
        {' · '}win rate <strong data-testid="rate-intel-winrate">{percent(stats.winRate)}</strong>
        {decided > 0 ? ` (${stats.won} of ${decided} decided)` : ''}
        {stats.pending > 0 ? ` · ${stats.pending} pending` : ''}
        {' · '}avg quoted {money(stats.avgQuotedCents)}
      </p>
      <div className="tms-table-wrap">
        <table className="tms-table" data-testid="rate-intel-quoted-table">
          <thead>
            <tr><th>Date</th><th>Customer</th><th>Quoted</th><th>Outcome</th><th>Match</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.date}</td>
                <td>{r.customerName ?? '—'}</td>
                <td className="tms-spot-numbers">{money(r.quotedCents)}</td>
                <td><TmsBadge tone={OUTCOME_TONE[r.outcome]}>{r.outcome}</TmsBadge></td>
                <td>{r.match === 'CITY' ? '' : <TmsBadge tone="gray">{MATCH_LABEL[r.match]}</TmsBadge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
