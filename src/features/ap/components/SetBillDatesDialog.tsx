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
import type { CarrierBillRecord } from '@/types/tms'

export function SetBillDatesDialog({ bill, open, onOpenChange, onDone }: {
  bill: CarrierBillRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const pending = bill.datesPending === true
  const [billNumber, setBillNumber] = useState(bill.billNumber ?? '')
  const [billDate, setBillDate] = useState(pending ? '' : bill.billDate)
  const [dueAt, setDueAt] = useState(pending ? '' : bill.dueAt)
  const [dueTouched, setDueTouched] = useState(!pending)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const problem = !billDate ? 'Enter the invoice date.'
    : !dueAt ? 'Enter the due date.'
    : dueAt < billDate ? 'The due date cannot be before the invoice date.'
    : null

  function changeBillDate(value: string) {
    setBillDate(value)
    // Until the due date is typed by hand it follows the invoice date by the carrier's terms.
    if (!dueTouched && value) setDueAt(billDueDate(value, bill.termsDays))
  }

  function save() {
    if (problem) return
    setSaving(true)
    setError(null)
    setBillDates({ billId: bill.id, billDate, dueAt, billNumber: billNumber.trim() || null })
      .then(() => { toast.success('Invoice and due dates saved'); onDone() })
      .catch((err: unknown) => setError(graphqlErrorText(err)))
      .finally(() => setSaving(false))
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${pending ? 'Set invoice and due dates' : 'Change dates'} — ${bill.carrierName ?? 'carrier'}`}
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
          <TmsInput aria-label="Due date" type="date" value={dueAt} onChange={(e) => { setDueTouched(true); setDueAt(e.target.value) }} />
        </TmsField>
      </div>
      {(error ?? (billDate || dueAt ? problem : null)) && (
        <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error ?? problem}</p>
      )}
    </TmsDialog>
  )
}
