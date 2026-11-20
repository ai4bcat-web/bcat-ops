/**
 * The carrier's invoice date, due date, invoice number and invoice amount for a bill that is still in review.
 *
 * Moving a load to billing creates the bill with placeholder dates (`datesPending`); this is where AP
 * enters the real ones from the carrier's invoice, and saving clears the pending flag so the bill can be
 * approved. For a bill that already has real dates it corrects them. The inputs start empty while the
 * dates are pending, so a placeholder can never be saved by pressing Enter.
 *
 * The amount starts at what BCAT Ops has for the carrier. When the invoice says something else there are two ways to
 * go. "Update payable" moves the carrier's rate (and so the shipment's cost and the bill) before the dates are saved,
 * with a reason, so the bill lands in Aging with the right amount and the right dates. "Keep payable and flag" leaves
 * the payable alone and records the invoice's amount, so the bill carries an Amount mismatch chip until it is sorted out.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { centsFromInput, inputFromCents } from '@/features/ar/components/money'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { graphqlErrorText, setBillDates } from '@/lib/apiClient'
import { billDueDate } from '@/lib/carrierBill'
import { formatCents } from '@/lib/invoiceBuild'
import { AP_QUICK_PAY_OPTIONS } from '@/lib/quickPay'
import { amountMismatchCents } from '@/lib/billAmountMismatch'
import { applyInvoiceAmount, INVOICE_AMOUNT_REASONS } from '../applyInvoiceAmount'
import { quickPayPreview } from './quickPayPreview'
import type { CarrierBillRecord } from '@/types/tms'

const OTHER = 'Other'

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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A bill already flagged shows the invoice's amount, so correcting its dates keeps the flag.
  const [amountText, setAmountText] = useState(inputFromCents(bill.invoiceAmountCents ?? bill.grossCents))
  const [amountMode, setAmountMode] = useState<'flag' | 'update'>('flag')
  const [reason, setReason] = useState<string>(INVOICE_AMOUNT_REASONS[0])
  const [otherText, setOtherText] = useState('')
  // Set once the rate has been moved, so a retry after the dates failed does not move it twice.
  const [appliedCents, setAppliedCents] = useState<number | null>(null)

  const amountCents = centsFromInput(amountText)
  const currentCents = appliedCents ?? bill.grossCents
  const amountChanged = amountCents != null && amountCents > 0 && amountCents !== currentCents
  const deltaCents = amountCents != null ? amountCents - bill.grossCents : 0
  const flagging = amountChanged && amountMode === 'flag'
  const wasFlagged = amountMismatchCents(bill) != null
  const reasonText = reason === OTHER ? `${OTHER}: ${otherText.trim()}` : reason
  // The discount is shown on the amount being saved (the payable, which a flagged difference leaves alone).
  const owedCents = amountMode === 'update' && amountCents != null && amountCents > 0 ? amountCents : currentCents
  const preview = quickPayPreview({ grossCents: owedCents }, billDate, quickPayDays)
  const shownDue = preview?.dueAt || dueAt

  const problem = !billDate ? 'Enter the invoice date.'
    : !shownDue ? 'Enter the due date.'
    : shownDue < billDate ? 'The due date cannot be before the invoice date.'
    : (amountCents == null ? bill.grossCents > 0 || amountText.trim() !== '' : amountCents <= 0 && bill.grossCents > 0) ? 'Enter the amount on the carrier’s invoice.'
    : amountChanged && amountMode === 'update' && reason === OTHER && otherText.trim().length < 3 ? 'Say what the amount change is for.'
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
    // The amount goes first: the bill's quick-pay discount is worked out on the amount it ends up with.
    const amountStep = amountChanged && amountMode === 'update' && amountCents != null
      ? applyInvoiceAmount({ bill, targetCents: amountCents, reason: reasonText }).then(() => { setAppliedCents(amountCents) })
      : Promise.resolve()
    amountStep
      .then(() => setBillDates({
        billId: bill.id,
        billDate,
        dueAt: shownDue,
        billNumber: billNumber.trim() || null,
        ...(quickPayChanged ? { quickPayDays } : {}),
        // Sent only when it changes something: a new flag, or a flag that has to be cleared.
        ...(flagging && amountCents != null ? { invoiceAmountCents: amountCents } : wasFlagged || amountChanged ? { invoiceAmountCents: null } : {}),
      }))
      .then(() => { toast.success(flagging ? 'Dates saved; flagged Amount mismatch' : amountChanged ? 'Invoice amount and dates saved' : 'Invoice and due dates saved'); onDone() })
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
          <TmsButton variant="primary" disabled={saving || problem != null} onClick={save}>{amountChanged && amountMode === 'update' ? 'Save amount and dates' : 'Save dates'}</TmsButton>
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
      <div className="tms-grid tms-grid-3 mt-2">
        <TmsField label="Invoice amount">
          <TmsInput aria-label="Carrier invoice amount" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
        </TmsField>
        {amountChanged && amountMode === 'update' && (
          <TmsField label="Why it changed">
            <TmsSelect aria-label="Reason for amount change" value={reason} onChange={(e) => setReason(e.target.value)} className="w-full">
              {[...INVOICE_AMOUNT_REASONS].map((r) => <option key={r} value={r}>{r}</option>)}
            </TmsSelect>
          </TmsField>
        )}
        {amountChanged && amountMode === 'update' && reason === OTHER && (
          <TmsField label="Details">
            <TmsInput aria-label="Reason details" value={otherText} onChange={(e) => setOtherText(e.target.value)} />
          </TmsField>
        )}
      </div>
      <p className="tms-muted text-xs mt-1" aria-live="polite">
        {amountChanged
          ? `${formatCents(Math.abs(deltaCents))} ${deltaCents < 0 ? 'lower' : 'higher'} than BCAT Ops (${formatCents(bill.grossCents)}).`
          : `BCAT Ops has ${formatCents(currentCents)} for this carrier. Change it if the invoice says something else.`}
      </p>
      {amountChanged && (
        <fieldset className="mt-2" aria-label="When the invoice amount differs">
          <legend className="tms-label">The invoice does not match the payable</legend>
          <label className="flex items-start gap-1 text-sm">
            <input type="radio" name="amountMode" checked={amountMode === 'flag'} onChange={() => setAmountMode('flag')} />
            <span>Keep payable and flag. The payable stays {formatCents(bill.grossCents)} and the bill shows Amount mismatch until it is sorted out.</span>
          </label>
          <label className="flex items-start gap-1 text-sm">
            <input type="radio" name="amountMode" checked={amountMode === 'update'} onChange={() => setAmountMode('update')} />
            <span>Update payable to invoice amount. Moves the carrier’s rate to match, so the shipment’s cost and this bill agree.</span>
          </label>
        </fieldset>
      )}
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
            <dt>Carrier pay</dt><dd className="text-right tabular-nums">{formatCents(owedCents)}</dd>
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
