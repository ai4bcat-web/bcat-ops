/**
 * Step K — reading a rate request into a quote proposal.
 *
 * The proposal carries only what the customer actually wrote. It never prices the
 * lane: a number the agent invented would look exactly like a number a pricing analyst
 * chose, and the person who opens New quote has to be able to tell the difference.
 * `memoryHint` records which instruction shaped the read, so a reviewer can see why.
 */
import { centsFromDollars } from './apProposal'
import type { QuoteProposal, QuoteProposalPlace, WorkflowConfidence } from '../../types/tms'

/** The model's `json_schema` answer for a quote e-mail. */
export interface QuoteEmailParse {
  customer?: string | null
  originCity?: string | null
  originState?: string | null
  originZip?: string | null
  destinationCity?: string | null
  destinationState?: string | null
  destinationZip?: string | null
  pickupDate?: string | null
  deliveryDate?: string | null
  equipment?: string | null
  commodity?: string | null
  weightLb?: number | null
  /** Only when the customer named a number themselves. */
  targetRateDollars?: unknown
  notes?: string | null
  confidence?: WorkflowConfidence | null
}

function text(value: string | null | undefined): string | null {
  return (value ?? '').trim() || null
}

/** A place is worth carrying only when it says something. */
function place(city: string | null | undefined, state: string | null | undefined, zip: string | null | undefined): QuoteProposalPlace | null {
  const out: QuoteProposalPlace = { city: text(city), state: text(state), zip: text(zip) }
  return out.city || out.state || out.zip ? out : null
}

export function quoteFromEmail(parsed: QuoteEmailParse, memoryHint?: string | null): QuoteProposal {
  const weight =
    typeof parsed.weightLb === 'number' && Number.isFinite(parsed.weightLb) && parsed.weightLb > 0
      ? Math.round(parsed.weightLb)
      : null
  return {
    kind: 'QUOTE',
    customerName: text(parsed.customer),
    origin: place(parsed.originCity, parsed.originState, parsed.originZip),
    destination: place(parsed.destinationCity, parsed.destinationState, parsed.destinationZip),
    pickupDate: text(parsed.pickupDate),
    deliveryDate: text(parsed.deliveryDate),
    // Left as the customer typed it: `53 van` carries a length that a normalised
    // vocabulary would throw away, and the quote form takes free text anyway.
    equipmentType: text(parsed.equipment),
    commodity: text(parsed.commodity),
    weightLbs: weight,
    targetRateCents: centsFromDollars(parsed.targetRateDollars),
    notes: text(parsed.notes),
    memoryHint: text(memoryHint),
    confidence: parsed.confidence ?? null,
  }
}
