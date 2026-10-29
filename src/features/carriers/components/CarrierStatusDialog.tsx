/**
 * Moving a carrier between statuses. The target list comes from the transition table, so
 * the only moves offered are the ones the Lambda will accept — including the admin-only
 * way back out of Do not use. INACTIVE and DO_NOT_USE need a reason code from their own
 * list; Confirm stays disabled until there is one.
 */
import { useState } from 'react'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
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
    <TmsDialog
      open
      onOpenChange={(v) => { if (!v) onClose() }}
      title="Change carrier status"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            onClick={confirm}
            disabled={busy || targets.length === 0 || !status || (needsReason && !reason)}
          >
            {busy ? 'Saving…' : 'Change status'}
          </TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="tms-muted">
          {carrier.name} · currently{' '}
          <span className="font-medium" style={{ color: 'var(--tms-text)' }}>
            {CARRIER_STATUS_LABELS[carrier.status]}
          </span>
        </p>

        {targets.length === 0 ? (
          <p style={{ color: 'var(--tms-badge-red)' }}>
            Only an admin can move a carrier out of Do not use.
          </p>
        ) : (
          <>
            <TmsField label="New status" htmlFor="carrier-status">
              <TmsSelect
                id="carrier-status"
                value={status}
                onChange={(e) => { setStatus(e.target.value as CarrierStatus); setReason('') }}
              >
                {targets.map((s) => <option key={s} value={s}>{CARRIER_STATUS_LABELS[s]}</option>)}
              </TmsSelect>
            </TmsField>

            {needsReason && (
              <TmsField label="Reason *" htmlFor="carrier-status-reason">
                <TmsSelect
                  id="carrier-status-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value as CarrierStatusReason)}
                >
                  <option value="">— select —</option>
                  {reasons.map((r) => <option key={r} value={r}>{CARRIER_STATUS_REASON_LABELS[r]}</option>)}
                </TmsSelect>
              </TmsField>
            )}

            <TmsField label="Note" htmlFor="carrier-status-note">
              <TmsInput
                id="carrier-status-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={250}
              />
            </TmsField>

            <p className="text-xs tms-muted">
              Shipments this carrier is already booked on keep their assignment — they are flagged, never bounced.
            </p>
          </>
        )}

        {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsDialog>
  )
}
