/**
 * The carrier's invoice date, due date and invoice number for a bill that is still in review.
 *
 * Moving a load to billing creates the bill with placeholder dates (`datesPending`); this is where AP
 * enters the real ones from the carrier's invoice, and saving clears the pending flag so the bill can be
 * approved. For a bill that already has real dates it corrects them. The inputs start empty while the
 * dates are pending, so a placeholder can never be saved by pressing Enter.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { graphqlErrorText, setBillDates } from '@/lib/apiClient'
import { billDueDate } from '@/lib/carrierBill'
import { formatCents } from '@/lib/invoiceBuild'
import { AP_QUICK_PAY_OPTIONS } from '@/lib/quickPay'
import { quickPayPreview } from './quickPayPreview'
import type { CarrierBillRecord } from '@/types/tms'

export function SetBillDatesDialog({ bill, open, onOpenChange, onDone }: {
  bill: CarrierBillRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const pending = bill.datesPending === true
  // A bill already on quick pay carries the quick-pay days as its terms; the standard terms behind it are Net 30.
  const standardDays = bill.quickPay === true ? 30 : bill.termsDays || 30
  const currentQuickPay = bill.quickPay === true && AP_QUICK_PAY_OPTIONS.some((o) => o.days === bill.quickPayDays) ? bill.quickPayDays ?? null : null
  const factored = bill.payeeKind === 'FACTOR'
  const [quickPayDays, setQuickPayDays] = useState<number | null>(factored ? null : currentQuickPay)
  const [billNumber, setBillNumber] = useState(bill.billNumber ?? '')
  const [billDate, setBillDate] = useState(pending ? '' : bill.billDate)
  const [dueAt, setDueAt] = useState(pending ? '' : bill.dueAt)
  const [dueTouched, setDueTouched] = useState(!pending)
  const preview = quickPayPreview(bill, billDate, quickPayDays)
  const shownDue = preview?.dueAt || dueAt
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const problem = !billDate ? 'Enter the invoice date.'
    : !shownDue ? 'Enter the due date.'
    : shownDue < billDate ? 'The due date cannot be before the invoice date.'
    : null

  function changeBillDate(value: string) {
    setBillDate(value)
    // Until the due date is typed by hand it follows the invoice date by the carrier's terms.
    if (!dueTouched && value) setDueAt(billDueDate(value, standardDays))
  }

  function chooseQuickPay(days: number | null) {
    setQuickPayDays(days)
    // Back on standard terms the due date returns to the invoice date plus the terms, unless typed by hand.
    if (!days && !dueTouched && billDate) setDueAt(billDueDate(billDate, standardDays))
  }

  function save() {
    if (problem) return
    setSaving(true)
    setError(null)
    // Quick pay is only sent when the choice differs from what the bill already has, so a plain date
    // correction on a bill leaves its terms alone.
    const quickPayChanged = quickPayDays !== currentQuickPay
    setBillDates({
      billId: bill.id,
      billDate,
      dueAt: shownDue,
      billNumber: billNumber.trim() || null,
      ...(quickPayChanged ? { quickPayDays } : {}),
    })
      .then(() => { toast.success('Invoice and due dates saved'); onDone() })
      .catch((err: unknown) => setError(graphqlErrorText(err)))
      .finally(() => setSaving(false))
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${pending ? 'Add invoice date' : 'Change dates'} — ${bill.carrierName ?? 'carrier'}`}
      footer={(
        <>
          <TmsButton variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</TmsButton>
          <TmsButton variant="primary" disabled={saving || problem != null} onClick={save}>Save dates</TmsButton>
        </>
      )}
    >
      <p className="tms-muted">
        {pending
          ? `Created when load ${bill.shipmentNumber ?? bill.loadNumber ?? ''} moved to billing. Enter the dates from the carrier's invoice; the bill can't be approved until they are set.`
          : 'Correct the dates on the carrier’s invoice. Once the bill is approved, send it back to review first.'}
      </p>
      <div className="tms-grid tms-grid-3">
        <TmsField label="Their invoice #">
          <TmsInput aria-label="Carrier invoice number" value={billNumber} placeholder="as printed" onChange={(e) => setBillNumber(e.target.value)} />
        </TmsField>
        <TmsField label="Invoice date">
          <TmsInput aria-label="Invoice date" type="date" value={billDate} onChange={(e) => changeBillDate(e.target.value)} />
        </TmsField>
        <TmsField label="Due date">
          <TmsInput aria-label="Due date" type="date" value={shownDue} readOnly={preview != null} onChange={(e) => { setDueTouched(true); setDueAt(e.target.value) }} />
        </TmsField>
      </div>
      <p className="tms-muted text-xs mt-1">
        {preview ? `Quick pay sets the due date to ${preview.days} days after the invoice date.` : `Due date starts ${standardDays} days after the invoice date; change it if the invoice says otherwise.`}
      </p>
      <fieldset className="mt-3" aria-label="Quick pay" disabled={factored}>
        <legend className="tms-label">Quick pay</legend>
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-1 text-sm">
            <input type="radio" name="quickPay" checked={quickPayDays == null} onChange={() => chooseQuickPay(null)} />
            No quick pay
          </label>
          {AP_QUICK_PAY_OPTIONS.map((o) => (
            <label key={o.days} className="flex items-center gap-1 text-sm">
              <input type="radio" name="quickPay" checked={quickPayDays === o.days} onChange={() => chooseQuickPay(o.days)} />
              {o.days}-day quick pay (−{o.feeBps / 100}%)
            </label>
          ))}
        </div>
        {factored && <p className="tms-muted text-xs mt-1">Paid through a factor; quick pay does not apply.</p>}
        {preview && (
          <dl className="grid grid-cols-2 gap-x-4 text-sm mt-2" aria-label="Quick pay amounts">
            <dt>Carrier pay</dt><dd className="text-right tabular-nums">{formatCents(bill.grossCents)}</dd>
            <dt>Quick pay discount ({preview.feePercent}%)</dt><dd className="text-right tabular-nums">−{formatCents(preview.feeCents)}</dd>
            <dt className="font-medium">Amount to pay</dt><dd className="text-right tabular-nums font-medium">{formatCents(preview.netCents)}</dd>
            <dt>Due</dt><dd className="text-right tabular-nums">{preview.dueAt}</dd>
          </dl>
        )}
      </fieldset>
      {(error ?? (billDate || dueAt ? problem : null)) && (
        <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error ?? problem}</p>
      )}
    </TmsDialog>
  )
}
