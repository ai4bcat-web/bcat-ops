/**
 * The internal "OTR offset" marker: OTR Solutions offset our payment and told us the customer paid us directly (Ryne 2026-11-27).
 * Shown only on staff screens (AR, Payments Received, the invoice and shipment cards, the aging list). It is never drawn on an
 * invoice PDF, an invoice or reminder e-mail, a customer statement or anything else a customer sees.
 */
import { TmsBadge } from '@/features/tms/kit'
import type { OtrOffsetFlag } from '@/types/tms'

const OTR_OFFSET_LABEL = 'OTR offset'

/** The tooltip: what OTR said, who recorded it and when. */
function otrOffsetTitle(flag: OtrOffsetFlag): string {
  const day = flag.flaggedAt ? flag.flaggedAt.slice(0, 10) : ''
  const who = [flag.flaggedBy, day].filter(Boolean).join(' · ')
  return `OTR Solutions offset our payment and said the customer paid us directly. ${flag.note}${who ? ` (${who})` : ''}`
}

export function OtrOffsetChip({ flag }: { flag: OtrOffsetFlag | null | undefined }) {
  if (!flag) return null
  return <TmsBadge tone="orange" data-testid="otr-offset-chip" title={otrOffsetTitle(flag)}>{OTR_OFFSET_LABEL}</TmsBadge>
}
