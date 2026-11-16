/**
 * Change the customer on an issued invoice (Ryne 2026-11-16). Pick the right customer (and, if it has them, a
 * bill-to party), see exactly what changes — bill-to, AP e-mails, terms and due date, remit-to — and give a
 * reason. Saving moves the invoice in place (CHANGE_INVOICE_CUSTOMER: same number, same amount); nothing is
 * e-mailed. Then "Review & send" opens the normal send review addressed to the new customer.
 */
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { changeInvoiceCustomer, getTmsSettings, graphqlErrorText } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { invoiceCustomerChangeRefusal, planInvoiceCustomerChange, targetCustomerRefusal, type ChangeFactoringRow } from '@/lib/invoiceCustomerChange'
import type { CustomerRecord, InvoiceRecord, ShipmentRecord, TmsSettings } from '@/types/tms'
import { formatDay } from '../arViews'
import { manualRecipients } from '../sendReview'

const FACTORING_NOTE: Record<string, string> = {
  NONE: '',
  RETARGET: 'The factoring queue row stays and now names the new customer.',
  ARCHIVE: 'The new customer is billed by hand: the unsubmitted factoring row is parked and the invoice is no longer factored.',
  FACTOR_NEXT: 'The new customer is factored: use Factor to send it to OTR.',
}

export function ChangeInvoiceCustomerDialog({ invoice, customers, shipment, factoringRow, onClose, onChanged, onReviewSend }: {
  invoice: InvoiceRecord
  customers: readonly CustomerRecord[]
  shipment: ShipmentRecord | undefined
  factoringRow: ChangeFactoringRow | null
  onClose: () => void
  /** The invoice was moved; refresh lists. */
  onChanged: (invoice: InvoiceRecord) => void
  /** Open the normal send review for the moved invoice. Nothing is sent until Send is pressed there. */
  onReviewSend: (invoice: InvoiceRecord) => void
}) {
  const [query, setQuery] = useState('')
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [billToId, setBillToId] = useState<string>('')
  const [reason, setReason] = useState('')
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [moved, setMoved] = useState<InvoiceRecord | null>(null)

  useEffect(() => {
    let alive = true
    getTmsSettings().then((s) => { if (alive) setSettings(s) }).catch(() => undefined)
    return () => { alive = false }
  }, [])

  const blocked = invoiceCustomerChangeRefusal(invoice, factoringRow)
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return customers
      .filter((c) => c.id !== invoice.customerId && !(c as { mergedIntoId?: string | null }).mergedIntoId && c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8)
  }, [customers, query, invoice.customerId])
  const target = customerId ? customers.find((c) => c.id === customerId) : undefined
  const targetBlocked = target ? targetCustomerRefusal(invoice, target, billToId || null) : null
  const plan = target && !targetBlocked
    ? planInvoiceCustomerChange({
        invoice: invoice,
        target: target,
        billToId: billToId || null,
        revDivision: (shipment as { revDivision?: string | null } | undefined)?.revDivision ?? null,
        division: null,
        settings,
        factoringRow,
      })
    : null
  const recipients = target ? manualRecipients(target, settings) : { to: [], cc: [] }
  const remitLabel = plan
    ? (plan.factored ? (plan.remitTo.name || 'The factor (OTR)') : 'BCAT (the division’s own remit-to)')
    : ''

  async function save() {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const res = await changeInvoiceCustomer({ invoiceId: invoice.id, customerId: target.id, billToId: billToId || null, reason: reason.trim() })
      setMoved(res.invoice)
      onChanged(res.invoice)
      toast.success(`Invoice ${invoice.number} now bills ${target.name}`)
    } catch (err) {
      setError(graphqlErrorText(err) || 'Could not change the customer')
    } finally {
      setBusy(false)
    }
  }

  if (moved) {
    return (
      <TmsDialog
        open
        onOpenChange={(open) => { if (!open) onClose() }}
        title={`Invoice ${moved.number} moved to ${moved.customerName ?? target?.name ?? ''}`}
        description="Nothing was e-mailed. Review the invoice and send it to the new customer when it looks right."
        footer={
          <>
            <TmsButton variant="ghost" onClick={onClose}>Close</TmsButton>
            <TmsButton variant="primary" aria-label="Review and send" onClick={() => onReviewSend(moved)}>
              Review &amp; send to {moved.customerName ?? target?.name}
            </TmsButton>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {invoice.customerName} received the earlier version
          {(invoice.sentCount ?? 0) > 0 || invoice.sentAt ? '' : ' (it was never sent)'}; they are not notified.
        </p>
      </TmsDialog>
    )
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`Change customer · invoice ${invoice.number}`}
      description={`Billed now to ${invoice.customerName ?? '—'}. The invoice keeps its number, lines and ${formatCents(invoice.totalCents)} total.`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            aria-label="Change customer"
            disabled={busy || Boolean(blocked) || !plan || reason.trim().length === 0}
            onClick={() => void save()}
          >
            Change customer
          </TmsButton>
        </>
      }
    >
      {blocked ? (
        <p role="alert" className="text-sm text-destructive">{blocked}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <TmsField label="New customer" htmlFor="chg-cust-search">
            <TmsInput
              id="chg-cust-search"
              aria-label="Search customers"
              placeholder="Search customers…"
              value={target ? target.name : query}
              onChange={(e) => { setCustomerId(null); setBillToId(''); setQuery(e.target.value) }}
            />
          </TmsField>
          {!target && matches.length > 0 && (
            <ul role="listbox" aria-label="Matching customers" className="flex flex-col rounded border">
              {matches.map((c) => (
                <li key={c.id}>
                  <button type="button" className="w-full px-3 py-2 text-left hover:bg-muted" onClick={() => { setCustomerId(c.id); setQuery(c.name) }}>
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {target && (target.billToParties ?? []).length > 0 && (
            <TmsField label="Bill to" htmlFor="chg-cust-billto">
              <TmsSelect id="chg-cust-billto" value={billToId} onChange={(e) => setBillToId(e.target.value)}>
                <option value="">— {target.name} —</option>
                {(target.billToParties ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </TmsSelect>
            </TmsField>
          )}
          {targetBlocked && <p role="alert" className="text-sm text-destructive">{targetBlocked}</p>}
          {plan && (
            <dl aria-label="What changes" className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Bill to</dt><dd>{plan.billTo.name}</dd>
              <dt className="text-muted-foreground">AP e-mails</dt>
              <dd>{recipients.to.length > 0 ? recipients.to.join(', ') : <span className="text-destructive">None on file — add one before sending</span>}</dd>
              <dt className="text-muted-foreground">Terms</dt>
              <dd>{plan.termsText} · due {formatDay(plan.dueAt)}{invoice.dueAt && invoice.dueAt !== plan.dueAt ? ` (was ${formatDay(invoice.dueAt)})` : ''}</dd>
              <dt className="text-muted-foreground">Remit to</dt><dd>{remitLabel}</dd>
              <dt className="text-muted-foreground">Invoice #</dt><dd>{invoice.number} (unchanged){plan.sent ? ` · becomes Rev ${plan.revision}` : ''}</dd>
              {FACTORING_NOTE[plan.factoring] && (<><dt className="text-muted-foreground">Factoring</dt><dd>{FACTORING_NOTE[plan.factoring]}</dd></>)}
            </dl>
          )}
          <TmsField label="Reason" htmlFor="chg-cust-reason">
            <TmsTextarea id="chg-cust-reason" aria-label="Reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </TmsField>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
      )}
    </TmsDialog>
  )
}
