/** The Tracking grid's "Review documents" row action: one shipment's pending carrier uploads. */
import { useMemo } from 'react'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { useDocumentReviewQueue } from '@/hooks/useDocumentReviewQueue'
import { DocumentReviewPanel } from './DocumentReviewPanel'

export interface DocumentReviewDialogProps {
  shipmentId: string
  /** Shipment number for the title. */
  label?: string | null
  onClose: () => void
  /** After a decision was recorded (the board refreshes its counts). */
  onDecided: () => void
}

export function DocumentReviewDialog({ shipmentId, label, onClose, onDecided }: DocumentReviewDialogProps) {
  const queue = useDocumentReviewQueue()
  const documents = useMemo(() => queue.documents.filter((d) => d.shipmentId === shipmentId), [queue.documents, shipmentId])
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={label ? `Review documents — ${label}` : 'Review documents'}
      className="tms-dialog-xl"
      footer={<TmsButton onClick={onClose}>Close</TmsButton>}
    >
      <DocumentReviewPanel
        documents={documents}
        onDecided={async () => {
          await queue.refresh()
          onDecided()
        }}
        emptyText={queue.error ?? (queue.loading ? 'Loading the review queue…' : 'Nothing is waiting on review for this shipment.')}
      />
    </TmsDialog>
  )
}
