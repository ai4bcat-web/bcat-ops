/**
 * Step AG — shared builders for the unit tests of S1 and the Lambda tests of S3/S4 (and the §6.6
 * worked-example table). Pure data; no assertions.
 */
import type { ApExtraction, Ledger, LedgerAssignment, LedgerBill, LedgerCarrier, LedgerVendorPayable } from './types'

export const FX_CARRIER: LedgerCarrier = {
  id: 'car-1',
  name: 'Swift Haul LLC',
  mcNumber: '123456',
  dotNumber: '7654321',
  remitToName: 'Swift Haul LLC',
}

export const FX_OTHER_CARRIER: LedgerCarrier = { id: 'car-2', name: 'Blue Ridge Freight Inc', mcNumber: '999888', dotNumber: '1112223' }

export function fxBill(over: Partial<LedgerBill> = {}): LedgerBill {
  return {
    id: 'bill-1',
    status: 'IN_REVIEW',
    version: 3,
    loadCarrierId: 'lc-1',
    loadId: 'load-1',
    shipmentId: 'shp-1',
    shipmentNumber: 'S000101-1',
    loadNumber: 'S000101-1',
    aljexId: null,
    carrierId: FX_CARRIER.id,
    carrierName: FX_CARRIER.name,
    carrierMc: FX_CARRIER.mcNumber,
    billNumber: null,
    billDate: '2026-11-01',
    billMonth: '2026-11',
    dueAt: '2026-12-01',
    termsDays: 30,
    billedCents: 150_000,
    grossCents: 150_000,
    paidCents: 0,
    creditedCents: 0,
    ...over,
  }
}

export function fxAssignment(over: Partial<LedgerAssignment> = {}): LedgerAssignment {
  return {
    loadCarrierId: 'lc-9',
    loadId: 'load-9',
    shipmentId: 'shp-9',
    shipmentNumber: 'S000109-1',
    carrierId: FX_CARRIER.id,
    carrierName: FX_CARRIER.name,
    rateCents: 150_000,
    ...over,
  }
}

export function fxVendor(over: Partial<LedgerVendorPayable> = {}): LedgerVendorPayable {
  return { id: 'vp-1', status: 'NEED_TO_PAY', vendor: 'Acme Tire Co', invoiceNumber: 'AT-7781', invoiceDate: null, dueDate: null, amount: 48_000, ...over }
}

export function fxLedger(over: Partial<Ledger> = {}): Ledger {
  return {
    bills: [fxBill()],
    assignments: [],
    vendorPayables: [],
    carriers: { [FX_CARRIER.id]: FX_CARRIER, [FX_OTHER_CARRIER.id]: FX_OTHER_CARRIER },
    ...over,
  }
}

/** A clean, high-confidence carrier invoice for fxBill(): PRO + MC + amount all line up. */
export function fxExtraction(over: Partial<ApExtraction> = {}): ApExtraction {
  return {
    kind: 'INVOICE',
    confidence: 'high',
    reason: 'Carrier invoice',
    issuer: { name: null, kind: 'CARRIER', mc: '123456', dot: null },
    pros: ['S0001011'],
    otherRefs: [],
    invoiceNumber: 'SH-5521',
    invoiceDate: '2026-11-03',
    dueDate: '2026-12-03',
    termsDays: 30,
    amountCents: 150_050,
    remitTo: null,
    notes: null,
    lowConfidence: [],
    ...over,
  }
}
