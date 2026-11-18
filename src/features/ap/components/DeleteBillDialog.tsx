/**
 * Delete a payable (Ryne 2026-11-18): why, then gone from every open list.
 *
 * The bill row is kept (marked deleted) and a line goes on the shipment's own history with who, when and why, so the
 * money history stays explainable. Only the AP side: the load's carrier pay lines, the customer's invoice and every
 * payment are left as they are, and a fresh bill can be recorded for the load afterwards.
 */
import { useState } from 'react'
import { TmsButton, TmsDialog, TmsField, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import type { BillDeleteReason } from '@/lib/apiClient'

const BILL_DELETE_REASON_OPTIONS: { value: BillDeleteReason; label: string }[] = [
  { value: 'DUPLICATE', label: 'Duplicate' },
  { value: 'WRONG_CARRIER', label: 'Wrong carrier' },
  { value: 'LOAD_CANCELLED', label: 'Load cancelled' },
  { value: 'ENTERED_IN_ERROR', label: 'Entered in error' },
  { value: 'OTHER', label: 'Other' },
]

export function DeleteBillDialog({ title, busy, onClose, onConfirm }: {
  title: string
  busy: boolean
  onClose: () => void
  onConfirm: (reasonCode: BillDeleteReason, detail: string) => void
}) {
  const [code, setCode] = useState<BillDeleteReason | ''>('')
  const [detail, setDetail] = useState('')
  const ready = code !== '' && (code !== 'OTHER' || detail.trim().length > 0)

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={title}
      description="Takes the bill off Payable and the pay run. The bill stays on the record as deleted, and a note goes on the shipment's history saying who deleted it and why. Carrier pay, the customer invoice and payments are not changed. A bill that has been paid cannot be deleted."
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy} aria-label="Cancel">Cancel</TmsButton>
          <TmsButton
            variant="destructive"
            aria-label="Delete bill"
            disabled={busy || !ready}
            onClick={() => { if (code) onConfirm(code, detail.trim()) }}
          >
            Delete bill
          </TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TmsField label="Why it is being deleted" htmlFor="ap-delete-reason">
          <TmsSelect
            id="ap-delete-reason"
            aria-label="Why it is being deleted"
            placeholder="Choose a reason"
            value={code}
            onChange={(e) => setCode(e.target.value as BillDeleteReason | '')}
            options={BILL_DELETE_REASON_OPTIONS}
          />
        </TmsField>
        <TmsField label={code === 'OTHER' ? 'Details (required)' : 'Details (optional)'} htmlFor="ap-delete-detail">
          <TmsTextarea
            id="ap-delete-detail"
            aria-label="Details"
            rows={3}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
        </TmsField>
      </div>
    </TmsDialog>
  )
}
