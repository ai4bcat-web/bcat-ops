import { useState } from 'react'
import { Eye, Check, X, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from '@/components/ui/sheet'
import { useReviewQueue, type ReviewQueueItem } from '@/hooks/useReviewQueue'
import { useAppStore } from '@/store/useAppStore'
import { Card, DocumentPreview, InitialsAvatar } from '@/features/compliance/components'
import { DriverApplicationView } from '@/features/compliance/DriverApplicationView'

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * The "Needs review" worklist: portal-submitted documents (PENDING_REVIEW) and
 * SUBMITTED applications awaiting approval. Rendered as a section inside the merged
 * Onboarding page (no page chrome of its own).
 */
export function ReviewQueueSection() {
  const { items, pendingCount, loading, approveDocument, rejectDocument, approveApplication, rejectApplication } = useReviewQueue()
  const drivers = useAppStore((s) => s.drivers)
  const [previewItem, setPreviewItem] = useState<ReviewQueueItem | null>(null)
  const [rejectItem, setRejectItem] = useState<ReviewQueueItem | null>(null)
  const [reason, setReason] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  async function approve(item: ReviewQueueItem) {
    setBusyId(item.id)
    try {
      if (item.kind === 'document' && item.document) await approveDocument(item.document)
      if (item.kind === 'application' && item.application) await approveApplication(item.application)
      toast.success('Approved')
    } catch (e) { console.error(e); toast.error('Approve failed') }
    finally { setBusyId(null) }
  }

  async function confirmReject() {
    if (!rejectItem) return
    if (reason.trim().length < 3) { toast.error('Enter a reason'); return }
    setBusyId(rejectItem.id)
    try {
      if (rejectItem.kind === 'document' && rejectItem.document) await rejectDocument(rejectItem.document, reason.trim())
      if (rejectItem.kind === 'application' && rejectItem.application) await rejectApplication(rejectItem.application, reason.trim())
      toast.success('Rejected — the driver will see your reason')
      setRejectItem(null); setReason('')
    } catch (e) { console.error(e); toast.error('Reject failed') }
    finally { setBusyId(null) }
  }

  return (
    <>
      <Card title="Needs review" sub={loading ? 'Loading…' : `${pendingCount} item${pendingCount === 1 ? '' : 's'} awaiting approval`} noPad>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  {['Driver / Truck', 'Item', 'Submitted', ''].map((h, i) => (
                    <th key={h} style={{ padding: '8px 16px', textAlign: i === 3 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!loading && items.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--ds-t3)' }}>Nothing to review. 🎉</td></tr>
                )}
                {items.map((item) => (
                  <tr key={`${item.kind}-${item.id}`} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {item.entityType === 'DRIVER' && <InitialsAvatar name={item.entityName} colorKey={drivers.find((d) => d.id === item.entityId)?.colorKey} />}
                        <span style={{ fontWeight: 500, color: 'var(--ds-t1)' }}>{item.entityName}</span>
                      </div>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {item.kind === 'application' ? <FileText size={14} style={{ color: 'var(--ds-t3)' }} /> : null}
                        <span style={{ color: 'var(--ds-t2)' }}>{item.label}</span>
                        <Badge variant={item.kind === 'application' ? 'default' : 'secondary'}>{item.kind === 'application' ? 'Application' : 'Document'}</Badge>
                      </div>
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--ds-t3)' }}>{fmtDate(item.submittedAt)}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
                        <Button size="sm" variant="ghost" style={{ paddingInline: 16 }} onClick={() => setPreviewItem(item)}><Eye size={14} /> Preview</Button>
                        <Button size="sm" disabled={busyId === item.id} onClick={() => approve(item)} style={{ paddingInline: 16, background: 'var(--ds-green)', color: '#fff', border: 'none' }}><Check size={14} /> Approve</Button>
                        <Button size="sm" variant="destructive" style={{ paddingInline: 16 }} disabled={busyId === item.id} onClick={() => { setRejectItem(item); setReason('') }}><X size={14} /> Reject</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

      {/* Preview */}
      <Sheet open={!!previewItem} onOpenChange={(o) => !o && setPreviewItem(null)}>
        <SheetContent style={{ width: 'min(860px, 94vw)' }}>
          <SheetHeader><SheetTitle>{previewItem?.entityName} — {previewItem?.label}</SheetTitle></SheetHeader>
          <SheetBody>
            {previewItem?.kind === 'document' && previewItem.document?.s3Key && <DocumentPreview s3Key={previewItem.document.s3Key} />}
            {previewItem?.kind === 'document' && !previewItem.document?.s3Key && <div style={{ padding: 24, color: 'var(--ds-t3)' }}>No file attached (confirmation item).</div>}
            {previewItem?.kind === 'application' && <DriverApplicationView driverId={previewItem.entityId} />}
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* Reject reason */}
      <Dialog open={!!rejectItem} onOpenChange={(o) => !o && setRejectItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject — {rejectItem?.label}</DialogTitle>
            <DialogDescription>This reason is shown verbatim to the driver in their portal. Be specific and actionable.</DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            placeholder="e.g. The medical card photo is blurry — please re-upload a clear photo showing the expiration date. (The driver sees this message.)"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectItem(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busyId === rejectItem?.id} onClick={confirmReject}>Reject & notify</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
