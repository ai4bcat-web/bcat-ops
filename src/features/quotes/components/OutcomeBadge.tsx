/**
 * A customer quote's outcome — Won / Lost / Expired / Pending — as one badge, read off the same rule
 * (`quoteOutcome`) the lane history uses so the list, the detail header, the Spot inbox and Carrier
 * Sales cannot disagree. Renders a dash for what was never put to a customer (draft, canceled, offers).
 */
import { TmsBadge } from '@/features/tms/kit'
import { OUTCOME_LABEL, OUTCOME_TONE, outcomeOf } from '../quoteViews'
import type { QuoteRecord } from '@/types/tms'

export function OutcomeBadge({ quote, now }: {
  quote: Pick<QuoteRecord, 'side' | 'status' | 'shipmentId' | 'lostReason' | 'expiresAt'>
  now: string
}) {
  const outcome = outcomeOf(quote, now)
  if (!outcome) return <span className="tms-muted">—</span>
  return <TmsBadge tone={OUTCOME_TONE[outcome]} data-testid="quote-outcome">{OUTCOME_LABEL[outcome]}</TmsBadge>
}
