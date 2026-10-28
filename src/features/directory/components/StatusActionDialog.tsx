import { useState, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {customer.name} · current status <span className="font-medium text-foreground">{customer.status ?? '—'}</span>
          </p>
          {action === 'deactivate' && (
            <>
              <div>
                <Label htmlFor="status-reason" className="text-xs uppercase tracking-wider text-muted-foreground">Reason *</Label>
                <Input id="status-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={250} className="h-9 text-sm" />
              </div>
              <div>
                <Label htmlFor="status-replacement" className="text-xs uppercase tracking-wider text-muted-foreground">Replacement customer</Label>
                <select
                  id="status-replacement"
                  value={replacementId}
                  onChange={(e) => setReplacementId(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">— none —</option>
                  {activeCustomers
                    .filter((c) => c.id !== customer.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                </select>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
