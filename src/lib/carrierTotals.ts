/**
 * Several carriers on one load — the money and the pointers, as pure functions.
 *
 * One `LoadCarrier` row per assignment already; this file reads the live ones as a
 * list. A load with one ACTIVE row (or none) is a list of one and behaves exactly as
 * it did before: no migration, no stored aggregate.
 *
 * Money is integer cents. Every sum here is of already-rounded line amounts
 * (`chargeAmount` rounds once, at the line); nothing here divides except the
 * display-only margin in basis points.
 *
 * Imports are relative: the Lambdas bundle this file by path.
 */
import type { ApStatus, ChargeSide, LoadCarrierRecord } from '../types/tms'

/** The minimum of a stored carrier row these helpers read. */
export type CarrierLike = Pick<LoadCarrierRecord, 'id' | 'status'> & Partial<Pick<
  LoadCarrierRecord,
  'loadId' | 'sequence' | 'kind' | 'carrierName' | 'apStatus' | 'quickPay' | 'quickPayFeeCents'
>>

/** The minimum of a stored charge line these helpers read. */
export interface TotalsChargeLine {
  side: ChargeSide
  loadCarrierId?: string | null
  amountCents: number
  isRate: boolean
}

export interface CarrierTotalsRow {
  loadCarrierId: string
  name: string | null
  kind: 'OWN_ASSET' | 'CARRIER'
  /** Rate lines (LINEHAUL / FSC) tagged to this carrier. */
  linehaulCents: number
  /** Every other CARRIER line tagged to this carrier. */
  accessorialCents: number
  /** Gross: what the bill snapshots — linehaul plus accessorials. */
  totalCents: number
  hasRate: boolean
  quickPayFeeCents: number
  /** Gross minus the quick-pay fee: an AP deduction, never margin. */
  netCents: number
}

export interface CarrierTotals {
  perCarrier: CarrierTotalsRow[]
  /** CARRIER lines naming no carrier while two or more are counted. Zero otherwise. */
  untaggedCents: number
  /** Σ per-carrier gross + untagged. */
  totalCents: number
}

const bySequence = (a: CarrierLike, b: CarrierLike): number =>
  ((a.sequence ?? 0) - (b.sequence ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The ACTIVE rows of one load, in booking order. */
export function liveCarriersOf<T extends CarrierLike>(loadCarriers: readonly T[], loadId: string): T[] {
  return loadCarriers.filter((lc) => lc.status === 'ACTIVE' && String(lc.loadId ?? '') === loadId).sort(bySequence)
}

/** The lowest-sequence ACTIVE row: what `Load.activeLoadCarrierId` points at. */
export function primaryCarrierOf<T extends CarrierLike>(carriers: readonly T[]): T | null {
  return carriers.filter((lc) => lc.status === 'ACTIVE').sort(bySequence)[0] ?? null
}

/**
 * Per-carrier money. Counts ACTIVE and TONU rows (a TONU is paid money); BOUNCED
 * rows are skipped. A CARRIER line with no `loadCarrierId` is attributed to the
 * only counted carrier, as the single-carrier read rule always did, and surfaces as
 * `untaggedCents` when there are two or more.
 */
export function carrierTotals(
  charges: readonly TotalsChargeLine[],
  carriers: readonly CarrierLike[],
): CarrierTotals {
  const counted = carriers.filter((lc) => lc.status !== 'BOUNCED').sort(bySequence)
  const rows = new Map<string, CarrierTotalsRow>()
  for (const lc of counted) {
    const quickPayFeeCents = lc.quickPay === true ? Math.max(0, lc.quickPayFeeCents ?? 0) : 0
    rows.set(lc.id, {
      loadCarrierId: lc.id,
      name: lc.carrierName ?? null,
      kind: lc.kind === 'OWN_ASSET' ? 'OWN_ASSET' : 'CARRIER',
      linehaulCents: 0,
      accessorialCents: 0,
      totalCents: 0,
      hasRate: false,
      quickPayFeeCents,
      netCents: 0,
    })
  }
  const sole = counted.length === 1 ? counted[0].id : null
  let untaggedCents = 0
  for (const line of charges) {
    if (line.side !== 'CARRIER') continue
    const owner = line.loadCarrierId == null ? sole : String(line.loadCarrierId)
    const row = owner == null ? undefined : rows.get(owner)
    if (!row) {
      if (line.loadCarrierId == null) untaggedCents += line.amountCents
      continue
    }
    if (line.isRate) row.linehaulCents += line.amountCents
    else row.accessorialCents += line.amountCents
  }
  const perCarrier = [...rows.values()]
  let totalCents = untaggedCents
  for (const row of perCarrier) {
    row.totalCents = row.linehaulCents + row.accessorialCents
    row.hasRate = row.linehaulCents > 0
    row.netCents = row.totalCents - row.quickPayFeeCents
    totalCents += row.totalCents
  }
  return { perCarrier, untaggedCents, totalCents }
}

/**
 * Margin = customer total − Σ carrier GROSS. Never net of quick pay (an AP
 * deduction) and never the billed figure (a variance blocks approval instead).
 */
export function marginOf(input: { customerTotalCents: number; carrierGrossCents: number }): {
  marginCents: number
  marginBps: number
} {
  const marginCents = input.customerTotalCents - input.carrierGrossCents
  const marginBps = input.customerTotalCents === 0 ? 0 : Math.round((marginCents * 10000) / input.customerTotalCents)
  return { marginCents, marginBps }
}

const AP_ORDER: readonly ApStatus[] = ['AWAITING_INVOICE', 'IN_REVIEW', 'TO_BE_PAID', 'PAID']

/**
 * The least-advanced AP rung among the ACTIVE carriers (a missing rung reads as
 * AWAITING_INVOICE, as the release gate does); null when none is live.
 */
export function aggregateApStatus(carriers: readonly CarrierLike[]): ApStatus | null {
  let least: number | null = null
  for (const lc of carriers) {
    if (lc.status !== 'ACTIVE') continue
    const rung = lc.apStatus == null ? 0 : Math.max(0, AP_ORDER.indexOf(lc.apStatus))
    if (least == null || rung < least) least = rung
  }
  return least == null ? null : AP_ORDER[least]
}
