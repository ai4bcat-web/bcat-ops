/**
 * The pricing block of a request: the market (LIVE or an unmistakable STUB), what the lane
 * has paid, the margin that applies, the suggested rate with the basis it came from, and the
 * rep's own rate. The rules that cannot be edited away live in `rateBlock`: a rate under the
 * floor needs a manager, and a simulated market price needs the rep to say they are pricing
 * it themselves.
 */
import { TmsBadge, TmsField, TmsInput } from '@/features/tms/kit'
import type { SpotPricing } from './useSpotPricing'
import { money } from './spotHelpers'
import type { RateBlock } from './spotRules'

const bps = (n: number): string => `${(n / 100).toFixed(n % 100 === 0 ? 0 : 1)} %`

export function PricingCard({
  pricing,
  rateText,
  onRateText,
  stubAck,
  onStubAck,
  block,
  disabled,
}: {
  pricing: SpotPricing
  rateText: string
  onRateText: (text: string) => void
  stubAck: boolean
  onStubAck: (ack: boolean) => void
  block: RateBlock
  disabled?: boolean
}) {
  const { market, suggestion } = pricing
  const answer = market?.answer ?? null
  return (
    <div data-testid="spot-pricing" className="tms-stack">
      {pricing.loading ? <p className="tms-muted tms-flush">Looking up the market…</p> : null}
      {pricing.error ? <p className="tms-field-error tms-flush">Market lookup failed: {pricing.error}</p> : null}

      {answer ? (
        <p className="tms-flush">
          <strong>Market · DAT RateView</strong>{' '}
          {answer.stub ? (
            <TmsBadge tone="gray" data-testid="spot-market-stub">STUB</TmsBadge>
          ) : (
            <TmsBadge tone="green" data-testid="spot-market-live">LIVE</TmsBadge>
          )}{' '}
          <span className="tms-spot-numbers">{money(answer.averageCents)} avg · {money(answer.lowCents)}–{money(answer.highCents)}</span>
          {answer.stub ? <span className="tms-muted"> — simulated market price, no DAT call was made</span> : null}
        </p>
      ) : null}

      {suggestion ? (
        <>
          <p className="tms-flush tms-muted" data-testid="spot-history">
            {suggestion.sampleCount > 0 ? `${suggestion.label}` : 'No loads on this lane yet'}
            {suggestion.perMileCents != null ? ` · ${money(suggestion.perMileCents)}/mi` : ''}
          </p>
          <p className="tms-flush tms-muted">
            Margin target {bps(suggestion.targetBps)} ({suggestion.targetSource}) · floor {bps(suggestion.floorBps)}
          </p>
          <p className="tms-flush">
            Suggested{' '}
            <span className="tms-spot-price-suggested" data-testid="spot-suggested">{money(suggestion.suggestedCents)}</span>{' '}
            <TmsBadge tone={suggestion.confidence === 'GOOD' ? 'green' : 'orange'} data-testid="spot-basis">{suggestion.label}</TmsBadge>
          </p>
          {suggestion.notes.map((n) => <p key={n} className="tms-muted tms-flush">{n}</p>)}
        </>
      ) : !pricing.loading ? (
        <p className="tms-flush tms-muted" data-testid="spot-no-suggestion">
          Manual — no suggestion. Not a full truckload with a complete lane and equipment.
        </p>
      ) : null}

      <TmsField label="Our rate ($)">
        <TmsInput
          data-testid="spot-rate-input"
          inputMode="decimal"
          value={rateText}
          disabled={disabled}
          onChange={(e) => onRateText(e.target.value)}
        />
      </TmsField>

      {block.belowFloor && suggestion ? (
        <p className="tms-field-error tms-flush" data-testid="spot-below-floor">
          Below the floor: the lowest rate that still earns the floor margin is {money(suggestion.floorSellCents)}.
          {block.reason ? '' : ' You may quote it as a manager.'}
        </p>
      ) : null}

      {block.needsStubAck ? (
        <label className="tms-check-row">
          <input
            type="checkbox"
            data-testid="spot-stub-ack"
            checked={stubAck}
            disabled={disabled}
            onChange={(e) => onStubAck(e.target.checked)}
          />
          <span>I am pricing this myself — the market number is a stub</span>
        </label>
      ) : null}
    </div>
  )
}
