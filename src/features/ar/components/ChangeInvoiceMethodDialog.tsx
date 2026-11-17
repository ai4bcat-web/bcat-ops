/**
 * Change how an unsent invoice is billed: through the factor (OTR) or by hand (Ryne 2026-11-16: "can there be a link
 * on the factor that lets you change the method?"). Pick the method and whether the customer's profile follows or the
 * choice is for this invoice only; the dialog says what changes, then SET_INVOICE_METHOD does it. Nothing is e-mailed
 * and nothing goes to OTR — Factor and the e-mail step stay their own presses.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { graphqlErrorText, setInvoiceMethod } from '@/lib/apiClient'
import { currentInvoiceMethod, methodChangeBlocker, type InvoiceMethod } from '@/lib/invoiceMethod'
import { apEmailList } from '@/lib/apEmails'
import type { CustomerRecord, InvoiceRecord } from '@/types/tms'

const LABEL: Record<InvoiceMethod, string> = { FACTOR: 'Factor (OTR)', MANUAL: 'Manual invoice (e-mail to the customer)' }

export function ChangeInvoiceMethodDialog({ invoice, customer, factoringRow, onClose, onChanged }: {
  invoice: InvoiceRecord
  customer: CustomerRecord | undefined
  factoringRow?: { status?: string | null; otrInvoiceId?: string | null } | null
  onClose: () => void
  /** The invoice changed method; the page re-reads. */
  onChanged: (invoice: InvoiceRecord) => void
}) {
  const current = currentInvoiceMethod(invoice)
  const other: InvoiceMethod = current === 'FACTOR' ? 'MANUAL' : 'FACTOR'
  const [method, setMethod] = useState<InvoiceMethod>(other)
  const [scope, setScope] = useState<'customer' | 'invoice'>('customer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const blocker = methodChangeBlocker(invoice, factoringRow ?? null)
  const customerMethod = customer?.billingMethod ?? (customer?.factored ? 'FACTOR' : null)
  const noApEmail = method === 'MANUAL' && customer != null && apEmailList(customer).length === 0
  const customerName = customer?.name ?? invoice.customerName ?? 'this customer'

  const save = async () => {
    if (busy || blocker || (method === current && scope === 'invoice')) return
    setBusy(true)
    setError(null)
    try {
      const result = await setInvoiceMethod({ invoiceId: invoice.id, method, scope })
      toast.success(
        method === 'MANUAL'
          ? `Invoice ${invoice.number} is now a manual invoice${result.customerChanged ? ` and ${customerName} is billed by hand` : ''}`
          : `Invoice ${invoice.number} is now factored${result.customerChanged ? ` and ${customerName} is billed through OTR` : ''}`,
      )
      for (const warning of result.warnings) toast.warning(warning)
      onChanged(result.invoice)
      onClose()
    } catch (err) {
      setError(graphqlErrorText(err))
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`Change method · invoice ${invoice.number}`}
      description={blocker ?? `Now billed as ${LABEL[current]}. ${customerName}'s profile says ${customerMethod ? LABEL[customerMethod as InvoiceMethod] ?? customerMethod : 'nothing yet'}.`}
      footer={
        <>
          <TmsButton onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" data-testid="change-method-save" disabled={busy || Boolean(blocker) || (method === current && scope === 'invoice')} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Change method'}
          </TmsButton>
        </>
      }
    >
      {!blocker && (
        <div className="flex flex-col gap-3" data-testid="change-method-body">
          <fieldset className="flex flex-col gap-1">
            <legend className="tms-muted mb-1">Bill it as</legend>
            {(['FACTOR', 'MANUAL'] as const).map((m) => (
              <label key={m} className="flex items-center gap-2">
                <input type="radio" name="invoice-method" checked={method === m} onChange={() => setMethod(m)} />
                {LABEL[m]}{m === current ? ' (now)' : ''}
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="tms-muted mb-1">Apply to</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="invoice-method-scope" checked={scope === 'customer'} onChange={() => setScope('customer')} />
              {customerName}&apos;s profile too (its other unsent invoices follow)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="invoice-method-scope" checked={scope === 'invoice'} onChange={() => setScope('invoice')} />
              This invoice only (the profile stays as it is)
            </label>
          </fieldset>
          <p className="tms-muted" data-testid="change-method-effect">
            {method === 'MANUAL'
              ? 'The invoice stops being factored: it leaves the OTR queue and prints our remit-to, and you e-mail it to the customer from Ready to Invoice. Nothing is sent now.'
              : 'The invoice is addressed to the factor and queued for OTR (the checks Send to Factor always runs apply). Nothing is sent to OTR until you press Factor.'}
          </p>
          {noApEmail && <p style={{ color: 'var(--tms-badge-red)' }}>{customerName} has no AP e-mail on file; add one before you e-mail this invoice.</p>}
          {error && <p role="alert" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
        </div>
      )}
    </TmsDialog>
  )
}
