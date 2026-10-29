import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { repointInvoicedCustomer, repointShipmentCustomer, resolveRevTag } from '@/lib/apiClient'
import type { ShipmentRecord } from '@/types/tms'

export interface RepointCustomerDialogProps {
  shipment: Pick<ShipmentRecord, 'id' | 'number' | 'customerId' | 'updatedAt'>
  customers: { id: string; name: string }[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onRepointed?: () => void | Promise<void>
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
  const [creditPath, setCreditPath] = useState<{
    idempotencyKey: string
    message: string
  } | null>(null)

  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  const reset = () => {
    setCustomerId(shipment.customerId ?? '')
    setReason('')
    setError(null)
    setCreditPath(null)
    setIdempotencyKey(crypto.randomUUID())
  }

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
        setCreditPath({ idempotencyKey, message: message.slice('INVOICED:'.length).trim() })
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
    try {
      await repointInvoicedCustomer({
        shipmentId: shipment.id,
        customerId,
        reason: reason.trim(),
        idempotencyKey: creditPath.idempotencyKey,
      })
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
            <TmsButton variant="primary" onClick={() => { void confirmCredit() }} disabled={busy}>
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
          <p>
            The original invoice will be credited, not edited, and the new customer will be
            rebilled through the normal release gate.
          </p>
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
              onChange={(e) => { setReason(e.target.value); setError(null) }}
              placeholder="Why is the customer changing?"
              disabled={busy}
            />
          </TmsField>
        </>
      )}
    </TmsDialog>
  )
}
