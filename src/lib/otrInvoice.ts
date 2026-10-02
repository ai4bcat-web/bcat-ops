/**
 * OTR invoice assembly and readiness.
 *
 * Pure: no AWS, no fetch, no clock reads beyond what the caller passes in. The
 * factoring UI and the otr-actions Lambda both import this so a row can never
 * look "ready" in one place and fail validation in the other.
 *
 * OTR's create-invoice requires ELEVEN fields and treats every one as mandatory.
 * The job here is to fill all eleven from what bcat-ops knows, say precisely
 * which are missing when it can't, and record WHERE each value came from so a
 * wrong ZIP is traceable instead of mysterious.
 *
 * Field precedence (highest first):
 *   1. manual     — a human typed it on the queue row; always wins
 *   2. ratecon    — parsed from the rate confirmation, the contractual document
 *   3. load       — the Load record (city only; it stores no state/ZIP)
 *   4. location   — the Location linked from the stop
 *   5. geocode    — derived from the city, last resort
 *
 * Broker MC is deliberately NOT sourced from the rate confirmation. Rate cons
 * state the CARRIER's authority (on a Schneider tender: "Carrier: IVAN CARTAGE
 * CO, MC# 274623, DOT# 547328" — that is Ivan Cartage's own MC, not the
 * broker's). Sending it as BrokerMC would mis-bill. It comes from the Customer
 * record, entered once per broker by a human.
 */

export type OtrFieldSource = 'manual' | 'ratecon' | 'load' | 'location' | 'geocode'

/** The eleven fields OTR requires, in the order they appear on the queue row. */
export const OTR_REQUIRED_FIELDS = [
  'InvoiceNo',
  'PoNumber',
  'BrokerMC',
  'InvoiceAmount',
  'InvoiceDate',
  'FromCity',
  'FromState',
  'FromZip',
  'ToCity',
  'ToState',
  'ToZip',
] as const
export type OtrRequiredField = (typeof OTR_REQUIRED_FIELDS)[number]

/** Labels shown to a human when a field is missing. */
export const OTR_FIELD_LABEL: Record<OtrRequiredField, string> = {
  InvoiceNo: 'Invoice number (PRO)',
  PoNumber: 'PO number',
  BrokerMC: 'Broker MC',
  InvoiceAmount: 'Invoice amount',
  InvoiceDate: 'Invoice date',
  FromCity: 'Origin city',
  FromState: 'Origin state',
  FromZip: 'Origin ZIP',
  ToCity: 'Destination city',
  ToState: 'Destination state',
  ToZip: 'Destination ZIP',
}

/** What the extended ratecon parser returns. Every field is optional — a tender
 *  may omit any of them, and a null is always preferable to a guess. */
export interface RateConExtract {
  brokerName?: string | null
  poNumber?: string | null
  /** Dollars as printed on the tender (e.g. 450.00), not cents. */
  totalRate?: number | null
  /** YYYY-MM-DD. */
  date?: string | null
  originCity?: string | null
  originState?: string | null
  originZip?: string | null
  destinationCity?: string | null
  destinationState?: string | null
  destinationZip?: string | null
}

/** The slice of a Load this module needs. Keeps the signature honest. */
export interface LoadSlice {
  aljexId?: string | null
  pickupNumber?: string | null
  /** CENTS, as stored. */
  rate?: number | null
  originCity?: string | null
  destinationCity?: string | null
  customerId?: string | null
  customer?: string | null
  rateConfirmKey?: string | null
}

/** City/state/ZIP resolved from a linked Location, when a stop has one. */
export interface LocationSlice {
  city?: string | null
  state?: string | null
  zip?: string | null
}

/** Values a human typed on the queue row. Highest precedence. */
/**
 * Values typed by the office, which beat every resolved source.
 *
 * `CustomerName` is the one key that is not an OTR required field: OTR resolves the broker
 * from the MC and never reads a name from us. It is here because the queue shows the name
 * to humans, and a load whose customer string names a shipper or an agent needs correcting
 * on the row rather than on the load.
 */
export type ManualOverrides = Partial<Record<OtrRequiredField | 'CustomerName', string>>

export interface AssembleInput {
  load: LoadSlice
  rateCon?: RateConExtract | null
  /** Broker MC from the Customer record — entered once per broker by a human. */
  customerMcNumber?: string | null
  /**
   * The broker's name from the directory record the MC belongs to.
   *
   * Never sent to OTR — they resolve the broker from the MC themselves — but the office
   * needs it on screen, because an MC is nine digits nobody recognises and "is 14538 the
   * AmeriFreight one?" is the question that actually gets asked about a factoring row.
   */
  customerName?: string | null
  originLocation?: LocationSlice | null
  destinationLocation?: LocationSlice | null
  /** Geocoded fallbacks, only consulted when everything above is blank. */
  geocodedOrigin?: LocationSlice | null
  geocodedDestination?: LocationSlice | null
  manual?: ManualOverrides | null
  /**
   * YYYY-MM-DD for the day we submit. OTR defines InvoiceDate as the date
   * submitted, so this — not the tender's own date — is the primary source.
   * Passed in rather than read from a clock so this stays pure.
   */
  submissionDate?: string | null
  /** Documents already attached to the load. */
  hasPod?: boolean
  hasRateConfirmation?: boolean
}

export interface OtrReadiness {
  /** True only when all eleven fields resolve AND both documents are present. */
  ready: boolean
  /** Fully populated only when `ready`; partial otherwise, for display. */
  payload: Partial<Record<OtrRequiredField, string | number>>
  /** Which source supplied each resolved field. */
  sources: Partial<Record<OtrRequiredField, OtrFieldSource>>
  /**
   * Who the invoice bills, for the humans. Set once an MC resolves, from the directory
   * record that MC belongs to; the load's own customer string fills in before that, and
   * `customerConfirmed` says which of the two you are looking at. Not part of the OTR
   * payload and never counted as a missing field.
   */
  customerName?: string | null
  /** True when the name came from the broker record the MC identifies. */
  customerConfirmed?: boolean
  /** Required fields that resolved to nothing. */
  missingFields: OtrRequiredField[]
  /** Documents OTR expects alongside the invoice. */
  missingDocuments: Array<'POD' | 'Rate confirmation'>
  /**
   * Conflicts a human should look at before submitting. These do NOT block
   * `ready` — the payload is valid either way — but factoring the wrong amount
   * is expensive, so a disagreement between sources is surfaced rather than
   * silently resolved by precedence.
   */
  warnings: OtrWarning[]
}

export interface OtrWarning {
  field: OtrRequiredField
  /** What each source said, so the row can show both numbers. */
  message: string
}

/**
 * Cent-level disagreement between the tender's total and the load's stored rate.
 * Anything at or below this is rounding, not a conflict.
 */
const AMOUNT_TOLERANCE_DOLLARS = 0.01

/** A trimmed non-empty string, or undefined. Treats "N/A" as absent — the Load
 *  table stores that literal for unknown pickupNumber/tmsId. */
function clean(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t || t.toUpperCase() === 'N/A' || t.toUpperCase() === 'UNK') return undefined
  return t
}

/** ZIP+4 ("85212-2171") is valid on a tender but OTR wants the 5-digit base. */
export function normalizeZip(zip: string | null | undefined): string | undefined {
  const v = clean(zip)
  if (!v) return undefined
  const m = v.match(/\b(\d{5})(?:-\d{4})?\b/)
  return m ? m[1] : undefined
}

/** "MESA, AZ" → { city: 'MESA', state: 'AZ' }. Load.originCity sometimes carries
 *  the state appended; splitting it recovers a field we'd otherwise geocode. */
export function splitCityState(v: string | null | undefined): {
  city?: string
  state?: string
} {
  const s = clean(v)
  if (!s) return {}
  const m = s.match(/^(.*?),\s*([A-Za-z]{2})$/)
  if (m) return { city: m[1].trim(), state: m[2].toUpperCase() }
  return { city: s }
}

/** Two-letter state, uppercased. Rejects anything else rather than sending junk. */
function normalizeState(v: unknown): string | undefined {
  const s = clean(v)
  if (!s) return undefined
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : undefined
}

/** Load.rate is CENTS. OTR's InvoiceAmount is DOLLARS. */
export function rateCentsToDollars(cents: number | null | undefined): number | undefined {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) return undefined
  return Math.round(cents) / 100
}

/** Accepts YYYY-MM-DD or M/D/YYYY (as printed on tenders) → YYYY-MM-DD. */
export function normalizeDate(v: string | null | undefined): string | undefined {
  const s = clean(v)
  if (!s) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const [, mo, d, y] = m
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return undefined
}

/**
 * Resolve every OTR field from what we know, and report what's still missing.
 * Never throws: an unbuildable invoice comes back as `ready: false` with the
 * exact gaps, which is what the queue row renders.
 */
export function assembleOtrInvoice(input: AssembleInput): OtrReadiness {
  const { load, rateCon, manual } = input
  const m = manual ?? {}
  const rc = rateCon ?? null

  // Load.originCity may be "MESA, AZ"; recover the state rather than geocoding it.
  const loadOrigin = splitCityState(load.originCity)
  const loadDest = splitCityState(load.destinationCity)

  const payload: OtrReadiness['payload'] = {}
  const sources: OtrReadiness['sources'] = {}

  const set = (
    field: OtrRequiredField,
    candidates: Array<[OtrFieldSource, unknown]>,
    transform: (v: string) => string | number | undefined = (v) => v,
  ) => {
    for (const [source, raw] of candidates) {
      const cleaned = clean(raw)
      if (cleaned === undefined) continue
      const out = transform(cleaned)
      if (out === undefined || out === '') continue
      payload[field] = out
      sources[field] = source
      return
    }
  }

  // Identity. PRO is the invoice number; the load's pickup number is the PO,
  // with the tender's own PO # preferred when it states one.
  set('InvoiceNo', [
    ['manual', m.InvoiceNo],
    ['load', load.aljexId],
  ])
  set('PoNumber', [
    ['manual', m.PoNumber],
    ['ratecon', rc?.poNumber],
    ['load', load.pickupNumber],
  ])
  // Broker MC: manual entry only (see file header — never from the rate con).
  set('BrokerMC', [
    ['manual', m.BrokerMC],
    ['load', input.customerMcNumber],
  ])

  set(
    'InvoiceAmount',
    [
      ['manual', m.InvoiceAmount],
      ['ratecon', rc?.totalRate],
      ['load', rateCentsToDollars(load.rate)],
    ],
    (v) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : undefined
    },
  )
  // OTR defines InvoiceDate as the date SUBMITTED, so the submission date leads
  // and the tender's own date is only a fallback for a row assembled offline.
  set(
    'InvoiceDate',
    [
      ['manual', m.InvoiceDate],
      ['load', input.submissionDate],
      ['ratecon', rc?.date],
    ],
    (v) => normalizeDate(v),
  )

  // Origin
  set('FromCity', [
    ['manual', m.FromCity],
    ['ratecon', rc?.originCity],
    ['load', loadOrigin.city],
    ['location', input.originLocation?.city],
    ['geocode', input.geocodedOrigin?.city],
  ])
  set(
    'FromState',
    [
      ['manual', m.FromState],
      ['ratecon', rc?.originState],
      ['load', loadOrigin.state],
      ['location', input.originLocation?.state],
      ['geocode', input.geocodedOrigin?.state],
    ],
    (v) => normalizeState(v),
  )
  set(
    'FromZip',
    [
      ['manual', m.FromZip],
      ['ratecon', rc?.originZip],
      ['location', input.originLocation?.zip],
      ['geocode', input.geocodedOrigin?.zip],
    ],
    (v) => normalizeZip(v),
  )

  // Destination
  set('ToCity', [
    ['manual', m.ToCity],
    ['ratecon', rc?.destinationCity],
    ['load', loadDest.city],
    ['location', input.destinationLocation?.city],
    ['geocode', input.geocodedDestination?.city],
  ])
  set(
    'ToState',
    [
      ['manual', m.ToState],
      ['ratecon', rc?.destinationState],
      ['load', loadDest.state],
      ['location', input.destinationLocation?.state],
      ['geocode', input.geocodedDestination?.state],
    ],
    (v) => normalizeState(v),
  )
  set(
    'ToZip',
    [
      ['manual', m.ToZip],
      ['ratecon', rc?.destinationZip],
      ['location', input.destinationLocation?.zip],
      ['geocode', input.geocodedDestination?.zip],
    ],
    (v) => normalizeZip(v),
  )

  const missingFields = OTR_REQUIRED_FIELDS.filter((f) => payload[f] === undefined)

  const missingDocuments: OtrReadiness['missingDocuments'] = []
  if (!input.hasPod) missingDocuments.push('POD')
  if (!input.hasRateConfirmation) missingDocuments.push('Rate confirmation')

  // Amount conflict: the tender and the load disagree. Precedence already chose
  // one; say so out loud rather than letting a wrong invoice through quietly.
  const warnings: OtrWarning[] = []
  const tenderAmount = typeof rc?.totalRate === 'number' ? rc.totalRate : undefined
  const loadAmount = rateCentsToDollars(load.rate)
  if (
    tenderAmount !== undefined &&
    loadAmount !== undefined &&
    Math.abs(tenderAmount - loadAmount) > AMOUNT_TOLERANCE_DOLLARS &&
    sources.InvoiceAmount !== 'manual'
  ) {
    warnings.push({
      field: 'InvoiceAmount',
      message:
        `Rate confirmation says $${tenderAmount.toFixed(2)} but the load is booked at ` +
        `$${loadAmount.toFixed(2)}. Submitting $${Number(payload.InvoiceAmount).toFixed(2)}.`,
    })
  }

  /*
   * The name follows the MC. Before one is entered the load's own customer string is the
   * best guess we have, and it is shown as a guess: a tender can name a shipper or an
   * agent rather than the broker whose MC we will actually factor against.
   */
  const typedName = clean(m.CustomerName)
  const confirmed =
    typedName !== undefined ||
    (clean(input.customerMcNumber) !== undefined && clean(input.customerName) !== undefined)
  const customerName = typedName ?? clean(input.customerName) ?? clean(load.customer) ?? null

  return {
    ready: missingFields.length === 0 && missingDocuments.length === 0,
    payload,
    sources,
    customerName: customerName ?? null,
    customerConfirmed: confirmed,
    missingFields,
    missingDocuments,
    warnings,
  }
}

/** Narrow a ready readiness to the exact payload shape the OTR client takes. */
export function toOtrPayload(r: OtrReadiness): Record<OtrRequiredField, string | number> | null {
  if (!r.ready) return null
  return r.payload as Record<OtrRequiredField, string | number>
}
