/**
 * The Invoicing summary strip (Ryne, 2026-11-12), shown above every tab: what is pending with OTR
 * vs with shippers, late money, days to pay for factoring vs shippers over a recent window, and
 * open AR by revenue division / sub-division. Pure: the page passes what it has read.
 */
import { daysLate, isImportedInvoice } from '@/lib/arAging'
import type { FactoringItem } from '@/types'
import type { InvoiceRecord, ShipmentRecord } from '@/types/tms'

export const PAY_WINDOW_DAYS = 90

export interface ArDivisionSlice {
  /** `DIVISION` or `DIVISION/SUB`, the value the list filters on. */
  key: string
  label: string
  cents: number
}

export interface ArSummary {
  pendingOtrCents: number
  pendingShippersCents: number
  lateCents: number
  otrDaysToPay: number | null
  shipperDaysToPay: number | null
  byDivision: ArDivisionSlice[]
}

const DAY_MS = 86_400_000
const dayMs = (iso: string | null | undefined): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
const mean = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)

export function isFactored(inv: InvoiceRecord): boolean {
  return Boolean(inv.factored || inv.factoringItemId)
}

/** `BROKERAGE` or `ASSETS/LOCAL`: the slice a shipment's open money counts toward. */
export function divisionKeyOf(shipment: Pick<ShipmentRecord, 'revDivision' | 'revSubdivision'> | null | undefined): string {
  const d = shipment?.revDivision ?? 'NONE'
  return shipment?.revSubdivision ? `${d}/${shipment.revSubdivision}` : d
}

export function computeArSummary(input: {
  open: InvoiceRecord[]
  paid: InvoiceRecord[]
  factorByItemId: Map<string, FactoringItem>
  shipmentsById: Map<string, ShipmentRecord>
  divisionName: (code: string | null | undefined) => string
  asOf: string
}): ArSummary {
  const { open, paid, factorByItemId, shipmentsById, divisionName, asOf } = input
  let pendingOtrCents = 0
  let pendingShippersCents = 0
  let lateCents = 0
  const slices = new Map<string, ArDivisionSlice>()
  for (const inv of open) {
    if (inv.status !== 'ISSUED' && inv.status !== 'PARTIAL') continue
    if (isFactored(inv)) pendingOtrCents += inv.balanceCents
    else pendingShippersCents += inv.balanceCents
    if (inv.dueAt && daysLate(inv.dueAt, asOf) > 0) lateCents += inv.balanceCents
    const shipment = shipmentsById.get(inv.shipmentId)
    const key = divisionKeyOf(shipment)
    const label = shipment?.revSubdivision
      ? `${divisionName(shipment.revDivision)} · ${divisionName(shipment.revSubdivision)}`
      : shipment?.revDivision ? divisionName(shipment.revDivision) : 'No division'
    const slice = slices.get(key) ?? { key, label, cents: 0 }
    slice.cents += inv.balanceCents
    slices.set(key, slice)
  }

  const since = (dayMs(asOf) ?? 0) - PAY_WINDOW_DAYS * DAY_MS
  const otr: number[] = []
  const shippers: number[] = []
  for (const inv of paid) {
    if (inv.status !== 'PAID' || isImportedInvoice(inv)) continue
    const paidAt = dayMs(inv.paidAt)
    if (paidAt == null || paidAt < since) continue
    if (isFactored(inv)) {
      // Factoring: submitted to OTR → funded.
      const item = inv.factoringItemId ? factorByItemId.get(inv.factoringItemId) : undefined
      const from = dayMs(item?.otrSubmittedAt)
      const to = dayMs((item as { factoredAt?: string | null } | undefined)?.factoredAt) ?? paidAt
      if (from != null && to >= from) otr.push((to - from) / DAY_MS)
    } else {
      // Shippers: invoice date → paid.
      const from = dayMs(inv.invoiceDate)
      if (from != null && paidAt >= from) shippers.push((paidAt - from) / DAY_MS)
    }
  }
  return {
    pendingOtrCents,
    pendingShippersCents,
    lateCents,
    otrDaysToPay: mean(otr),
    shipperDaysToPay: mean(shippers),
    byDivision: [...slices.values()].sort((a, b) => b.cents - a.cents),
  }
}
