/**
 * Hard rule (Ryne, 2026-11-12): nothing a customer receives with an invoice or a statement may
 * show what we pay the carrier. Two checks, both run server-side before any send and shown in
 * the review:
 *   1. By type / origin: a carrier rate con, a carrier invoice or bill, a load summary (both
 *      sides' money), or anything our rate-con generator / carrier e-sign produced never goes.
 *   2. By content, on BCAT Logistics / brokerage invoices: the attached files' text is searched
 *      for the load's carrier pay amounts and carrier-pay wording.
 *
 * Pure and import-light: the finance Lambda bundles this file by relative path.
 */
import type { ShipmentDocumentRecord, ShipmentDocumentType } from '../types/tms'

/** Types that carry carrier money by definition. RATE_CON is ours to a carrier unless it is the customer's own (see invoiceDelivery `isCustomerRateCon`). */
const CARRIER_MONEY_TYPES: readonly ShipmentDocumentType[] = ['CARRIER_INVOICE', 'LOAD_SUMMARY']

export interface CarrierPayFlag {
  documentId: string | null
  name: string
  reason: string
}

/** Check 1: a document that can never reach a customer, whatever its audience says. */
export function carrierDocumentReason(
  doc: Pick<ShipmentDocumentRecord, 'type' | 'source' | 'orderId' | 'loadCarrierId'>,
  customerRateCon: boolean,
): string | null {
  if (CARRIER_MONEY_TYPES.includes(doc.type)) return `${doc.type === 'CARRIER_INVOICE' ? 'Carrier invoice' : 'Load summary'} shows carrier pay`
  if (doc.type === 'RATE_CON' || doc.type === 'CUSTOMER_RATE_CON') {
    if (!customerRateCon) return 'Carrier rate confirmation (shows carrier pay)'
  }
  if (doc.source === 'GENERATED' && doc.type === 'RATE_CON') return 'Generated carrier rate confirmation'
  if (doc.loadCarrierId != null && (doc.type === 'RATE_CON' || doc.type === 'CUSTOMER_RATE_CON')) return 'Filed in the Carrier section'
  return null
}

/** Every way a carrier pay amount may be printed: 1,470.00 / 1470.00 / $1,470 (whole dollars). */
export function carrierPayNeedles(amountsCents: readonly number[]): string[] {
  const out = new Set<string>()
  for (const cents of amountsCents) {
    if (!Number.isFinite(cents) || cents < 10000) continue // under $100: too common to mean anything
    const dollars = Math.floor(cents / 100)
    const fraction = String(cents % 100).padStart(2, '0')
    const grouped = dollars.toLocaleString('en-US')
    out.add(`${grouped}.${fraction}`)
    out.add(`${dollars}.${fraction}`)
    if (fraction === '00') {
      out.add(`$${grouped}`)
      out.add(`$${dollars}`)
      out.add(`$ ${grouped}`)
    }
  }
  return [...out]
}

const CARRIER_PAY_WORDING = /\b(carrier\s+pay|pay\s+(?:to\s+)?carrier|carrier\s+rate|carrier\s+total|total\s+carrier\s+pay|amount\s+due\s+(?:to\s+)?carrier)\b/i

/**
 * Check 2: does this text show carrier pay? Returns the reason, or null. An amount only counts
 * when it is not also the customer's own charge (the same number on both sides proves nothing).
 */
export function carrierPayInText(text: string, carrierAmountsCents: readonly number[], customerAmountsCents: readonly number[] = []): string | null {
  if (!text) return null
  const wording = CARRIER_PAY_WORDING.exec(text)
  if (wording) return `mentions "${wording[0]}"`
  const customer = new Set(customerAmountsCents)
  const needles = carrierPayNeedles(carrierAmountsCents.filter((c) => !customer.has(c)))
  const compact = text.replace(/\s+/g, ' ')
  for (const needle of needles) {
    // Whole-number match: 1,470.00 must not hit 11,470.00.
    const at = compact.indexOf(needle)
    if (at >= 0) {
      const before = compact[at - 1] ?? ' '
      const after = compact[at + needle.length] ?? ' '
      if (!/[0-9,]/.test(before) && !/[0-9]/.test(after)) return `shows the carrier pay amount ${needle}`
    }
  }
  return null
}

/** The carrier side's amounts on one order's loads: each line, each carrier's total, the overall total. */
export function carrierPayAmounts(
  charges: readonly { side: string; amountCents: number; loadCarrierId?: string | null; loadId?: string | null; status?: string | null }[],
  loadIds?: readonly string[] | null,
): number[] {
  const mine = charges.filter((c) => c.side === 'CARRIER' && c.status !== 'VOID' && (!loadIds || !c.loadId || loadIds.includes(c.loadId)))
  const byCarrier = new Map<string, number>()
  let total = 0
  const out = new Set<number>()
  for (const c of mine) {
    out.add(c.amountCents)
    total += c.amountCents
    const key = c.loadCarrierId ?? '-'
    byCarrier.set(key, (byCarrier.get(key) ?? 0) + c.amountCents)
  }
  for (const v of byCarrier.values()) out.add(v)
  out.add(total)
  return [...out].filter((c) => c > 0)
}

export function customerChargeAmounts(
  charges: readonly { side: string; amountCents: number; status?: string | null }[],
): number[] {
  const mine = charges.filter((c) => c.side === 'CUSTOMER' && c.status !== 'VOID')
  const out = new Set<number>(mine.map((c) => c.amountCents))
  out.add(mine.reduce((sum, c) => sum + c.amountCents, 0))
  return [...out]
}
