import { describe, expect, it } from 'vitest'
import { VERIFY_PAYMENT_PROS } from './verifyPaymentPros'
import { isVerifyPaymentBill, proKey } from './verifyPayment'
import { EMPTY_TO_BE_PAID_FILTERS, applyToBePaidFilters } from '@/features/ap/apViews'
import type { CarrierBillRecord } from '@/types/tms'

const listed = VERIFY_PAYMENT_PROS[0]

describe('verify-payment flag', () => {
  it('ships Ryne\'s 34 PROs', () => {
    expect(new Set(VERIFY_PAYMENT_PROS).size).toBe(34)
  })

  it('flags a listed PRO even with the legacy L prefix or padding, never a VOID bill or an unlisted PRO', () => {
    expect(isVerifyPaymentBill({ shipmentNumber: listed, status: 'PAID' })).toBe(true)
    expect(isVerifyPaymentBill({ shipmentNumber: `L${listed}  `, status: 'PARTIAL' })).toBe(true)
    expect(isVerifyPaymentBill({ shipmentNumber: listed, status: 'VOID' })).toBe(false)
    expect(isVerifyPaymentBill({ shipmentNumber: '99999999', status: 'PAID' })).toBe(false)
    expect(isVerifyPaymentBill({ shipmentNumber: null, status: 'PAID' })).toBe(false)
    expect(proKey(' L123 ')).toBe('123')
  })

  it('the To pay filter narrows to flagged bills and leaves everything when off', () => {
    const bills = [
      { id: 'a', shipmentNumber: listed, status: 'PARTIAL', dueAt: '2026-11-01' },
      { id: 'b', shipmentNumber: '99999999', status: 'TO_BE_PAID', dueAt: '2026-11-01' },
    ] as unknown as CarrierBillRecord[]
    expect(applyToBePaidFilters(bills, EMPTY_TO_BE_PAID_FILTERS, '2026-11-09').map((b) => b.id)).toEqual(['a', 'b'])
    expect(applyToBePaidFilters(bills, { ...EMPTY_TO_BE_PAID_FILTERS, verifyPayment: true }, '2026-11-09').map((b) => b.id)).toEqual(['a'])
  })
})
