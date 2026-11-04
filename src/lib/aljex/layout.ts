/**
 * Typed layout of the Aljex full export (486 columns), positional.
 *
 * The export repeats header names (Name/Address/City/State/Zip/Code/Description/Weight/Rate/...),
 * so nothing is ever looked up by header text at row time: `AljexLayout` carries fixed 0-based
 * column indexes, built once from the header row (`buildLayout`) and keyed by a fingerprint
 * (header count + the header text at sentinel columns). A different export (renamed/added
 * columns) fails `detectLayout` with `UnknownLayoutError` until a profile exists for it.
 *
 * This is the typed twin of scripts/lib/aljexColumns.mjs (profiler builder). layout.test.ts
 * imports both and fails on any drift in the dictionary or the discovered indexes.
 * Header NAMES (schema, no values) live in headers.json, also read by scripts/lib/aljexFixture.mjs.
 */
import HEADERS_V1 from './headers.json'

export const LAYOUT_V1_ID = 'aljex-full-486-v1'

/** Lower-case, apostrophes dropped, '#'->' no ', '%'->' pct ', '$'->' usd ', other non-alnum -> space. */
export function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/#/g, ' no ')
    .replace(/%/g, ' pct ')
    .replace(/\$/g, ' usd ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export type ColumnKind = 'id' | 'name' | 'addr' | 'text' | 'staff' | 'cat' | 'flag' | 'date' | 'time' | 'money' | 'num' | 'pct'

// [normalized header, key, kind]; mirrors SCALAR_SPECS in scripts/lib/aljexColumns.mjs.
export const SCALAR_SPECS = [
  ['office', 'office', 'cat'],
  ['pro no', 'proNo', 'id'],
  ['master invoice', 'masterInvoice', 'id'],
  ['customer account no', 'customerId', 'id'],
  ['customer name', 'customerName', 'name'],
  ['customer address', 'customerAddress', 'addr'],
  ['customer city', 'customerCity', 'addr'],
  ['customer state', 'customerState', 'addr'],
  ['customer zip', 'customerZip', 'addr'],
  ['type of shipment', 'typeOfShipment', 'cat'],
  ['tonu', 'tonu', 'cat'],
  ['salesrep id', 'salesrepId', 'cat'],
  ['reference no', 'referenceNo', 'id'],
  ['dispatch status', 'dispatchStatus', 'cat'],
  ['invoice date', 'invoiceDate', 'date'],
  ['ship date', 'shipDate', 'date'],
  ['eta date', 'etaDate', 'date'],
  ['delivery appt date', 'deliveryApptDate', 'date'],
  ['delivery appt time', 'deliveryApptTime', 'time'],
  ['deliver appt note', 'deliverApptNote', 'text'],
  ['must deliver date', 'mustDeliverDate', 'date'],
  ['delivered date', 'deliveredDate', 'date'],
  ['posted info', 'postedInfo', 'text'],
  ['bill to account', 'billToId', 'id'],
  ['bill to name', 'billToName', 'name'],
  ['bill to address', 'billToAddress', 'addr'],
  ['bill to city', 'billToCity', 'addr'],
  ['bill to state', 'billToState', 'addr'],
  ['bill to zip', 'billToZip', 'addr'],
  ['pickup name', 'pickupName', 'name'],
  ['pickup city', 'pickupCity', 'addr'],
  ['pickup state', 'pickupState', 'addr'],
  ['pickup zip', 'pickupZip', 'addr'],
  ['consignee name', 'consigneeName', 'name'],
  ['consignee city', 'consigneeCity', 'addr'],
  ['consignee state', 'consigneeState', 'addr'],
  ['consignee zip', 'consigneeZip', 'addr'],
  ['line haul carrier id', 'carrierId', 'id'],
  ['carrier name', 'carrierName', 'name'],
  ['carrier ref no', 'carrierRefNo', 'id'],
  ['carrier dispatcher', 'carrierDispatcher', 'name'],
  ['description', 'commodity', 'text'],
  ['weight', 'weight', 'num'],
  ['footage', 'footage', 'num'],
  ['manifest', 'manifest', 'text'],
  ['customer ref no', 'customerRefNo', 'id'],
  ['container no', 'containerNo', 'id'],
  ['miles class', 'miles', 'num'],
  ['entered', 'enteredBy', 'staff'],
  ['covered', 'coveredBy', 'staff'],
  ['revenue type', 'revenueType', 'cat'],
  ['lh revenue', 'lhRevenue', 'money'],
  ['acc revenue', 'accRevenue', 'money'],
  ['projected carrier expense', 'projectedCarrierExpense', 'money'],
  ['carrier lh', 'carrierLh', 'money'],
  ['carrier accessorial', 'carrierAccessorial', 'money'],
  ['projected gross profit', 'projectedGrossProfit', 'money'],
  ['projected profit pct', 'projectedProfitPct', 'pct'],
  ['payments received', 'paymentsReceived', 'money'],
  ['actual carrier exp', 'actualCarrierExp', 'money'],
  ['accessorial profit', 'accessorialProfit', 'money'],
  ['credits', 'credits', 'money'],
  ['debits', 'debits', 'money'],
  ['bal due', 'balDue', 'money'],
  ['projected l h profit', 'projectedLhProfit', 'money'],
  ['advance fees', 'advanceFees', 'money'],
  ['quick pay fees', 'quickPayFees', 'money'],
  ['osd y n', 'osd', 'flag'],
  ['mode', 'mode', 'cat'],
  ['release date', 'releaseDate', 'date'],
  ['release time', 'releaseTime', 'time'],
  ['release by', 'releaseBy', 'staff'],
  ['billed by', 'billedBy', 'staff'],
  ['fsc revenue', 'fscRevenue', 'money'],
  ['invoice amount', 'invoiceAmount', 'money'],
  ['benchmark', 'benchmark', 'text'],
  ['lead source', 'leadSource', 'text'],
  ['quote no', 'quoteNo', 'id'],
  ['origin region', 'originRegion', 'cat'],
  ['destination region', 'destinationRegion', 'cat'],
  ['hazmat', 'hazmat', 'flag'],
  ['temp control', 'tempControl', 'flag'],
  ['seal', 'seal', 'id'],
  ['plt exchange', 'pltExchange', 'flag'],
  ['plt in', 'pltIn', 'num'],
  ['plt out', 'pltOut', 'num'],
  ['blind', 'blind', 'flag'],
  ['customs bond', 'customsBond', 'flag'],
  ['declared value', 'declaredValue', 'money'],
  ['escort', 'escort', 'flag'],
  ['high risk', 'highRisk', 'flag'],
  ['hot', 'hot', 'flag'],
  ['labor', 'labor', 'flag'],
  ['over size', 'overSize', 'flag'],
  ['permit', 'permit', 'flag'],
  ['tarps', 'tarps', 'flag'],
  ['tarp size', 'tarpSize', 'text'],
  ['team', 'team', 'flag'],
  ['smartway', 'smartway', 'flag'],
  ['created by', 'createdBy', 'staff'],
  ['created date', 'createdDate', 'date'],
  ['created time', 'createdTime', 'time'],
  ['pick up address', 'pickUpAddress', 'addr'],
  ['final consignee address', 'finalConsigneeAddress', 'addr'],
  ['carrier email', 'carrierEmail', 'text'],
  ['tractor no', 'tractorNo', 'id'],
  ['driver name', 'driverName', 'name'],
  ['carrier mc no prefix', 'carrierMcPrefix', 'cat'],
  ['carrier mc no', 'carrierMc', 'id'],
  ['carrier dot no', 'carrierDot', 'id'],
  ['carrier scac code', 'carrierScac', 'id'],
  ['carrier ca intrastate', 'carrierCaIntrastate', 'id'],
  ['carrier ca intrastate exp', 'carrierCaIntrastateExp', 'date'],
  ['carrier tx puc no', 'carrierTxPuc', 'id'],
  ['carrier tx puc no exp', 'carrierTxPucExp', 'date'],
  ['carrier safety rating', 'carrierSafetyRating', 'cat'],
  ['mexican authority y n', 'mexicanAuthority', 'flag'],
  ['canadian authority y n', 'canadianAuthority', 'flag'],
  ['covered date', 'coveredDate', 'date'],
  ['covered time', 'coveredTime', 'time'],
  ['office covered by', 'officeCoveredBy', 'staff'],
  ['customer contact', 'customerContact', 'name'],
  ['pickup contact', 'pickupContact', 'name'],
  ['consignee contact', 'consigneeContact', 'name'],
  ['currency', 'currency', 'cat'],
  ['conf recd date', 'confRecdDate', 'date'],
  ['conf recd time', 'confRecdTime', 'time'],
  ['service rep', 'serviceRep', 'staff'],
  ['assigned dispatcher', 'assignedDispatcher', 'staff'],
  ['actual dispatcher', 'actualDispatcher', 'staff'],
  ['pickup ref no', 'pickupRefNo', 'id'],
  ['consignee ref no', 'consigneeRefNo', 'id'],
  ['carrier phone', 'carrierPhone', 'text'],
  ['carrier dispatch phone', 'carrierDispatchPhone', 'text'],
  ['carrier 24 hr phone', 'carrier24HrPhone', 'text'],
  ['carrier email 1', 'carrierEmail1', 'text'],
  ['carier email 2', 'carrierEmail2', 'text'],
] as const

export type ScalarKey = (typeof SCALAR_SPECS)[number][1]

const SPEC_BY_NORM = new Map<string, { key: ScalarKey; kind: ColumnKind }>(
  SCALAR_SPECS.map(([n, key, kind]) => [n, { key, kind }]),
)

const STOP_FIELDS = ['marker', 'name', 'address', 'city', 'state', 'zip', 'phone', 'ref'] as const
const STOP_PATTERNS = [/^ps\d*$/, /^name$/, /^address$/, /^city$/, /^state$/, /^zip$/, /^phone$/, /^ref( no)?$/]
const CHARGE_FIELDS = ['code', 'description', 'units', 'weight', 'rate', 'extension'] as const
const CHARGE_PATTERNS = [/^code$/, /^description$/, /units/, /^weight$/, /^rate$/, /^extension$/]
const PAID_EXP_FIELDS = ['name', 'amount', 'date', 'checkNo', 'gl'] as const
const PAID_EXP_PATTERNS = [/^paid exp name$/, /^paid exp amt$/, /^paid exp date$/, /^paid exp ck no$/, /^paid exp gl$/]

export type StopField = (typeof STOP_FIELDS)[number]
export type ChargeField = (typeof CHARGE_FIELDS)[number]
export type PaidExpField = (typeof PAID_EXP_FIELDS)[number]

export interface StopColumns { ordinal: number; fields: Record<StopField, number> }
export interface ChargeColumns { ordinal: number; fields: Record<ChargeField, number> }
export interface PaidExpColumns { ordinal: number; fields: Partial<Record<PaidExpField, number>> }
export interface AccessorialColumns { ordinal: number; fields: { charge?: number; label?: number } }
export interface PaymentColumns { ordinal: number; fields: { date?: number; amount?: number; daysToPay?: number; checkNo?: number } }
export interface ProjectedColumns { ordinal: number; fields: { expense?: number; amount?: number; type?: number } }
export interface CommissionColumns { ordinal: number; fields: Partial<Record<'rep' | 'amt' | 'source' | 'gnf' | 'pct' | 'flat' | 'posted', number>> }

export interface AljexLayout {
  id: string
  /** Header text by 0-based column position. */
  headers: readonly string[]
  headerCount: number
  /** Header text at the sentinel columns; compared on detection. */
  fingerprint: { count: number; sentinels: Array<{ index: number; header: string }> }
  /** 0-based column index per scalar key. */
  scalar: Record<ScalarKey, number>
  stops: StopColumns[]
  charges: ChargeColumns[]
  accessorials: AccessorialColumns[]
  customerPayments: PaymentColumns[]
  projectedExpenses: ProjectedColumns[]
  paidExpenses: PaidExpColumns[]
  commissions: CommissionColumns[]
  /** 0-based column of each `Additional Ref #`. */
  additionalRefs: number[]
}

export class UnknownLayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownLayoutError'
  }
}

/** 1-based sentinel columns 2, 4, 14, 53, 123, 195, 291, 417, 425, 427, 486 (plan section 3.1) as 0-based indexes. */
const SENTINEL_INDEXES = [1, 3, 13, 52, 122, 194, 290, 416, 424, 426, 485]

function matchRun(norm: string[], start: number, patterns: RegExp[], required: number): number[] | null {
  const idx: number[] = []
  for (let k = 0; k < patterns.length; k++) {
    const i = start + k
    if (i < norm.length && patterns[k].test(norm[i])) idx.push(i)
    else if (k < required) return null
    else break
  }
  return idx
}

function toFields<F extends string>(names: readonly F[], idx: number[]): Partial<Record<F, number>> {
  const f: Partial<Record<F, number>> = {}
  for (let k = 0; k < idx.length; k++) f[names[k]] = idx[k]
  return f
}

function commissionField(norm: string): keyof CommissionColumns['fields'] | null {
  if (/^commission rep \d+$/.test(norm)) return 'rep'
  if (/^commission amt \d+$/.test(norm)) return 'amt'
  if (/^commission (created from|isp) \d+$/.test(norm)) return 'source'
  if (/^commis(sion)? gnf \d+$/.test(norm)) return 'gnf'
  if (/^commis(sion)? pct \d+$/.test(norm)) return 'pct'
  if (/^commis(sion)? flat usd \d+$/.test(norm)) return 'flat'
  if (/^posted commis(sion)? \d+$/.test(norm)) return 'posted'
  return null
}

function numbered(norm: string, re: RegExp): number | null {
  const m = re.exec(norm)
  return m ? Number(m[1]) : null
}

/** Build the positional layout from a header row. Throws UnknownLayoutError if a required scalar column is missing. */
export function buildLayout(headers: readonly string[], id: string): AljexLayout {
  const norm = headers.map(normalizeHeader)
  const claimed = new Set<number>()
  const stops: StopColumns[] = []
  const charges: ChargeColumns[] = []
  const paidExpenses: PaidExpColumns[] = []
  const additionalRefs: number[] = []
  const acc = new Map<number, AccessorialColumns['fields']>()
  const pay = new Map<number, PaymentColumns['fields']>()
  const proj = new Map<number, ProjectedColumns['fields']>()
  const com = new Map<number, CommissionColumns['fields']>()
  const byNumber = <T extends object>(map: Map<number, T>, n: number, field: keyof T, i: number) => {
    const entry = map.get(n) ?? ({} as T)
    entry[field] = i as T[keyof T]
    map.set(n, entry)
    claimed.add(i)
  }

  for (let i = 0; i < norm.length; i++) {
    const h = norm[i]
    if (STOP_PATTERNS[0].test(h)) {
      const idx = matchRun(norm, i, STOP_PATTERNS, 6)
      if (idx) {
        stops.push({ ordinal: stops.length + 1, fields: { phone: -1, ref: -1, ...toFields(STOP_FIELDS, idx) } as Record<StopField, number> })
        idx.forEach((x) => claimed.add(x))
        i = idx[idx.length - 1]
        continue
      }
    }
    if (h === 'code') {
      const idx = matchRun(norm, i, CHARGE_PATTERNS, 6)
      if (idx) {
        charges.push({ ordinal: charges.length + 1, fields: toFields(CHARGE_FIELDS, idx) as Record<ChargeField, number> })
        idx.forEach((x) => claimed.add(x))
        i = idx[5]
        continue
      }
    }
    if (h === 'paid exp name') {
      const idx = matchRun(norm, i, PAID_EXP_PATTERNS, 4)
      if (idx) {
        paidExpenses.push({ ordinal: paidExpenses.length + 1, fields: toFields(PAID_EXP_FIELDS, idx) })
        idx.forEach((x) => claimed.add(x))
        i = idx[idx.length - 1]
        continue
      }
    }
    if (h === 'additional ref no') {
      additionalRefs.push(i)
      claimed.add(i)
      continue
    }
    let n: number | null
    if ((n = numbered(h, /^acc charge (\d+)$/)) != null) byNumber(acc, n, 'charge', i)
    else if ((n = numbered(h, /^acc (\d+)$/)) != null) byNumber(acc, n, 'label', i)
    else if ((n = numbered(h, /^paid date (\d+)$/)) != null) byNumber(pay, n, 'date', i)
    else if ((n = numbered(h, /^paid amount (\d+)$/)) != null) byNumber(pay, n, 'amount', i)
    else if ((n = numbered(h, /^days to pay (\d+)$/)) != null) byNumber(pay, n, 'daysToPay', i)
    else if ((n = numbered(h, /^paid ck no (\d+)$/)) != null) byNumber(pay, n, 'checkNo', i)
    else if ((n = numbered(h, /^proj exp (\d+)$/)) != null) byNumber(proj, n, 'expense', i)
    else if ((n = numbered(h, /^proj amt (\d+)$/)) != null) byNumber(proj, n, 'amount', i)
    else if ((n = numbered(h, /^type (\d+)$/)) != null) byNumber(proj, n, 'type', i)
    else {
      const cf = commissionField(h)
      if (cf) byNumber(com, numbered(h, /(\d+)$/) as number, cf, i)
    }
  }

  const fromMap = <T>(map: Map<number, T>): Array<{ ordinal: number; fields: T }> =>
    [...map.entries()].sort((a, b) => a[0] - b[0]).map(([ordinal, fields]) => ({ ordinal, fields }))

  const scalar = {} as Record<ScalarKey, number>
  const seen = new Set<string>()
  for (let i = 0; i < headers.length; i++) {
    if (claimed.has(i)) continue
    const n = norm[i]
    const spec = SPEC_BY_NORM.get(n)
    if (spec && !seen.has(n)) scalar[spec.key] = i
    seen.add(n)
  }
  const missing = SCALAR_SPECS.filter(([, key]) => scalar[key] === undefined).map(([, key]) => key)
  if (missing.length) throw new UnknownLayoutError(`Layout ${id}: missing columns ${missing.join(', ')}`)

  return {
    id,
    headers,
    headerCount: headers.length,
    fingerprint: {
      count: headers.length,
      sentinels: SENTINEL_INDEXES.filter((i) => i < headers.length).map((index) => ({ index, header: headers[index] })),
    },
    scalar,
    stops,
    charges,
    accessorials: fromMap(acc),
    customerPayments: fromMap(pay),
    projectedExpenses: fromMap(proj),
    paidExpenses,
    commissions: fromMap(com),
    additionalRefs,
  }
}

export const ALJEX_HEADERS_V1: readonly string[] = HEADERS_V1

export const LAYOUT_V1: AljexLayout = buildLayout(ALJEX_HEADERS_V1, LAYOUT_V1_ID)

export const ALJEX_LAYOUTS: readonly AljexLayout[] = [LAYOUT_V1]

/** Expected repeated-group sizes of the known layout. */
export const GROUP_COUNTS = {
  stops: 12,
  charges: 21,
  accessorials: 8,
  customerPayments: 3,
  projectedExpenses: 9,
  paidExpenses: 8,
  commissions: 3,
  additionalRefs: 8,
} as const

/**
 * The known layout whose fingerprint (header count + sentinel header text) equals this header
 * row. Never guesses: an unknown export throws until a profile/layout exists for it.
 */
export function detectLayout(headers: readonly string[]): AljexLayout {
  for (const layout of ALJEX_LAYOUTS) {
    const f = layout.fingerprint
    if (headers.length !== f.count) continue
    if (f.sentinels.every((s) => normalizeHeader(headers[s.index]) === normalizeHeader(s.header))) return layout
  }
  throw new UnknownLayoutError(
    `Unrecognised Aljex export layout (${headers.length} columns). Only ${ALJEX_LAYOUTS.map((l) => l.id).join(', ')} is supported; a different export needs a new layout and mapping profile first.`,
  )
}
