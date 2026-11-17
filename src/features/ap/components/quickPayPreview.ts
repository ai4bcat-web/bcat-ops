import { billDueDate } from '@/lib/carrierBill'
import { AP_QUICK_PAY_OPTIONS, netPayable, quickPayFee } from '@/lib/quickPay'
import type { CarrierBillRecord } from '@/types/tms'

/**
 * What the dialog shows for a quick-pay choice: the discount, what we pay, and the due date it forces.
 * The server recomputes all of it; this is only the preview, from the same helpers.
 */
export function quickPayPreview(bill: Pick<CarrierBillRecord, 'grossCents'>, billDate: string, days: number | null) {
  const option = days ? AP_QUICK_PAY_OPTIONS.find((o) => o.days === days) ?? null : null
  if (!option) return null
  const feeCents = quickPayFee(bill.grossCents, option.feeBps)
  return {
    days: option.days,
    feePercent: option.feeBps / 100,
    feeCents,
    netCents: netPayable(bill.grossCents, feeCents),
    dueAt: billDate ? billDueDate(billDate, option.days) : '',
  }
}
