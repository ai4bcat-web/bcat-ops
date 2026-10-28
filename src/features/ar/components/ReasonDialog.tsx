/**
 * The written reason behind a correction — voiding an invoice, reversing a receipt.
 *
 * Both are irreversible postings that an auditor reads back months later, so neither is
 * a bare confirm: the Lambda requires the text and this dialog is where it is typed.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export function ReasonDialog({ title, description, label, confirmLabel, tone = 'destructive', busy, onClose, onConfirm }: {
  title: string
  description: string
  label: string
  confirmLabel: string
  /** A correction is destructive; recording what already happened by hand is not. */
  tone?: 'destructive' | 'default'
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div>
          <Label htmlFor="ar-reason" className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
          <Textarea
            id="ar-reason"
            aria-label={label}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy} aria-label="Cancel">Cancel</Button>
          <Button
            variant={tone === 'destructive' ? 'destructive' : 'default'}
            aria-label={confirmLabel}
            disabled={busy || reason.trim().length === 0}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
