import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { repointInvoicedCustomer, repointShipmentCustomer, resolveRevTag, getShipmentBundle, getInvoice } from '@/lib/apiClient'
import { planRepointCredit, type RepointCreditPlan, type RepointInvoiceInput } from '@/lib/repointCredit'
import type { ShipmentRecord } from '@/types/tms'

export interface RepointCustomerDialogProps {
  shipment: Pick<ShipmentRecord, 'id' | 'number' | 'customerId' | 'customerName' | 'updatedAt'>
  customers: { id: string; name: string }[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onRepointed?: () => void | Promise<void>
}

function centsDisplay(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}

interface CreditPath {
  idempotencyKey: string
  message: string
  plan: RepointCreditPlan | null
  loading: boolean
  oldCustomerName: string
}

/**
 * Re-point a shipment to a different customer. Owner/ADMIN only in the UI.
 *
 * If the shipment has already been invoiced, the first call returns a message
 * starting with `INVOICED:`. The dialog then shows the credit-and-rebill path:
 * the original invoice is credited (never edited) and the new customer is rebilled
 * through the normal gate. An idempotency key is generated once per dialog opening
 * so a double click cannot double-credit.
 */
export function RepointCustomerDialog({
  shipment,
  customers,
  open,
  onOpenChange,
  onRepointed,
}: RepointCustomerDialogProps) {
  const [customerId, setCustomerId] = useState<string>(shipment.customerId ?? '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creditPath, setCreditPath] = useState<CreditPath | null>(null)
  const [acknowledge, setAcknowledge] = useState(false)

  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  const reset = () => {
    setCustomerId(shipment.customerId ?? '')
    setReason('')
    setError(null)
    setCreditPath(null)
    setAcknowledge(false)
    setIdempotencyKey(crypto.randomUUID())
  }

  // When the credit path is entered, fetch the invoices and compute the plan.
  useEffect(() => {
    if (!open || !creditPath?.loading) return

    let cancelled = false

    void (async () => {
      try {
        const bundle = await getShipmentBundle(shipment.id)
        const invoiceInputs: RepointInvoiceInput[] = []

        for (const order of bundle.orders) {
          const invoiceId = order.invoiceId
          if (!invoiceId) continue
          const invoice = await getInvoice(invoiceId)
          if (!invoice) continue
          invoiceInputs.push({
            id: invoice.id,
            number: invoice.number ?? null,
            status: invoice.status,
            totalCents: invoice.totalCents,
            paidCents: invoice.paidCents,
            writtenOffCents: invoice.writtenOffCents,
            balanceCents: invoice.balanceCents,
            factoringItemId: invoice.factoringItemId ?? null,
            orderId: invoice.orderId ?? null,
          })
        }

        if (cancelled) return

        const plan = planRepointCredit(invoiceInputs)
        const oldCustomerName = shipment.customerName
          ?? customers.find((c) => c.id === shipment.customerId)?.name
          ?? 'the current customer'

        setCreditPath((prev) => {
          if (!prev) return null
          return { idempotencyKey: prev.idempotencyKey, message: prev.message, plan, loading: false, oldCustomerName }
        })
      } catch {
        if (cancelled) return
        setCreditPath((prev) => {
          if (!prev) return null
          return { idempotencyKey: prev.idempotencyKey, message: prev.message, plan: null, loading: false, oldCustomerName: 'the current customer' }
        })
        setError('Could not load invoice details. You may still confirm the credit-and-rebill.')
      }
    })()

    return () => { cancelled = true }
  }, [open, creditPath?.loading, shipment.id, shipment.customerId, shipment.customerName, customers])

  const submit = async () => {
    const trimmed = reason.trim()
    if (!customerId) {
      setError('Choose a customer.')
      return
    }
    if (!trimmed) {
      setError('A reason is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await repointShipmentCustomer({
        shipmentId: shipment.id,
        customerId,
        reason: trimmed,
        expectedUpdatedAt: shipment.updatedAt,
      })
      toast.success(`${shipment.number} repointed`)
      reset()
      if (onRepointed) await onRepointed()
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Re-point failed'
      if (message.startsWith('INVOICED:')) {
        setCreditPath({
          idempotencyKey,
          message: message.slice('INVOICED:'.length).trim(),
          plan: null,
          loading: true,
          oldCustomerName: 'the current customer',
        })
      } else {
        setError(message)
      }
    } finally {
      setBusy(false)
    }
  }

  const confirmCredit = async () => {
    if (!creditPath) return
    setBusy(true)
    setError(null)
    try {
      // BackendShipment is adding acknowledgePaid to the apiClient type; typed-cast
      // through unknown so the dialog compiles against the one deploy that predates it.
      await repointInvoicedCustomer({
        shipmentId: shipment.id,
        customerId,
        reason: reason.trim(),
        idempotencyKey: creditPath.idempotencyKey,
        ...(acknowledge ? { acknowledgePaid: true } : {}),
      } as unknown as { shipmentId: string; customerId: string; reason: string; idempotencyKey: string; acknowledgePaid?: boolean })
      try {
        await resolveRevTag({ shipmentId: shipment.id })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Revenue tag re-resolution failed'
        setError(message)
        toast.error(message)
        return
      }
      toast.success(`${shipment.number} repointed and rebilled`)
      reset()
      if (onRepointed) await onRepointed()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Credit-and-rebill failed')
    } finally {
      setBusy(false)
    }
  }

  const plan = creditPath?.plan
  const moneyApplied = plan?.moneyApplied ?? false
  const confirmDisabled = busy || (moneyApplied && !acknowledge)
  const loadingPlan = creditPath?.loading ?? false

  return (
    <TmsDialog
      open={open}
      onOpenChange={(next) => { if (!next && !busy) { reset(); onOpenChange(false) } }}
      title="Re-point customer"
      description={`Change the customer on ${shipment.number}.`}
      footer={
        creditPath ? (
          <>
            <TmsButton variant="ghost" onClick={() => { reset(); onOpenChange(false) }} disabled={busy}>
              Cancel
            </TmsButton>
            <TmsButton variant="primary" onClick={() => { void confirmCredit() }} disabled={confirmDisabled}>
              {busy ? 'Rebilling…' : 'Credit original and rebill'}
            </TmsButton>
          </>
        ) : (
          <>
            <TmsButton variant="ghost" onClick={() => { reset(); onOpenChange(false) }} disabled={busy}>
              Cancel
            </TmsButton>
            <TmsButton variant="primary" onClick={() => { void submit() }} disabled={busy}>
              {busy ? 'Re-pointing…' : 'Re-point'}
            </TmsButton>
          </>
        )
      }
    >
      {creditPath ? (
        <div className="space-y-3">
          <p className="text-[color:var(--tms-badge-orange)]">{creditPath.message}</p>

          {loadingPlan ? (
            <p>Loading invoice details…</p>
          ) : plan ? (
            <>
              {plan.entries.map((entry) => (
                <p key={entry.invoiceId} className="text-sm">
                  {entry.number ?? entry.invoiceId} — credit {centsDisplay(entry.creditCents)}
                  {entry.appliedCents > 0 && ` (applies ${centsDisplay(entry.appliedCents)} to the open balance`}
                  {entry.unappliedCents > 0 && `; ${centsDisplay(entry.unappliedCents)} becomes an account credit for ${creditPath.oldCustomerName}`}
                  )
                </p>
              ))}
              <p className="text-sm">
                {creditPath.oldCustomerName} is billed {centsDisplay(plan.totalCreditCents)} through the normal release gate.
              </p>

              {moneyApplied && (
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(e) => setAcknowledge(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    I understand the original invoice is credited, not edited, and{' '}
                    {centsDisplay(plan.totalUnappliedCents)} stays as an account credit for{' '}
                    {creditPath.oldCustomerName}
                  </span>
                </label>
              )}
            </>
          ) : null}

          {error && <p className="tms-field-error">{error}</p>}
        </div>
      ) : (
        <>
          <TmsField label="New customer" error={error && !customerId ? error : null}>
            <TmsSelect
              value={customerId}
              onChange={(e) => { setCustomerId(e.target.value); setError(null) }}
              placeholder="Choose a customer"
              options={customers.map((c) => ({ value: c.id, label: c.name }))}
            />
          </TmsField>
          <TmsField label="Reason" error={error && customerId ? error : null}>
            <TmsInput
              value={reason}
              onChange={(e) => { setReason((e.target as HTMLInputElement).value); setError(null) }}
              placeholder="Why is this customer being repointed?"
            />
          </TmsField>
        </>
      )}
    </TmsDialog>
  )
}