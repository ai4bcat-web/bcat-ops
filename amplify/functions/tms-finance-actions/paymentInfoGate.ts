/**
 * The server half of the "missing payment info" rule (Ryne 2026-11-19: do not let anyone pay a payee that has no
 * bank info). RECORD_AP_PAYMENT calls `assertBillsPayable` before it plans anything, so a screen that was left
 * open, an old tab or a direct call cannot post a payment against a bill whose payee cannot be paid. There is no
 * override.
 *
 * The rule itself is `paymentInfoGap` (src/lib/paymentInfo.ts), the same one the AP board flags rows with. The
 * method is read live, so fixing the payee's Payment methods clears the block at once. Only whether the bank
 * numbers are on file is read (the item carries a `bankCipher`); the numbers are never decrypted or returned here.
 */
import type { CarrierBillRecord, CarrierPaymentMethodRecord } from '../../../src/types/tms'
import { effectiveBillPayee } from '../../../src/lib/carrierBill'
import { paymentGapMessage, paymentInfoGap, type PaymentInfoFacts } from '../../../src/lib/paymentInfo'
import {
  CARRIER_BILL_TABLE_NAME,
  CARRIER_PAYMENT_METHOD_TABLE_NAME,
  CARRIER_TABLE_NAME,
  IDX_PAYMENT_METHODS_BY_CARRIER,
  getById,
  queryIndex,
  type Row,
} from './store'

const MAX_NAMED = 5

/**
 * Throws, naming each payee and what it lacks, when any of these bills' payee cannot be paid. Bills that are
 * missing, already paid or void are not this rule's business: the payment planner refuses those on its own.
 */
export async function assertBillsPayable(billIds: readonly string[]): Promise<void> {
  const carriers = new Map<string, Row | null>()
  const methodsByCarrier = new Map<string, CarrierPaymentMethodRecord[]>()
  const problems: string[] = []
  const seen = new Set<string>()

  for (const billId of new Set(billIds)) {
    const bill = (await getById(CARRIER_BILL_TABLE_NAME, billId)) as (CarrierBillRecord & Row) | null
    if (!bill || bill.status === 'PAID' || bill.status === 'VOID') continue
    if (!carriers.has(bill.carrierId)) carriers.set(bill.carrierId, await getById(CARRIER_TABLE_NAME, bill.carrierId))
    if (!methodsByCarrier.has(bill.carrierId)) {
      methodsByCarrier.set(
        bill.carrierId,
        (await queryIndex(CARRIER_PAYMENT_METHOD_TABLE_NAME, IDX_PAYMENT_METHODS_BY_CARRIER, 'carrierId', bill.carrierId)) as unknown as CarrierPaymentMethodRecord[],
      )
    }
    const carrier = carriers.get(bill.carrierId) as Parameters<typeof effectiveBillPayee>[1]
    const methods = methodsByCarrier.get(bill.carrierId) ?? []
    const { payee } = effectiveBillPayee(bill, carrier, methods)
    const live = methods.find((item) => item.id === payee.paymentMethodId) ?? null
    const frozen = payee.remitTo
    const method = live?.method ?? frozen?.method ?? null

    let bankOnFile = false
    if (method === 'ACH' && live) {
      const row = await getById(CARRIER_PAYMENT_METHOD_TABLE_NAME, live.id)
      bankOnFile = row?.bankCipher instanceof Uint8Array
    }
    const factor = live ? live.recipientType === 'FACTOR' : payee.kind === 'FACTOR'
    const liveAddress = live ? (factor ? live.factorAddress ?? live.remitToAddress : live.remitToAddress) : null
    const facts: PaymentInfoFacts = {
      method,
      bankOnFile,
      accountLast4: live?.accountLast4 ?? frozen?.accountLast4 ?? null,
      address: ((liveAddress ?? frozen?.address ?? (factor ? null : (carrier as { address?: PaymentInfoFacts['address'] } | null)?.address)) ?? null) as PaymentInfoFacts['address'],
      contact: live?.payeeEmail ?? frozen?.payeeEmail ?? null,
    }
    const gap = paymentInfoGap(facts)
    if (!gap) continue
    const payeeName = frozen?.name || bill.carrierName || 'This payee'
    // One line per payee and problem, not one per bill: the same factor on ten bills is one thing to fix.
    const key = `${payeeName}|${gap}`
    if (seen.has(key)) continue
    seen.add(key)
    problems.push(paymentGapMessage(gap, payeeName, method))
  }

  if (problems.length === 0) return
  const shown = problems.slice(0, MAX_NAMED).join(' ')
  const more = problems.length > MAX_NAMED ? ` And ${problems.length - MAX_NAMED} more payees.` : ''
  throw new Error(`Cannot record this payment. ${shown}${more}`)
}
