/**
 * Pure per-row derivations shared by STAGE (carrier activity, open-bill promotion) and the load
 * aggregate builder: effective status, division, mode, and the carrier-side AP facts.
 */
import type { LoadWorkflowStatus, ShipmentMode, ShipmentStatus } from '../../../../src/types/tms'
import type { CanonicalPaidExpense, CanonicalRow } from '../../../../src/lib/aljex/canonical'
import { hasInvoice, isOwnAssetCarrier, pickDivision, typeEntry } from '../../../../src/lib/aljex/classify'
import { resolvePickupDate, type DateWindow } from '../../../../src/lib/aljex/dates'
import { normalizeLabel, type AljexProfile, type RevDivisionCode, type StatusMapEntry } from '../../../../src/lib/aljex/profile'
import { mapStatus } from '../../../../src/lib/aljex/status'

const OPEN_ENTRY: StatusMapEntry = { shipment: 'OPEN', load: 'SOURCING', inFlight: true }
const DELIVERED_ENTRY: StatusMapEntry = { shipment: 'DELIVERED', load: 'DELIVERED', delivered: true }

export interface EffectiveStatus {
  entry: StatusMapEntry
  /** The row's status was not in the profile (only reachable when the owner accepted it). */
  unmapped: boolean
  /** An invoiced load whose status was pre-delivery: forced to DELIVERED (§7.1). */
  forcedDelivered: boolean
}

export function effectiveStatus(row: CanonicalRow, profile: AljexProfile): EffectiveStatus {
  const mapped = mapStatus(row.statusKey, profile)
  const entry = mapped ?? OPEN_ENTRY
  if (!entry.void && !entry.delivered && hasInvoice(row)) return { entry: DELIVERED_ENTRY, unmapped: !mapped, forcedDelivered: true }
  return { entry, unmapped: !mapped, forcedDelivered: false }
}

export interface ApLine {
  name: string
  gl: string
  amountCents: number
  date: string | null
  checkNo: string
}

export interface ApFacts {
  /** Carrier cost on the load (Σ projected-expense lines; the column when no lines). */
  carrierTotalCents: number
  /** Paid entries that are payments to the carrier (name equals the carrier, or GL 4400/4445). */
  carrierPayments: ApLine[]
  /** Paid entries that are neither: additional bill lines that are also paid. */
  extraLines: ApLine[]
  grossCents: number
  feeCents: number
  netCents: number
  /** Σ paid (carrier payments + extra lines), uncapped. */
  paidRawCents: number
  /** Paid applied to the bill (never above the net). */
  paidCents: number
  /** Overpayment kept as unapplied money on the AP payment. */
  unappliedCents: number
  balanceCents: number
  status: 'PAID' | 'PARTIAL' | 'TO_BE_PAID'
}

const FEE_GL = '7030'
const CARRIER_GLS = new Set(['4400', '4445'])

function toLine(p: CanonicalPaidExpense): ApLine {
  return { name: p.name, gl: p.gl, amountCents: p.amountCents, date: p.date, checkNo: p.checkNo }
}

/**
 * Carrier-side AP for a brokered, delivered load (§7.3). Rule (ALJEX_MAPPING D14): GL 7030 is the
 * quick-pay fee; an entry naming the carrier or carrying GL 4400/4445 is a payment to the carrier; any
 * other entry is an extra bill line that is also paid. Null when no bill applies.
 */
export function apFromRow(row: CanonicalRow, profile: AljexProfile, delivered: boolean): ApFacts | null {
  if (row.kind !== 'LOAD' || !row.carrier || isOwnAssetCarrier(row.carrier.name, profile) || !delivered) return null
  const lineTotal = row.projectedExpenses.reduce((s, p) => s + p.amountCents, 0)
  const carrierTotalCents = row.projectedExpenses.length > 0 ? lineTotal : row.money.projectedCarrierExpenseCents
  const actual = row.money.actualCarrierExpCents
  if (carrierTotalCents <= 0 && actual <= 0 && row.paidExpenses.length === 0) return null
  const carrierKey = normalizeLabel(row.carrier.name)
  const carrierPayments: ApLine[] = []
  const extraLines: ApLine[] = []
  let feeCents = 0
  for (const p of row.paidExpenses) {
    if (p.gl === FEE_GL) feeCents += Math.abs(p.amountCents)
    else if (CARRIER_GLS.has(p.gl) || normalizeLabel(p.name) === carrierKey) carrierPayments.push(toLine(p))
    else extraLines.push(toLine(p))
  }
  const extras = extraLines.reduce((s, l) => s + l.amountCents, 0)
  const grossCents = carrierTotalCents + extras
  const netCents = grossCents - feeCents
  const paidRawCents = carrierPayments.reduce((s, l) => s + l.amountCents, 0) + extras
  const paidCents = Math.max(0, Math.min(paidRawCents, Math.max(netCents, 0)))
  const unappliedCents = Math.max(0, paidRawCents - Math.max(netCents, 0))
  const balanceCents = Math.max(0, netCents - paidRawCents)
  const status = balanceCents === 0 ? 'PAID' : paidRawCents > 0 ? 'PARTIAL' : 'TO_BE_PAID'
  return { carrierTotalCents, carrierPayments, extraLines, grossCents, feeCents, netCents, paidRawCents, paidCents, unappliedCents, balanceCents, status }
}

export interface RowFacts {
  status: EffectiveStatus
  shipmentStatus: ShipmentStatus
  loadStatus: LoadWorkflowStatus
  isVoid: boolean
  delivered: boolean
  ownAsset: boolean
  division: RevDivisionCode
  mode: ShipmentMode
  tonu: boolean
  invoice: boolean
  ap: ApFacts | null
  pickupDate: string | null
  pickupSource: string
  unmappedType: boolean
}

export function rowFacts(row: CanonicalRow, profile: AljexProfile, window: DateWindow | null): RowFacts {
  const status = effectiveStatus(row, profile)
  const type = typeEntry(row, profile)
  const delivered = status.entry.delivered === true
  const pick = resolvePickupDate(row, window)
  return {
    status,
    shipmentStatus: status.entry.shipment,
    loadStatus: status.entry.load,
    isVoid: status.entry.void === true,
    delivered,
    ownAsset: row.kind === 'LOAD' && isOwnAssetCarrier(row.carrier?.name, profile),
    division: pickDivision(row, profile),
    mode: type?.mode ?? 'FTL',
    tonu: row.tonu || type?.tonu === true,
    invoice: hasInvoice(row) && status.entry.void !== true,
    ap: apFromRow(row, profile, delivered),
    pickupDate: pick.date,
    pickupSource: pick.source,
    unmappedType: type === null,
  }
}
