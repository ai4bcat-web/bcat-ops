/**
 * Fix & invoice manually — for a load OTR rejected (Ryne 2026-11-15).
 *
 * Says why OTR turned it down, then walks the three things the office does about it, in order:
 *   1. the customer profile: the AP e-mail(s) the invoice goes to and payment terms, saved through the
 *      ordinary customer save (the change and its reason land on the customer's History);
 *   2. Move to manual invoice: the existing server action — customer becomes Manual invoice, a factored
 *      invoice is voided, the load goes back to Ready to invoice, the queue row is archived;
 *   3. the invoice: generated with our remit-to, then the ordinary send review opens on it. Nothing is
 *      e-mailed until the person presses Send there.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsInput } from '@/features/tms/kit'
import { generateInvoice, getLoads, getShipment, graphqlErrorText, moveToManualInvoice, updateCustomer } from '@/lib/apiClient'
import { isValidEmail } from '@/lib/billingMethod'
import { apEmailStorage, apEmailTokens } from '@/lib/apEmails'
import { EmailChipsInput } from '@/features/directory/components/EmailChipsInput'
import { otrRejectionDetails } from '@/lib/otrRejection'
import type { FactoringItem } from '@/types'
import type { CustomerRecord, InvoiceRecord, ShipmentRecord } from '@/types/tms'
import { SendReviewCarousel } from '@/features/ar/components/SendReviewCarousel'

type StepState = 'todo' | 'busy' | 'done'

function StepHead({ n, title, state }: { n: number; title: string; state: StepState }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold">
      <span
        className="inline-flex size-6 items-center justify-center rounded-full text-xs"
        style={{ background: state === 'done' ? 'var(--tms-badge-green)' : 'var(--tms-border)', color: state === 'done' ? 'var(--tms-on-primary)' : undefined }}
        aria-hidden
      >
        {state === 'done' ? <Check size={14} /> : n}
      </span>
      {title}
      {state === 'busy' && <Loader2 size={14} className="animate-spin tms-muted" />}
    </h3>
  )
}

export function FixAndInvoiceDialog({ item, customers, isAdmin, onClose, onChanged }: {
  item: FactoringItem
  customers: readonly CustomerRecord[]
  isAdmin: boolean
  onClose: () => void
  /** The queue changed (row archived, customer saved): reload it. */
  onChanged: () => void
}) {
  const details = otrRejectionDetails(item)
  const [customerId, setCustomerId] = useState<string | null>(item.customerId ?? null)
  const [lookingUp, setLookingUp] = useState(!item.customerId && Boolean(item.loadId))
  const [saved, setSaved] = useState<CustomerRecord | null>(null)
  const customer = useMemo(
    () => saved ?? (customerId ? customers.find((c) => c.id === customerId) ?? null : null),
    [saved, customerId, customers],
  )

  // The row may not carry the customer; the load does.
  useEffect(() => {
    if (item.customerId || !item.loadId) return
    let alive = true
    getLoads([item.loadId])
      .then((loads) => { if (alive) setCustomerId(loads[0]?.customerId ?? null) })
      .catch(() => { /* step 1 says the customer was not found */ })
      .finally(() => { if (alive) setLookingUp(false) })
    return () => { alive = false }
  }, [item.customerId, item.loadId])

  const [step1, setStep1] = useState<StepState>('todo')
  const [step2, setStep2] = useState<StepState>('todo')
  const [step3, setStep3] = useState<StepState>('todo')
  const [error, setError] = useState<string | null>(null)
  const [orderId, setOrderId] = useState<string | null>(null)
  const [invoice, setInvoice] = useState<InvoiceRecord | null>(null)
  const [shipment, setShipment] = useState<ShipmentRecord | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)

  const reasonText = details?.headline ?? 'OTR rejected it'

  async function moveToManual() {
    setError(null)
    setStep2('busy')
    try {
      const r = await moveToManualInvoice({ factoringItemId: item.id })
      setOrderId(r.orderId)
      // The server switched the customer to Manual invoice; keep the local copy in step so the send review prints our remit-to.
      if (customer) setSaved({ ...customer, billingMethod: 'MANUAL', factored: false })
      setStep2('done')
      toast.success(`PRO ${r.proNumber} moved to manual invoice${r.voidedInvoice ? ` (factored invoice ${r.voidedInvoice} voided)` : ''}`)
      onChanged()
    } catch (e) {
      setStep2('todo')
      setError(graphqlErrorText(e) || 'Could not move it to manual invoice')
    }
  }

  async function createInvoice() {
    if (!orderId) return
    setError(null)
    setStep3('busy')
    try {
      const r = await generateInvoice({ orderId })
      setInvoice(r.invoice)
      setShipment(r.invoice.shipmentId ? await getShipment(r.invoice.shipmentId).catch(() => null) : null)
      setStep3('done')
      onChanged()
    } catch (e) {
      setStep3('todo')
      setError(graphqlErrorText(e) || 'Could not create the invoice')
    }
  }

  const customerById = useMemo(() => new Map(customer ? [[customer.id, customer]] : []), [customer])
  const shipmentsById = useMemo(() => new Map(shipment ? [[shipment.id, shipment]] : []), [shipment])

  if (reviewOpen && invoice) {
    return (
      <SendReviewCarousel
        invoices={[invoice]}
        customerById={customerById}
        shipmentsById={shipmentsById}
        isAdmin={isAdmin}
        onClose={() => setReviewOpen(false)}
        onDone={() => { onChanged(); onClose() }}
      />
    )
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && step1 !== 'busy' && step2 !== 'busy' && step3 !== 'busy') onClose() }}
      title={`Fix & invoice manually — PRO ${item.proNumber}`}
      className="tms-dialog-wide"
      footer={<TmsButton variant="ghost" onClick={onClose}>Close</TmsButton>}
    >
      <div className="flex flex-col gap-4 text-sm" data-testid="fix-invoice-dialog">
        <div className="flex items-start gap-2 p-2 tms-tint tms-tint-orange" data-testid="fix-invoice-reason">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-orange)' }} />
          <div className="flex flex-col gap-1">
            <strong>{reasonText}</strong>
            {details?.lines.map((l) => <span key={l}>{l}</span>)}
          </div>
        </div>

        <section className="flex flex-col gap-2">
          <StepHead n={1} title="Customer profile" state={step1} />
          {lookingUp ? (
            <p className="tms-muted">Finding the customer…</p>
          ) : !customer ? (
            <p style={{ color: 'var(--tms-badge-red)' }}>This row has no customer in BCAT Ops. Open the load and set its customer first.</p>
          ) : (
            <>
              <p><strong>{customer.name}</strong> · payment method {customer.billingMethod === 'MANUAL' ? 'Manual invoice' : customer.billingMethod === 'FACTOR' || customer.factored ? 'Factor' : 'not set'}{step2 !== 'done' && customer.billingMethod !== 'MANUAL' ? ' (step 2 changes it to Manual invoice)' : ''}</p>
              <CustomerForm
                key={customer.id}
                customer={customer}
                itemId={item.id}
                proNumber={item.proNumber}
                reasonText={reasonText}
                state={step1}
                setState={setStep1}
                setError={setError}
                onSaved={(next) => { setSaved(next); onChanged() }}
              />
            </>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <StepHead n={2} title="Move to manual invoice" state={step2} />
          <p className="tms-muted">
            {customer?.name ?? 'The customer'} becomes <strong>Manual invoice</strong> for every load from now on. A factored invoice on this load is voided and the load goes back to Ready to invoice. The reason is written on the customer&rsquo;s History.
          </p>
          {step2 !== 'done' && (
            <div>
              <TmsButton variant="primary" size="sm" onClick={moveToManual} disabled={step1 !== 'done' || step2 === 'busy'} data-testid="fix-move-manual">
                Move to manual invoice
              </TmsButton>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <StepHead n={3} title="Send the invoice" state={step3} />
          <p className="tms-muted">Creates the invoice with BCAT&rsquo;s remit-to and opens the send review: you see the PDF and the whole e-mail, and nothing goes until you press Send there.</p>
          <div className="flex flex-wrap gap-2">
            {step3 !== 'done' && (
              <TmsButton variant="primary" size="sm" onClick={createInvoice} disabled={step2 !== 'done' || step3 === 'busy'} data-testid="fix-create-invoice">
                Create invoice
              </TmsButton>
            )}
            {invoice && (
              <TmsButton variant="primary" size="sm" onClick={() => setReviewOpen(true)} data-testid="fix-send-now">
                Send invoice {invoice.number} now
              </TmsButton>
            )}
          </div>
        </section>

        {error && <p role="alert" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsDialog>
  )
}

function CustomerForm({ customer, itemId, proNumber, reasonText, state, setState, setError, onSaved }: {
  customer: CustomerRecord
  itemId: string
  proNumber: string
  reasonText: string
  state: StepState
  setState: (s: StepState) => void
  setError: (e: string | null) => void
  onSaved: (next: CustomerRecord) => void
}) {
  const [emails, setEmails] = useState<string[]>(() => apEmailTokens(customer))
  const [terms, setTerms] = useState(customer.paymentTermsDays != null ? String(customer.paymentTermsDays) : '')
  const done = state === 'done'

  async function save() {
    const { apEmail: primary, apEmailsExtra } = apEmailStorage(emails)
    const apEmail = primary ?? ''
    const extraList = apEmailsExtra ?? []
    const termsDays = terms.trim() === '' ? null : Number(terms)
    if (!isValidEmail(apEmail)) { setError('Enter the customer’s AP e-mail: the invoice is e-mailed there.'); return }
    if (!extraList.every(isValidEmail)) { setError('One of the e-mails does not look like an e-mail address.'); return }
    if (termsDays == null || !Number.isInteger(termsDays) || termsDays < 0 || termsDays > 365) { setError('Payment terms are required (days, e.g. 30).'); return }
    setError(null)
    const changed = (customer.apEmail ?? '') !== apEmail
      || (customer.apEmailsExtra ?? []).join(',') !== extraList.join(',')
      || customer.paymentTermsDays !== termsDays
    if (!changed) { setState('done'); return }
    setState('busy')
    try {
      const next = await updateCustomer(customer.id, {
        apEmail,
        apEmailsExtra: extraList,
        paymentTermsDays: termsDays,
        changeReason: `OTR rejected PRO ${proNumber} (${reasonText}); invoicing manually`,
        changeSource: 'Factoring · OTR rejected',
      }, customer.updatedAt ?? '')
      setState('done')
      toast.success(`${next.name} saved`)
      onSaved(next)
    } catch (e) {
      setState('todo')
      setError(graphqlErrorText(e) || 'Could not save the customer')
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold tms-muted">AP / invoice e-mails (required; every address gets the invoice)</span>
        <EmailChipsInput id={`fix-ap-${itemId}`} label="AP e-mail" value={emails} disabled={done} onChange={setEmails} />
      </div>
      <label className="flex flex-col gap-1" htmlFor={`fix-terms-${itemId}`}>
        <span className="text-xs font-semibold tms-muted">Payment terms, days (required)</span>
        <TmsInput id={`fix-terms-${itemId}`} inputMode="numeric" value={terms} disabled={done} onChange={(e) => setTerms(e.target.value)} />
      </label>
      {!done && (
        <div><TmsButton variant="primary" size="sm" onClick={save} disabled={state === 'busy'} data-testid="fix-save-customer">Save customer</TmsButton></div>
      )}
    </>
  )
}
