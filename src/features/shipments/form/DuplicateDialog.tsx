/**
 * Duplicate this shipment from inside its edit form: how many copies (1-20), then the existing DUPLICATE_SHIPMENT action. A copy keeps the
 * customer, stops, freight and customer rates; it does not keep the carrier, driver, documents, POD or status, and its customer ref (PO)
 * starts BLANK because every shipment needs its own.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { duplicateShipment, getShipmentBundle } from '@/lib/apiClient'
import { MAX_DUPLICATE_COPIES, parseCopies } from './duplicateCopies'

export function DuplicateDialog({ shipmentId, number, onClose, onDone }: {
  shipmentId: string
  number: string
  onClose: () => void
  /** The new shipment ids, in order; the page opens the first. */
  onDone: (createdIds: string[]) => void
}) {
  const [text, setText] = useState('1')
  const [busy, setBusy] = useState(false)
  const copies = parseCopies(text)

  const run = async () => {
    if (copies == null || busy) return
    setBusy(true)
    try {
      const res = await duplicateShipment({ shipmentId, copies: Array.from({ length: copies }, () => ({} as { pickupAppt: string; deliveryAppt: string })), clearReference: true })
      // Name the new PROs: a few reads, never more than five.
      const numbers = (await Promise.all(res.created.slice(0, 5).map((id) => getShipmentBundle(id).then((b) => b.shipment.number).catch(() => null)))).filter((n): n is string => !!n)
      const named = numbers.length > 0 ? ` PRO ${numbers.join(', ')}${res.created.length > numbers.length ? ` and ${res.created.length - numbers.length} more` : ''}` : ''
      toast.success(`Duplicated ${number}: created${named || ` ${res.created.length} ${res.created.length === 1 ? 'copy' : 'copies'}`}. Enter the customer ref on each.`)
      onDone(res.created)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not duplicate the shipment')
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open onOpenChange={(v) => { if (!v && !busy) onClose() }} title={`Duplicate ${number}`}
      description="Each copy keeps the customer, stops, freight and customer rates. The carrier, driver, documents, POD and status are not copied, and the customer ref starts blank."
      footer={(
        <>
          <TmsButton variant="ghost" data-testid="duplicate-cancel" disabled={busy} onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" data-testid="duplicate-confirm" disabled={busy || copies == null} onClick={() => { void run() }}>
            {busy ? 'Duplicating…' : copies && copies > 1 ? `Create ${copies} copies` : 'Create copy'}
          </TmsButton>
        </>
      )}
    >
      <TmsField label="Copies" htmlFor="duplicate-copies" hint={`1 to ${MAX_DUPLICATE_COPIES}`}>
        <TmsInput id="duplicate-copies" data-testid="duplicate-copies" inputMode="numeric" value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
      </TmsField>
      {copies == null ? <p className="tms-field-hint" role="alert">Enter a whole number from 1 to {MAX_DUPLICATE_COPIES}.</p> : null}
    </TmsDialog>
  )
}
