/**
 * Step K — a tender proposal, and the seed the New shipment dialog opens with.
 *
 * `parseTender` reads the formats we know; the model only fills what the parser left
 * blank. That order is deliberate: the parser is deterministic and auditable, so where
 * it has an answer the model never gets to overwrite it, and a reviewer comparing the
 * trace to the e-mail is always looking at parsed text first.
 *
 * Nothing here creates anything. The seed is what a person sees pre-typed into the
 * dialog; they are still the one who presses create.
 */
import type { TenderPrefill, TenderStopPrefill } from '../intakeTender'
import type { WorkflowRunRecord } from '../../types/tms'

export interface TenderModelStop {
  type?: 'pickup' | 'delivery' | null
  name?: string | null
  street?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  /** `YYYY-MM-DD`. */
  dateStr?: string | null
  /** `HH:mm`, only for a booked appointment. */
  time?: string | null
  instructions?: string | null
}

export interface TenderModelFill {
  customer?: string | null
  reference?: string | null
  pickupNumber?: string | null
  weightLb?: number | null
  stops?: TenderModelStop[] | null
}

/** What the New shipment dialog opens with. No `pro`: a PRO is issued, never proposed. */
export interface NewShipmentPrefillSeed {
  customerId?: string
  customerName?: string
  tender: TenderPrefill
  /**
   * Always `TENDER` here: a tender a person applies is raised in TENDER_PENDING for
   * Accept/Reject, never as a MANUAL draft. The dialog still does the creating.
   */
  source: 'TENDER'
  /** The run this was read from, so the shipment carries the back-reference. */
  workflowRunId: string
}

function text(value: string | null | undefined): string {
  return (value ?? '').trim()
}

/** The parsed value when there is one, the model's only when the parser came up blank. */
function orFill(parsed: string | undefined, fill: string | null | undefined): string | undefined {
  const kept = text(parsed)
  if (kept) return kept
  const filled = text(fill)
  return filled || undefined
}

function mergeStop(parsed: TenderStopPrefill, fill: TenderModelStop): TenderStopPrefill {
  return {
    type: parsed.type,
    name: orFill(parsed.name, fill.name),
    street: orFill(parsed.street, fill.street),
    city: orFill(parsed.city, fill.city),
    state: orFill(parsed.state, fill.state),
    zip: orFill(parsed.zip, fill.zip),
    dateStr: orFill(parsed.dateStr, fill.dateStr),
    time: orFill(parsed.time, fill.time),
    instructions: orFill(parsed.instructions, fill.instructions),
  }
}

function stopFromFill(fill: TenderModelStop, index: number): TenderStopPrefill {
  return {
    // The first stop of a tender is the pickup unless the model says otherwise.
    type: fill.type === 'pickup' || fill.type === 'delivery' ? fill.type : index === 0 ? 'pickup' : 'delivery',
    name: text(fill.name) || undefined,
    street: text(fill.street) || undefined,
    city: text(fill.city) || undefined,
    state: text(fill.state) || undefined,
    zip: text(fill.zip) || undefined,
    dateStr: text(fill.dateStr) || undefined,
    time: text(fill.time) || undefined,
    instructions: text(fill.instructions) || undefined,
  }
}

export function tenderFromParse(prefill: TenderPrefill, fill: TenderModelFill | null): TenderPrefill {
  if (!fill) return prefill

  const fillStops = fill.stops ?? []
  const stops = prefill.stops.map((stop, i) => (fillStops[i] ? mergeStop(stop, fillStops[i]) : stop))
  for (let i = prefill.stops.length; i < fillStops.length; i += 1) {
    stops.push(stopFromFill(fillStops[i], i))
  }

  return {
    ...prefill,
    // `format` and `customerId` stay the parser's: the model cannot recognise a format
    // and must never link a directory record.
    customer: orFill(prefill.customer, fill.customer),
    reference: orFill(prefill.reference, fill.reference),
    pickupNumber: orFill(prefill.pickupNumber, fill.pickupNumber),
    weightLb:
      typeof prefill.weightLb === 'number'
        ? prefill.weightLb
        : typeof fill.weightLb === 'number' && Number.isFinite(fill.weightLb)
          ? fill.weightLb
          : undefined,
    stops,
  }
}

export function proposalToPrefill(run: WorkflowRunRecord): NewShipmentPrefillSeed {
  const proposal = run.proposal && run.proposal.kind === 'TENDER' ? run.proposal : null
  const tender: TenderPrefill = proposal ? { ...proposal.tender } : { format: null, stops: [] }

  // A run links a customer only on an exact address match. A shared domain or a name
  // that merely normalises the same must never put freight on somebody's account.
  const linked =
    run.partyKind === 'CUSTOMER' && run.partyMatchHow === 'EMAIL' ? text(run.partyId) : ''
  if (linked) tender.customerId = linked
  else delete tender.customerId

  // `source`/`workflowRunId` go on every seed: the dialog is the only writer of either,
  // and it runs under the operator's identity. Neither depends on the party match.
  const seed: NewShipmentPrefillSeed = { tender, source: 'TENDER', workflowRunId: run.id }
  if (linked) seed.customerId = linked

  const name = text(run.partyName) || text(proposal?.customerName) || text(tender.customer)
  if (name) seed.customerName = name
  return seed
}
