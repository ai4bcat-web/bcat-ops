import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { unvoidShipment } from '@/lib/apiClient'
import type { ShipmentRecord } from '@/types/tms'

export interface UnvoidShipmentDialogProps {
  shipment: Pick<ShipmentRecord, 'id' | 'number' | 'updatedAt'>
  open: boolean
  onOpenChange: (open: boolean) => void
  onUnvoided?: () => void | Promise<void>
}

/**
 * The only way back from a void. Owner/ADMIN only in the UI; the Lambda enforces it.
 * A reason is required and is stamped on the audit log with who and when.
 */
export function UnvoidShipmentDialog({ shipment, open, onOpenChange, onUnvoided }: UnvoidShipmentDialogProps) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = reason.trim()
    if (!trimmed) {
      setError('A reason is required.')
      return
    }
    setBusy(true)
    try {
      await unvoidShipment({ shipmentId: shipment.id, reason: trimmed, expectedUpdatedAt: shipment.updatedAt })
      toast.success(`${shipment.number} unvoided`)
      setReason('')
      if (onUnvoided) await onUnvoided()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unvoid failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={(next) => { if (!next && !busy) onOpenChange(false) }}
      title="Unvoid shipment"
      description={`Restore ${shipment.number} to the working set.`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </TmsButton>
          <TmsButton variant="primary" onClick={() => { void submit() }} disabled={busy}>
            {busy ? 'Restoring…' : 'Unvoid'}
          </TmsButton>
        </>
      }
    >
      <TmsField label="Reason" error={error}>
        <TmsInput
          value={reason}
          onChange={(e) => { setReason(e.target.value); setError(null) }}
          placeholder="Why is this shipment being restored?"
          disabled={busy}
        />
      </TmsField>
    </TmsDialog>
  )
}
