/**
 * The mark on a payable whose carrier invoice says a different amount than the payable. Internal only: it carries
 * carrier pay, so it appears on AP screens and never on anything a customer sees.
 */
import { TmsBadge } from '@/features/tms/kit'
import { amountMismatchCents } from '@/lib/billAmountMismatch'
import { formatCents } from '@/lib/invoiceBuild'
import type { CarrierBillRecord } from '@/types/tms'

export function AmountMismatchChip({ bill }: { bill: Pick<CarrierBillRecord, 'invoiceAmountCents' | 'grossCents'> }) {
  const diff = amountMismatchCents(bill)
  if (diff == null) return null
  return (
    <>
      {' '}
      <TmsBadge tone="red" title={`The carrier invoiced ${formatCents(bill.invoiceAmountCents ?? 0)}; the payable is ${formatCents(bill.grossCents)} (${diff > 0 ? '+' : '−'}${formatCents(Math.abs(diff))}). Check it before paying.`}>
        Amount mismatch
      </TmsBadge>
    </>
  )
}
