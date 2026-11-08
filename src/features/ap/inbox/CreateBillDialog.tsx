/**
 * Step AG §7.1: turn a queued invoice e-mail into a bill.
 *
 * Carrier invoice: pick the awaiting assignment (the suggested one is preselected) and hand
 * off to the existing Record-bill dialog — recording stays the human act it has always been.
 * Vendor invoice: a small confirm form → `AP_INBOX_CREATE_VENDOR_BILL`. Nothing here approves or pays.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { graphqlErrorText } from '@/lib/apiClient'
import { centsFromInput, inputFromCents } from '@/features/ar/components/money'
import type { ApWorklistRow } from '@/hooks/useApWorklist'
import type { ApInboxItemRecord } from '@/lib/apInbox/types'
import { apInboxCreateVendorBill } from './apInboxClient'

type Mode = 'CARRIER' | 'VENDOR'

export function CreateBillDialog({ item, assignments, onOpenChange, onRecord, onDone }: {
  item: ApInboxItemRecord
  assignments: readonly ApWorklistRow[]
  onOpenChange: (open: boolean) => void
  /** Open the Record-bill dialog for this assignment, prefilled from the e-mail. */
  onRecord: (loadCarrierId: string) => void
  onDone: () => void
}) {
  const x = item.extraction
  const top = item.match?.top
  const [mode, setMode] = useState<Mode>(x.issuer.kind === 'VENDOR' || top?.targetKind === 'VENDOR_PAYABLE' ? 'VENDOR' : 'CARRIER')
  const [assignment, setAssignment] = useState(top?.loadCarrierId ?? '')
  const [vendor, setVendor] = useState(x.issuer.name ?? item.fromName ?? '')
  const [invoiceNumber, setInvoiceNumber] = useState(x.invoiceNumber ?? '')
  const [invoiceDate, setInvoiceDate] = useState(x.invoiceDate ?? '')
  const [dueDate, setDueDate] = useState(x.dueDate ?? '')
  const [amount, setAmount] = useState(x.amountCents == null ? '' : inputFromCents(x.amountCents))
  const [description, setDescription] = useState(item.subject ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createVendor = () => {
    setSaving(true)
    setError(null)
    apInboxCreateVendorBill({
      itemId: item.id, vendor: vendor.trim(), invoiceNumber: invoiceNumber.trim(), invoiceDate, dueDate,
      amountCents: centsFromInput(amount), description: description.trim(),
    })
      .then(() => { toast.success('Vendor bill created from the e-mail'); onDone() })
      .catch((e: unknown) => { const t = graphqlErrorText(e); setError(t); toast.error(t) })
      .finally(() => setSaving(false))
  }

  return (
    <TmsDialog
      open
      onOpenChange={onOpenChange}
      title="Create bill from e-mail"
      description={`${x.issuer.name ?? item.fromEmail ?? 'E-mail'} · invoice ${x.invoiceNumber ?? '—'}`}
      footer={
        <>
          <TmsButton onClick={() => onOpenChange(false)} disabled={saving}>Cancel</TmsButton>
          {mode === 'CARRIER' ? (
            <TmsButton variant="primary" data-testid="ap-inbox-create-record" disabled={!assignment} onClick={() => onRecord(assignment)}>
              Record bill…
            </TmsButton>
          ) : (
            <TmsButton variant="primary" data-testid="ap-inbox-create-vendor" disabled={saving || !vendor.trim()} onClick={createVendor}>
              Create vendor bill
            </TmsButton>
          )}
        </>
      }
    >
      <div className="space-y-3" data-testid="ap-inbox-create-dialog">
        <div role="radiogroup" aria-label="Invoice kind" className="flex gap-4 text-sm">
          <label><input type="radio" name="ap-kind" checked={mode === 'CARRIER'} onChange={() => setMode('CARRIER')} /> Carrier invoice</label>
          <label><input type="radio" name="ap-kind" checked={mode === 'VENDOR'} onChange={() => setMode('VENDOR')} /> Vendor invoice</label>
        </div>
        {mode === 'CARRIER' ? (
          <TmsField label="Awaiting invoice" hint="The invoice PDF is already filed on the shipment as a pending carrier invoice; accept it under Documents review to clear the paperwork gate.">
            <TmsSelect
              aria-label="Assignment"
              value={assignment}
              placeholder="Choose the assignment…"
              options={assignments.map((a) => ({ value: a.loadCarrierId, label: `${a.carrierName} · ${a.shipmentNumber ?? a.loadCarrierId}` }))}
              onChange={(e) => setAssignment(e.target.value)}
            />
          </TmsField>
        ) : (
          <>
            <TmsField label="Vendor"><TmsInput value={vendor} onChange={(e) => setVendor(e.target.value)} /></TmsField>
            <TmsField label="Invoice #"><TmsInput value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} /></TmsField>
            <TmsField label="Invoice date"><TmsInput type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></TmsField>
            <TmsField label="Due date"><TmsInput type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></TmsField>
            <TmsField label="Amount ($)"><TmsInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></TmsField>
            <TmsField label="Description"><TmsInput value={description} onChange={(e) => setDescription(e.target.value)} /></TmsField>
          </>
        )}
        {error && <p className="text-sm" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsDialog>
  )
}
