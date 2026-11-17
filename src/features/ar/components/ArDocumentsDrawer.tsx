/**
 * Ready to Invoice: a load's POD and rate confirmation, opened from the row without leaving the page. It is
 * the Load Review documents card (view, download, replace, delete, upload) in a drawer; when the invoice has
 * already gone out the files are shown and the card says why nothing is offered.
 */
import { TmsAlert } from '@/features/tms/kit'
import { TmsDrawer } from '@/features/tms/kit/TmsDrawer'
import { LoadReviewDocuments } from '@/features/tms/loadReview/LoadReviewDocuments'

export function ArDocumentsDrawer({ pro, shipmentId, lockedReason, onClose, onChanged }: {
  pro: string
  shipmentId: string
  /** Why the files cannot be changed (the invoice has gone out), or null when they can. */
  lockedReason: string | null
  onClose: () => void
  /** A file was replaced, deleted or uploaded: the page re-reads the row, its chips and the Factor button. */
  onChanged: () => Promise<void> | void
}) {
  return (
    <TmsDrawer
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`Documents · PRO ${pro}`}
      description="The POD and rate confirmation this invoice goes out with."
      size="lg"
    >
      <div className="space-y-3" data-testid="ar-documents-drawer">
        {lockedReason && <TmsAlert tone="orange">{lockedReason}</TmsAlert>}
        <LoadReviewDocuments shipmentId={shipmentId} readOnly={lockedReason != null} deleteReason="Deleted from Ready to Invoice" onChanged={async () => { await onChanged() }} />
      </div>
    </TmsDrawer>
  )
}
