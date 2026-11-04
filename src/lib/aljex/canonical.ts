import type { RawFields } from './rawRow'

/**
 * Canonical, layout-independent shape of one row of the Aljex full export.
 *
 * `mapAljexRow(cells, layout, opts)` (./mapRow.ts) is the only producer. It is pure: no I/O,
 * no clock, no profile lookups beyond the small `MapOptions`. Money is integer cents, dates are
 * `YYYY-MM-DD` strings (or null), nothing is upper-cased on the way in except the keys named
 * below. Everything the engine needs per PRO is on this object; every raw cell is kept in `raw`
 * (position+header keyed, verbatim) so a LegacyAljexRow can be written without re-reading the file.
 */

export type AljexRowKind = 'LOAD' | 'MEMO_DEBT' | 'MEMO_CRED'

/** Non-blocking observation about a row; the engine lists them in the report. */
export interface RowWarning {
  code: string
  /** Column header or group the warning is about (never a cell value). */
  column?: string
}

export interface CanonicalParty {
  /** Aljex account id (Customer Account # / Bill To Account). */
  account: string
  name: string
  street: string
  city: string
  state: string
  zip: string
  contact: string
}

export interface CanonicalStop {
  /** 0-based position in the final stop order (pickup first, final consignee last). */
  sequence: number
  type: 'pickup' | 'delivery'
  source: 'PICKUP' | 'CONSIGNEE' | `PS${number}`
  /** Raw stop-block marker (`P`/`S`, blank for the scalar stops). */
  marker: string
  name: string
  street: string
  city: string
  state: string
  zip: string
  phone: string
  contact: string
  ref: string
  /** Appointment date (YYYY-MM-DD) / local time (HH:MM) when the export carries them. */
  apptDate: string | null
  apptTime: string | null
  /** Must Deliver Date, only on the final delivery. */
  apptEndDate: string | null
}

export interface CanonicalCharge {
  /** 1-based line number within the 21 charge lines. */
  line: number
  code: string
  description: string
  units: string
  weight: string
  /** Rate as cents; null when blank/unparseable. */
  rateCents: number | null
  extensionCents: number
}

export interface CanonicalAccessorialPair {
  n: number
  label: string
  amountCents: number
}

export interface CanonicalPayment {
  /** 1-based block number (1..3). */
  n: number
  date: string | null
  amountCents: number
  checkNo: string
}

export interface CanonicalProjectedExpense {
  n: number
  payee: string
  amountCents: number
  type: string
}

export interface CanonicalPaidExpense {
  n: number
  name: string
  amountCents: number
  date: string | null
  checkNo: string
  gl: string
}

export interface CanonicalCommission {
  n: number
  rep: string
}
/** A CRED/DEBT memo row: an adjustment line on the invoice of the load whose PRO is its Reference #. */
export interface CanonicalMemo {
  /** `Reference #` as exported. */
  referencePro: string
  /** normalizePro(referencePro); null when blank/unusable. */
  referenceProKey: string | null
  description: string
  postedInfo: string
  /** CRED negative, DEBT positive (the sign of the exported amount). */
  signedAmountCents: number
  /** Invoice Date of the memo row. */
  date: string | null
}


export interface CanonicalCarrier {
  id: string
  name: string
  refNo: string
  dispatcher: string
  /** First non-blank of Carrier Email, Carrier Email 1, Carrier Email 2. */
  email: string
  phone: string
  dispatchPhone: string
  phone24: string
  /** `MC` | `MX` | ''. */
  mcPrefix: string
  /** Digits only (leading zeros kept); '' when blank. */
  mc: string
  dot: string
  scac: string
  safetyRating: string
  driverName: string
  tractor: string
  caIntrastate: string
  /** YYYY-MM-DD or null. */
  caIntrastateExp: string | null
  txPuc: string
  txPucExp: string | null
}

export interface CanonicalDates {
  invoice: string | null
  ship: string | null
  eta: string | null
  deliveryAppt: string | null
  deliveryApptTime: string | null
  mustDeliver: string | null
  delivered: string | null
  release: string | null
  releaseTime: string | null
  created: string | null
  createdTime: string | null
  covered: string | null
  coveredTime: string | null
  confRecd: string | null
}

export interface JunkDate {
  /** Dictionary key of the column (`shipDate`, `deliveredDate`, ...). */
  column: string
  /** The date as exported (a date, not PII), e.g. 1970-01-01 for `70`; null when it did not parse at all. */
  value: string | null
}

export interface CanonicalMoney {
  lhRevenueCents: number
  accRevenueCents: number
  fscRevenueCents: number
  invoiceAmountCents: number
  paymentsReceivedCents: number
  creditsCents: number
  debitsCents: number
  /** null when the Bal Due cell is blank (not invoiced), 0 only when it says 0. */
  balDueCents: number | null
  projectedCarrierExpenseCents: number
  carrierLhCents: number
  carrierAccessorialCents: number
  actualCarrierExpCents: number
  quickPayFeesCents: number
  advanceFeesCents: number
  declaredValueCents: number
}

export interface CanonicalFreight {
  commodity: string
  /** Integer pounds, null when blank/non-numeric. */
  weight: number | null
  footage: string
  /** Integer miles from `Miles/Class`, null when not purely numeric. */
  miles: number | null
  hazmat: boolean
  tempControl: boolean
  hot: boolean
  team: boolean
  tarps: boolean
  seal: string
  tarpSize: string
  pltExchange: boolean
  customsBond: boolean
  escort: boolean
  overSize: boolean
  permit: boolean
  blind: boolean
  labor: boolean
  highRisk: boolean
  smartway: boolean
  pltIn: number | null
  pltOut: number | null
  /** Raw `Revenue Type`. */
  revenueType: string
}

export interface CanonicalStaff {
  enteredBy: string
  coveredBy: string
  createdBy: string
  releaseBy: string
  billedBy: string
  serviceRep: string
  assignedDispatcher: string
  actualDispatcher: string
}

export interface CanonicalRow {
  /** 1-based data-row number (header excluded). */
  rowNumber: number
  layoutId: string
  kind: AljexRowKind
  /** `Pro #` trimmed. */
  pro: string
  /** `normalizePro(pro)` (the app's PRO identity); null when it is not a usable PRO. */
  proKey: string | null
  typeOfShipment: string
  /** `Dispatch Status` trimmed (case kept). */
  statusRaw: string
  /** Upper-cased, whitespace-collapsed status used for the map lookup. */
  statusKey: string
  tonu: boolean
  /** Salesrep id with all-digit codes left-padded to 3 (`10` -> `010`). */
  salesrepId: string
  referenceNo: string
  customerRefNo: string
  containerNo: string
  pickupRefNo: string
  consigneeRefNo: string
  carrierRefNo: string
  additionalRefs: string[]
  customer: CanonicalParty
  billTo: CanonicalParty
  dates: CanonicalDates
  junkDates: JunkDate[]
  stops: CanonicalStop[]
  /** Lines with any content, in line order (line 1 is the line haul). */
  charges: CanonicalCharge[]
  accessorialPairs: CanonicalAccessorialPair[]
  /** Null when the row names no carrier. */
  carrier: CanonicalCarrier | null
  money: CanonicalMoney
  payments: CanonicalPayment[]
  projectedExpenses: CanonicalProjectedExpense[]
  paidExpenses: CanonicalPaidExpense[]
  commissions: CanonicalCommission[]
  freight: CanonicalFreight
  staff: CanonicalStaff
  /** Memo rows only: the signed memo amount as exported text (note-only, DECIDED-4), plus its cents for the cross-check. */
  memoAmountText: string | null
  memoAmountCents: number | null
  /** Memo rows only (DECIDED-1): the AR adjustment this row represents; null on loads. */
  memo: CanonicalMemo | null
  quoteNo: string
  manifest: string
  /** Customer CRM field (Customer.leadSource). */
  leadSource: string
  /** Raw `Currency`; anything but ''/USD also warns CURRENCY_NOT_USD. */
  currency: string
  /** OSD flag (over/short/damaged). */
  osd: boolean
  /** Raw-only columns (kept in the legacy row, not promoted). */
  office: string
  officeCoveredBy: string
  originRegion: string
  destinationRegion: string
  /** Non-blocking findings. */
  warnings: RowWarning[]
  /** Blocking row-level errors (the row is not applied): ROW_TOO_LONG, MONEY_INVALID, MONEY_OVERFLOW, ... */
  errors: RowWarning[]
  /**
   * EVERY non-empty source cell, verbatim (not cleaned): `{ c7: { h: 'Customer Name', v: '...' } }`
   * (1-based position). Exactly the stored `LegacyAljexRow.fields`; read back with `./rawRow`.
   */
  raw: RawFields
}
