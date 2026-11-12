/**
 * The Load review drawer's charge editor, as data: the shipment's stored charge lines turned into editable drafts,
 * grouped into the customer side and one group per live carrier, priced with the same `computeFinancials` the
 * shipment editor and the server use, and turned back into the full-replace RECALC_CHARGES input.
 */
import { computeFinancials, isRateCode, priceCharges } from '@/lib/shipmentCharges'
import { liveCarriersOf, primaryCarrierOf } from '@/lib/carrierTotals'
import type { ChargeCalc, ChargeSide, LoadChargeInput, LoadCarrierRecord, ShipmentBundle } from '@/types/tms'

export interface ChargeDraft {
  /** Stored row id; absent on a line added here. */
  id?: string | null
  /** Stable React key (the id, or a generated one for a new line). */
  key: string
  side: ChargeSide
  orderId: string | null
  loadId: string | null
  loadCarrierId: string | null
  code: string
  label: string
  calculatedBy: ChargeCalc
  rateCents: number
  count: number | null
  release: string | null
  note: string | null
  sortOrder: number
}

export interface ChargeGroup {
  /** 'CUSTOMER', or the load carrier id. */
  key: string
  side: ChargeSide
  title: string
  loadCarrier: LoadCarrierRecord | null
  /** A recorded carrier bill names an exact number: these lines cannot change here. */
  locked: string | null
  lines: ChargeDraft[]
  totalCents: number
}

let seq = 0
export function newKey(): string {
  seq += 1
  return `new-${Date.now().toString(36)}-${seq}`
}

/** Every stored line as a draft, in the stored order. */
export function draftsOf(bundle: ShipmentBundle): ChargeDraft[] {
  return [...bundle.charges]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((c) => ({
      id: c.id,
      key: c.id,
      side: c.side,
      orderId: c.orderId ?? null,
      loadId: c.loadId ?? null,
      loadCarrierId: c.loadCarrierId ?? null,
      code: c.code,
      label: c.label ?? '',
      calculatedBy: c.calculatedBy,
      rateCents: c.rateCents,
      count: c.count ?? null,
      release: c.release ?? null,
      note: c.note ?? null,
      sortOrder: c.sortOrder ?? 0,
    }))
}

function ctxOf(bundle: ShipmentBundle) {
  const load = bundle.loads[0]
  return { miles: load?.miles ?? null, weightLbs: load?.weight ?? null }
}

/** Customer first, then each live carrier. An untagged carrier line belongs to the primary (the single-carrier read rule). */
export function groupsOf(bundle: ShipmentBundle, drafts: ChargeDraft[]): ChargeGroup[] {
  const load = bundle.loads[0]
  const live = load ? liveCarriersOf(bundle.loadCarriers, String(load.id)) : []
  const primary = primaryCarrierOf(live)
  const priced = priceCharges(drafts.map(asLine), ctxOf(bundle))
  const amountOf = new Map(drafts.map((d, i) => [d.key, priced[i]?.amountCents ?? 0]))
  const sum = (lines: ChargeDraft[]) => lines.reduce((total, line) => total + (amountOf.get(line.key) ?? 0), 0)
  const customer = drafts.filter((d) => d.side === 'CUSTOMER')
  const groups: ChargeGroup[] = [{ key: 'CUSTOMER', side: 'CUSTOMER', title: 'Charge customer', loadCarrier: null, locked: null, lines: customer, totalCents: sum(customer) }]
  for (const lc of live) {
    if (lc.kind === 'OWN_ASSET') continue
    const lines = drafts.filter((d) => d.side === 'CARRIER' && (d.loadCarrierId === lc.id || (d.loadCarrierId == null && primary?.id === lc.id)))
    groups.push({
      key: lc.id,
      side: 'CARRIER',
      title: `Pay ${lc.carrierName ?? 'carrier'}`,
      loadCarrier: lc,
      locked: lc.chargesFinalizedAt ? 'A carrier bill is recorded for this carrier, so its pay is fixed. Change it in AP.' : null,
      lines,
      totalCents: sum(lines),
    })
  }
  return groups
}

export function amountsOf(bundle: ShipmentBundle, drafts: ChargeDraft[]): Map<string, number> {
  const priced = priceCharges(drafts.map(asLine), ctxOf(bundle))
  return new Map(drafts.map((d, i) => [d.key, priced[i]?.amountCents ?? 0]))
}

export function totalsOf(bundle: ShipmentBundle, drafts: ChargeDraft[]) {
  const t = computeFinancials(drafts.map(asLine), ctxOf(bundle))
  return { revenueCents: t.revenueCents, costCents: t.costCents, profitCents: t.profitCents, marginBps: t.marginBps }
}

function asLine(d: ChargeDraft) {
  return { side: d.side, code: d.code, calculatedBy: d.calculatedBy, rateCents: d.rateCents, count: d.count, isRate: isRateCode(d.code), loadCarrierId: d.loadCarrierId }
}

/** A blank FLAT line for one group, tied to the order (customer) or the assignment (carrier). */
export function newLine(bundle: ShipmentBundle, group: Pick<ChargeGroup, 'side' | 'loadCarrier'>, sortOrder: number): ChargeDraft {
  const load = bundle.loads[0]
  return {
    key: newKey(),
    side: group.side,
    orderId: group.side === 'CUSTOMER' ? bundle.orders[0]?.id ?? null : null,
    loadId: load?.id ?? null,
    loadCarrierId: group.side === 'CARRIER' ? group.loadCarrier?.id ?? null : null,
    code: '',
    label: '',
    calculatedBy: 'FLAT',
    rateCents: 0,
    count: 1,
    release: null,
    note: null,
    sortOrder,
  }
}

/** The full RECALC_CHARGES set (both sides), or the first problem that would make the server refuse it. */
export function toRecalc(drafts: ChargeDraft[]): { ok: true; charges: LoadChargeInput[] } | { ok: false; message: string } {
  for (const d of drafts) {
    if (!d.code.trim()) return { ok: false, message: 'Every line needs a code (for example LINEHAUL, FSC or DETENTION).' }
    if (d.side === 'CARRIER' && d.rateCents < 0) return { ok: false, message: 'A carrier line cannot be negative.' }
  }
  return {
    ok: true,
    charges: drafts.map((d, i) => ({
      ...(d.id ? { id: d.id } : {}),
      side: d.side,
      orderId: d.orderId,
      loadId: d.loadId,
      loadCarrierId: d.loadCarrierId,
      code: d.code.trim().toUpperCase(),
      label: d.label.trim() || null,
      calculatedBy: d.calculatedBy,
      rateCents: Math.round(d.rateCents),
      count: d.count,
      isRate: isRateCode(d.code),
      release: d.release,
      sortOrder: i,
      note: d.note,
    })),
  }
}

/** Dollars typed in a box → cents (blank or junk = 0). */
export function centsFromInput(text: string): number {
  const n = Number(text.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}
