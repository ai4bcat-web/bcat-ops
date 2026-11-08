import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsDetailSplit } from '@/features/tms/kit/TmsDetailSplit'
import { TmsDocumentFrame } from '@/features/tms/kit/TmsDocumentFrame'
import { TmsMetaList } from '@/features/tms/kit/TmsMetaList'
import { downloadFromUrl } from '@/lib/download'
import { errorText } from '@/lib/errorText'
import { relativeDays } from '@/lib/complianceOverview'
import type { OverviewRow } from '@/lib/complianceOverview'
import { RejectDialog } from './RejectDialog'
import { SOURCE_LABELS, STATE_LABELS, STATE_TONES } from './labels'

const ENTITY_LABELS = { DRIVER: 'Driver', TRUCK: 'Truck', CARRIER: 'Carrier' } as const

/**
 * One document: the file on the left, the facts on the right. Approve / Reject appear
 * only when `canAct` — the page decides (permitted user, driver/truck document, awaiting review).
 */
export function DocumentDetail({
  row, canAct, getUrl, onApprove, onReject,
}: {
  row: OverviewRow
  canAct: boolean
  getUrl: (row: OverviewRow, s3Key: string) => Promise<string>
  onApprove: (row: OverviewRow) => Promise<void>
  onReject: (row: OverviewRow, reason: string) => Promise<void>
}) {
  const fileKey = row.doc?.s3Key ?? row.carrierDoc?.s3Key ?? null
  const [fetched, setFetched] = useState<{ key: string; url: string } | null>(null)
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)

  useEffect(() => {
    if (!fileKey) return
    let alive = true
    getUrl(row, fileKey)
      .then((url) => { if (alive) setFetched({ key: fileKey, url }) })
      .catch((err: unknown) => { if (alive) setFailed({ key: fileKey, message: errorText(err) }) })
    return () => { alive = false }
  }, [row, fileKey, getUrl])

  const url = fetched && fetched.key === fileKey ? fetched.url : null
  const error = failed && failed.key === fileKey ? failed.message : null

  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true)
    try {
      await action()
      toast.success(done)
      setRejecting(false)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const download = () => {
    if (!url || !fileKey) return
    void downloadFromUrl(url, fileKey.split('/').pop() ?? row.title)
      .catch((err: unknown) => toast.error(`Couldn't download: ${errorText(err)}`))
  }

  return (
    <>
      <TmsDetailSplit
        ratio="7/5"
        aside={(
          <div style={{ display: 'grid', gap: 'var(--tms-gap)' }}>
            <div>
              <TmsBadge tone={STATE_TONES[row.state]}>{STATE_LABELS[row.state]}</TmsBadge>
            </div>
            <TmsMetaList
              items={[
                { label: ENTITY_LABELS[row.entityType], value: row.entityName },
                { label: 'Document', value: row.title },
                { label: 'Expires', value: row.expiry ? `${row.expiry}${row.daysLeft !== null ? ` (${relativeDays(row.daysLeft)})` : ''}` : null },
                { label: 'Source', value: SOURCE_LABELS[row.source] },
                { label: 'Uploaded', value: row.createdAt?.slice(0, 10) ?? null, hidden: !row.createdAt },
                { label: 'Verified by', value: row.verifiedBy, hidden: !row.verifiedBy },
                { label: 'Verified', value: row.verifiedAt?.slice(0, 10) ?? null, hidden: !row.verifiedAt },
                { label: 'Rejection reason', value: row.rejectionReason, hidden: !row.rejectionReason, wide: true },
              ]}
            />
            {row.kind === 'carrier' || row.kind === 'policy' ? (
              <p className="tms-meta-empty">Carrier paperwork is read-only here. Update it from the carrier profile.</p>
            ) : null}
            {canAct ? (
              <div style={{ display: 'flex', gap: 'var(--tms-gap)' }}>
                <TmsButton variant="reject" disabled={busy} onClick={() => setRejecting(true)}>Reject</TmsButton>
                <TmsButton variant="approve" disabled={busy} onClick={() => void run(() => onApprove(row), 'Document approved')}>Approve</TmsButton>
              </div>
            ) : null}
          </div>
        )}
      >
        <TmsDocumentFrame url={url} fileKey={fileKey} title={row.title} error={error} onDownload={url ? download : undefined} />
      </TmsDetailSplit>
      {rejecting ? (
        <RejectDialog
          documentTitle={row.title}
          busy={busy}
          onCancel={() => setRejecting(false)}
          onSubmit={(reason) => void run(() => onReject(row, reason), 'Document rejected')}
        />
      ) : null}
    </>
  )
}
