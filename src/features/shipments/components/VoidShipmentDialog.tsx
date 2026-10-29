/**
 * Void — the only way a shipment leaves the working set (Ryne, 2026-10-28: "the most
 * important thing"). The PRO, the history, the documents and the money stay exactly
 * where they are; the Lambda re-checks that the caller is the owner or an ADMIN, so
 * this dialog is the explanation and the reason, never the permission.
 */
import { useState } from 'react'
import { TmsButton, TmsDialog, TmsField, TmsTextarea } from '@/features/tms/kit'
import { graphqlErrorText, voidShipment } from '@/lib/apiClient'
import type { ShipmentBundle, ShipmentRecord } from '@/types/tms'

const MAX_REASON = 500

export function VoidShipmentDialog({ shipment, open, onClose, onVoided }: {
  shipment: Pick<ShipmentRecord, 'id' | 'number' | 'updatedAt'>
  open: boolean
  onClose: () => void
  onVoided: (bundle: ShipmentBundle) => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const text = reason.trim()
    if (!text) { setError('Say why this shipment is being voided.'); return }
    setBusy(true)
    try {
      const bundle = await voidShipment({
        shipmentId: shipment.id,
        reason: text,
        expectedUpdatedAt: shipment.updatedAt,
      })
      onVoided(bundle)
      setReason('')
      onClose()
    } catch (err) {
      setError(graphqlErrorText(err) || (err instanceof Error ? err.message : 'Void failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={(next) => { if (!next && !busy) { setError(null); onClose() } }}
      title={`Void shipment ${shipment.number}`}
      description={
        `${shipment.number} keeps its number, its history and its documents, and shows as VOIDED `
        + 'with who voided it, when and why. It cannot be invoiced, and the number is never reused '
        + 'or given to another shipment. There is no un-void.'
      }
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="destructive" onClick={() => { void submit() }} disabled={busy}>
            {busy ? 'Voiding…' : 'Void shipment'}
          </TmsButton>
        </>
      }
    >
      <TmsField
        label="Reason"
        hint={`Recorded in the audit log. ${MAX_REASON} characters at most.`}
        error={error}
      >
        <TmsTextarea
          aria-label="Reason"
          rows={4}
          maxLength={MAX_REASON}
          value={reason}
          onChange={(e) => { setReason(e.target.value); setError(null) }}
        />
      </TmsField>
    </TmsDialog>
  )
}

export default VoidShipmentDialog
