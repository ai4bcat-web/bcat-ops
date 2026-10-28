/**
 * Moving a carrier between statuses. The target list comes from the transition table, so
 * the only moves offered are the ones the Lambda will accept — including the admin-only
 * way back out of Do not use. INACTIVE and DO_NOT_USE need a reason code from their own
 * list; Confirm stays disabled until there is one.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  CARRIER_STATUS_LABELS,
  CARRIER_STATUS_REASON_LABELS,
  carrierStatusReasonRequired,
  carrierStatusReasonsFor,
  nextCarrierStatuses,
} from '@/lib/carrierStatus'
import type { CarrierRecord, CarrierStatus, CarrierStatusReason } from '@/types/tms'

interface CarrierStatusDialogProps {
  carrier: CarrierRecord
  isAdmin: boolean
  onClose: () => void
  onConfirm: (input: { status: CarrierStatus; reason?: CarrierStatusReason; note?: string }) => Promise<void>
}

export function CarrierStatusDialog({ carrier, isAdmin, onClose, onConfirm }: CarrierStatusDialogProps) {
  const targets = nextCarrierStatuses(carrier.status, isAdmin)
  const [status, setStatus] = useState<CarrierStatus | ''>(targets[0] ?? '')
  const [reason, setReason] = useState<CarrierStatusReason | ''>('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reasons = status ? carrierStatusReasonsFor(status) : []
  const needsReason = status ? carrierStatusReasonRequired(status) : false

  const confirm = async () => {
    if (!status) { setError('Pick a status.'); return }
    if (needsReason && !reason) { setError('Pick a reason.'); return }
    setBusy(true)
    setError(null)
    try {
      await onConfirm({
        status,
        reason: reason || undefined,
        note: note.trim() || undefined,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status change failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Change carrier status</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {carrier.name} · currently{' '}
            <span className="font-medium text-foreground">{CARRIER_STATUS_LABELS[carrier.status]}</span>
          </p>

          {targets.length === 0 ? (
            <p className="text-sm text-destructive">
              Only an admin can move a carrier out of Do not use.
            </p>
          ) : (
            <>
              <div>
                <Label htmlFor="carrier-status" className="text-xs uppercase tracking-wider text-muted-foreground">
                  New status
                </Label>
                <select
                  id="carrier-status"
                  value={status}
                  onChange={(e) => { setStatus(e.target.value as CarrierStatus); setReason('') }}
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {targets.map((s) => <option key={s} value={s}>{CARRIER_STATUS_LABELS[s]}</option>)}
                </select>
              </div>

              {needsReason && (
                <div>
                  <Label htmlFor="carrier-status-reason" className="text-xs uppercase tracking-wider text-muted-foreground">
                    Reason *
                  </Label>
                  <select
                    id="carrier-status-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value as CarrierStatusReason)}
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value="">— select —</option>
                    {reasons.map((r) => <option key={r} value={r}>{CARRIER_STATUS_REASON_LABELS[r]}</option>)}
                  </select>
                </div>
              )}

              <div>
                <Label htmlFor="carrier-status-note" className="text-xs uppercase tracking-wider text-muted-foreground">
                  Note
                </Label>
                <Input
                  id="carrier-status-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={250}
                  className="h-9 text-sm"
                />
              </div>

              <p className="text-xs text-muted-foreground">
                Loads this carrier is already booked on keep their assignment — they are flagged, never bounced.
              </p>
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            onClick={confirm}
            disabled={busy || targets.length === 0 || !status || (needsReason && !reason)}
          >
            {busy ? 'Saving…' : 'Change status'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
