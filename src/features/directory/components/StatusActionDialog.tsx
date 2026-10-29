import { useState, useMemo } from 'react'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import type { CustomerRecord, CustomerStatus } from '@/types/tms'

interface StatusActionDialogProps {
  open: boolean
  customer: CustomerRecord
  action: 'activate' | 'deactivate' | 'close' | null
  activeCustomers: CustomerRecord[]
  onClose: () => void
  onConfirm: (input: { status: CustomerStatus; reason?: string; replacementCustomerId?: string }) => void
}

export function StatusActionDialog({ open, customer, action, activeCustomers, onClose, onConfirm }: StatusActionDialogProps) {
  const [reason, setReason] = useState('')
  const [replacementId, setReplacementId] = useState('')

  const title = useMemo(() => {
    if (action === 'activate') return customer.status === 'PENDING' ? 'Approve customer' : 'Activate customer'
    if (action === 'deactivate') return 'Deactivate customer'
    if (action === 'close') return 'Close lead'
    return ''
  }, [action, customer.status])

  const confirmLabel = useMemo(() => {
    if (action === 'activate') return customer.status === 'PENDING' ? 'Approve' : 'Activate'
    if (action === 'deactivate') return 'Deactivate'
    if (action === 'close') return 'Close lead'
    return 'Confirm'
  }, [action, customer.status])

  const canConfirm = action !== 'deactivate' || reason.trim().length > 0

  const handleConfirm = () => {
    if (!canConfirm) return
    if (action === 'activate') onConfirm({ status: 'ACTIVE' })
    if (action === 'close') onConfirm({ status: 'CLOSED' })
    if (action === 'deactivate') {
      onConfirm({
        status: 'BLOCKED',
        reason: reason.trim(),
        replacementCustomerId: replacementId || undefined,
      })
    }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={(v) => { if (!v) onClose() }}
      title={title}
      footer={
        <>
          <TmsButton onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={handleConfirm} disabled={!canConfirm}>{confirmLabel}</TmsButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <p className="tms-muted" style={{ fontSize: 13 }}>
          {customer.name} · current status <span style={{ fontWeight: 600, color: 'var(--tms-text)' }}>{customer.status ?? '—'}</span>
        </p>
        {action === 'deactivate' && (
          <>
            <TmsField label="Reason *" htmlFor="status-reason">
              <TmsInput id="status-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={250} />
            </TmsField>
            <TmsField label="Replacement customer" htmlFor="status-replacement">
              <TmsSelect
                id="status-replacement"
                value={replacementId}
                onChange={(e) => setReplacementId(e.target.value)}
                placeholder="— none —"
                options={activeCustomers.filter((c) => c.id !== customer.id).map((c) => ({ value: c.id, label: c.name }))}
              />
            </TmsField>
          </>
        )}
      </div>
    </TmsDialog>
  )
}
