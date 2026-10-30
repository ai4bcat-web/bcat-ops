import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { TmsBadge, TmsButton, TmsCard } from '@/features/tms/kit'
import { DOCUMENT_SOURCE_LABELS, formatSize } from '../documentMatrix'
import { formatDateTime } from '@/lib/date'
import type { PodReviewOutcome } from '@/lib/apiClient'
import type { ShipmentDocumentRecord, ShipmentMessageRecord, ShipmentRecord } from '@/types/tms'
import type { TmsTone } from '@/features/tms/kit'

export interface PodReviewCardProps {
  shipment: ShipmentRecord
  documents: ShipmentDocumentRecord[]
  messages: ShipmentMessageRecord[]
  requesting: boolean
  onRequestPod: () => void | Promise<void>
  onReviewPod: (documentId: string) => Promise<PodReviewOutcome>
}

const REVIEW_STATUS_TONE: Record<string, TmsTone> = {
  ACCEPTED: 'green',
  REJECTED: 'red',
  PENDING: 'orange',
}

function reviewLabel(status: ShipmentDocumentRecord['reviewStatus']): string {
  if (!status) return 'unreviewed'
  return status.toLowerCase()
}

/**
 * P9 POD review panel: what was asked for, what came back, why it was rejected, and
 * whether a human has been flagged after two refusals. Every word comes from the
 * shipment record or the document row the backend classified — the UI never guesses.
 */
export function PodReviewCard({
  shipment,
  documents,
  messages,
  requesting,
  onRequestPod,
  onReviewPod,
}: PodReviewCardProps) {
  const [outcomes, setOutcomes] = useState<Record<string, PodReviewOutcome>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  const podDocs = documents
    .filter((doc) => doc.type === 'POD')
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))

  const lastRequest = messages
    .filter((m) => m.kind === 'POD_REQUEST')
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .at(-1)

  const handleReview = async (docId: string) => {
    setBusyId(docId)
    try {
      const outcome = await onReviewPod(docId)
      setOutcomes((prev) => ({ ...prev, [docId]: outcome }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <TmsCard title="POD collection">
      {shipment.podFlaggedAt && (
        <div className="tms-pod-flag" data-testid="pod-needs-person">
          <AlertTriangle size={16} className="shrink-0" />
          <div>
            <div className="font-medium" style={{ color: 'var(--tms-badge-red)' }}>
              Needs a person
            </div>
            <p className="text-sm">{shipment.podFlagReason}</p>
            <p className="tms-muted text-xs">{formatDateTime(shipment.podFlaggedAt)}</p>
          </div>
        </div>
      )}

      <div className="tms-pod-request-line">
        {lastRequest ? (
          <span className="text-sm" data-testid="pod-request-sent">
            Requested {formatDateTime(String(lastRequest.at))} via {lastRequest.channel.toLowerCase()}
          </span>
        ) : (
          <span className="tms-muted text-sm">No POD request sent yet</span>
        )}
        <TmsButton
          size="sm"
          disabled={requesting}
          aria-label="Request POD"
          onClick={() => {
            void onRequestPod()
          }}
        >
          {requesting ? 'Requesting…' : 'Request POD'}
        </TmsButton>
      </div>

      {podDocs.length === 0 ? (
        <p className="tms-muted text-sm">No POD documents have arrived.</p>
      ) : (
        <ul className="tms-pod-doc-list" data-testid="pod-doc-list">
          {podDocs.map((doc) => {
            const outcome = outcomes[doc.id]
            return (
              <li key={doc.id} className="tms-pod-doc">
                <div className="tms-pod-doc-main">
                  <div>
                    <div className="flex items-center gap-2">
                      <TmsBadge tone={REVIEW_STATUS_TONE[doc.reviewStatus ?? ''] ?? 'gray'}>
                        {reviewLabel(doc.reviewStatus)}
                      </TmsBadge>
                      <span className="text-sm font-medium">{doc.name}</span>
                    </div>
                    <div className="tms-muted text-xs" data-testid={`pod-doc-source-${doc.id}`}>
                      {formatSize(doc.sizeBytes)} · {DOCUMENT_SOURCE_LABELS[doc.source]}
                      {typeof doc.pages === 'number' ? ` · ${doc.pages} page${doc.pages === 1 ? '' : 's'}` : ''}
                      {' · '}{formatDateTime(doc.uploadedAt)}
                    </div>
                    {doc.reviewStatus === 'REJECTED' && doc.reviewNote && (
                      <p
                        className="tms-pod-reject-reason"
                        data-testid={`pod-reject-reason-${doc.id}`}
                      >
                        {doc.reviewNote}
                      </p>
                    )}
                  </div>
                  <TmsButton
                    size="sm"
                    disabled={busyId === doc.id}
                    aria-label={`Review POD ${doc.name}`}
                    onClick={() => {
                      void handleReview(doc.id)
                    }}
                  >
                    {busyId === doc.id ? 'Reviewing…' : 'Review POD'}
                  </TmsButton>
                </div>

                {outcome && (
                  <div className="tms-pod-outcome" data-testid={`pod-outcome-${doc.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <TmsBadge tone={outcome.verdict === 'PASS' ? 'green' : 'red'}>
                        {outcome.verdict}
                      </TmsBadge>
                      <span className="text-xs">Attempt {outcome.attempt}</span>
                      {outcome.readyForBilling && (
                        <TmsBadge tone="green">Ready for billing</TmsBadge>
                      )}
                    </div>
                    {outcome.reasons.length > 0 && (
                      <ul className="tms-pod-outcome-reasons">
                        {outcome.reasons.map((reason, idx) => (
                          <li key={idx}>{reason}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </TmsCard>
  )
}

export default PodReviewCard
