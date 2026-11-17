/**
 * "Move back to Active shipments" (Ryne 2026-11-16): sends loads still waiting in Load Review back to the Active board so they can be fixed.
 * One BATCH_SHIPMENT_TASK row per load, so each is authorized and audited on its own; a load already in billing or invoiced comes back
 * refused with the server's sentence (revise or void the invoice instead) while the rest still move.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { returnToActive } from '@/lib/apiClient'

export function ReturnToActiveDialog({ open, onOpenChange, ids, label, onDone }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  ids: string[]
  /** Shown in the title: the PRO for one load, a count for several. */
  label: string
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const results: { number: string | null; shipmentId: string; ok: boolean; message: string | null }[] = []
      // The server takes one review-sized batch per call.
      for (let offset = 0; offset < ids.length; offset += 9) {
        results.push(...(await returnToActive(ids.slice(offset, offset + 9), note.trim() || undefined)).results)
      }
      const failed = results.filter((r) => !r.ok)
      const moved = results.length - failed.length
      if (failed.length === 0) toast.success(`${moved} shipment${moved === 1 ? '' : 's'} moved back to Active shipments`)
      else if (moved === 0) { setError(failed.map((r) => `${r.number ?? r.shipmentId}: ${r.message ?? 'refused'}`).join('\n')); return }
      else toast.warning(`${moved} moved back, ${failed.length} refused: ${failed.slice(0, 3).map((r) => `${r.number ?? r.shipmentId} (${r.message ?? 'refused'})`).join('; ')}`)
      setNote('')
      onOpenChange(false)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move back to Active')
    } finally { setBusy(false) }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={(next) => { if (!busy) onOpenChange(next) }}
      title={`Move ${label} back to Active shipments`}
      description="It leaves Load Review and returns to the Active board so you can fix it. It stays there until somebody pushes it to Load Review again."
      footer={<>
        <TmsButton variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</TmsButton>
        <TmsButton variant="primary" disabled={busy || ids.length === 0} data-testid="return-active-confirm" onClick={() => void run()}>{busy ? 'Moving…' : 'Move back to Active'}</TmsButton>
      </>}
    >
      <TmsField label="Reason (optional)" htmlFor="return-active-note">
        <TmsInput id="return-active-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. wrong delivery time, missing lumper receipt" />
      </TmsField>
      {error && <p role="alert" className="tms-error" style={{ whiteSpace: 'pre-line' }}>{error}</p>}
    </TmsDialog>
  )
}
