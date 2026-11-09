import { TmsBadge } from '@/features/tms/kit'
import { VERIFY_PAYMENT_LABEL, VERIFY_PAYMENT_NOTE, isVerifyPaymentBill } from '@/lib/verifyPayment'

/** Orange "Verify payment" badge on the bills Ryne has not paid although Aljex says paid. Renders nothing otherwise. */
export function VerifyPaymentBadge({ bill }: { bill: { shipmentNumber?: string | null; status?: string | null } }) {
  if (!isVerifyPaymentBill(bill)) return null
  return <> <TmsBadge tone="orange" title={VERIFY_PAYMENT_NOTE}>{VERIFY_PAYMENT_LABEL}</TmsBadge></>
}
