/**
 * Load Review rail fixes: where each editor lives and what OTR needs (Ryne 2026-11-16). Pure helpers shared by the rail
 * (ReviewFixPanel) and the review page, kept out of the component file for fast refresh.
 */
import { factorGapsForLoad, factoringPoNumber, routeEnds, FACTOR_GAP_LABEL } from '@/lib/factorReadyAtCreate'
import { isFactoredLoad } from '@/lib/factorBilling'
import { countsAsPresent } from '@/lib/shipmentDocuments'
import { stopsList } from '@/lib/stopPlace'
import type { CustomerRecord, ShipmentBundle } from '@/types/tms'
import type { Stop } from '@/types'

/** Where each rail section lives, so a reason or a review column can scroll straight to its editor. */
export const FIX_ANCHOR = {
  customer: 'lr-fix-customer',
  ref: 'lr-fix-ref',
  stops: 'lr-fix-stops',
  driver: 'lr-fix-driver',
  otr: 'lr-fix-otr',
  charges: 'lr-check-charges',
  documents: 'lr-check-documents',
  salesRep: 'lr-check-salesRep',
  revDivision: 'lr-check-revDivision',
} as const
export type FixAnchor = keyof typeof FIX_ANCHOR

/** A review column (LoadReviewFieldKey) to the rail section that fixes it. */
export const FIELD_ANCHOR: Record<string, FixAnchor> = {
  customerRef: 'ref', pod: 'documents', rateCon: 'documents', customerRate: 'charges', carrierRate: 'charges', profit: 'charges',
  salesRep: 'salesRep', revDivision: 'revDivision', delivered: 'stops', carrier: 'driver', customer: 'customer', invoiceMethod: 'customer', apEmail: 'customer', stops: 'stops',
}

/** A failing reason's old "open this tab" target, now the rail section that fixes it. */
export function anchorForReason(code: string, tab: string | null): FixAnchor {
  if (code === 'NO_CUSTOMER' || code === 'FACTOR_CUSTOMER_MC' || code === 'FACTOR_BILLING_METHOD') return 'customer'
  if (code === 'FACTOR_PO_MISSING' || code.startsWith('REFERENCE')) return 'ref'
  if (code === 'FACTOR_RATE_MISSING') return 'charges'
  if (code.startsWith('FACTOR_PICKUP') || code.startsWith('FACTOR_DELIVERY') || code === 'STOP_INCOMPLETE' || code === 'NOT_DELIVERED') return 'stops'
  if (code === 'CARRIER_NOT_ASSIGNED' || code === 'DRIVER_MISSING') return 'driver'
  switch (tab) {
    case 'documents': return 'documents'
    case 'financials': case 'carrierPay': return 'charges'
    case 'stops': case 'tracking': return 'stops'
    case 'carrier': return 'driver'
    default: return 'ref'
  }
}

export function scrollToFix(anchor: FixAnchor): void {
  const el = document.getElementById(FIX_ANCHOR[anchor])
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.classList.add('lr-fix-flash')
  window.setTimeout(() => el.classList.remove('lr-fix-flash'), 1600)
}

/** A load the bundle still counts (a voided one keeps its row but not its stops). */
export const liveLoad = (l: object): boolean => !(l as { voidedAt?: string | null; deletedAt?: string | null }).voidedAt && !(l as { deletedAt?: string | null }).deletedAt
export const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
export const ZIP = /^\d{5}(-?\d{4})?$/
export const STATE = /^[A-Za-z]{2}$/

/** One OTR requirement: ✓ or ✗, and the section that fixes it. */
export interface OtrCheck { key: string; label: string; ok: boolean; anchor: FixAnchor }

/** What OTR needs on this load: the booking fields factoring checks, then the POD and the rate confirmation. Empty unless factored. */
export function otrChecks(bundle: ShipmentBundle, customer: CustomerRecord | null): OtrCheck[] {
  // Brokered loads are never factored (Ryne 2026-11-16): no OTR section for them.
  const revDivision = (bundle.shipment as { revDivision?: string | null } | null | undefined)?.revDivision ?? null
  if (!isFactoredLoad(customer, revDivision)) return []
  const order = bundle.orders[0]
  const load = bundle.loads.find(liveLoad) ?? bundle.loads[0]
  const stops = bundle.loads.filter(liveLoad).flatMap((l) => stopsList<Stop>(l.stops))
  const gaps = new Set(factorGapsForLoad({
    customer: customer as never,
    poNumber: factoringPoNumber(order?.references as never, load?.tmsId ?? null),
    customerRateCents: order?.revenueCents ?? null,
    ...routeEnds(stops),
    revDivision,
  }).map((g) => g.code))
  const fields: { code: keyof typeof FACTOR_GAP_LABEL; anchor: FixAnchor }[] = [
    { code: 'BILLING_METHOD', anchor: 'customer' }, { code: 'CUSTOMER_MC', anchor: 'customer' }, { code: 'PO_MISSING', anchor: 'ref' },
    { code: 'RATE_MISSING', anchor: 'charges' },
    { code: 'PICKUP_CITY', anchor: 'stops' }, { code: 'PICKUP_STATE', anchor: 'stops' }, { code: 'PICKUP_ZIP', anchor: 'stops' },
    { code: 'DELIVERY_CITY', anchor: 'stops' }, { code: 'DELIVERY_STATE', anchor: 'stops' }, { code: 'DELIVERY_ZIP', anchor: 'stops' },
  ]
  const has = (type: string) => bundle.documents.some((d) => d.type === type && countsAsPresent(d))
  return [
    ...fields.map((f) => ({ key: f.code, label: FACTOR_GAP_LABEL[f.code], ok: !gaps.has(f.code), anchor: f.anchor })),
    { key: 'POD', label: 'POD on file', ok: has('POD'), anchor: 'documents' as const },
    { key: 'RATE_CON', label: 'Rate confirmation on file', ok: has('RATE_CON'), anchor: 'documents' as const },
  ]
}

