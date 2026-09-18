/**
 * Look at — and actually save — the files attached to a dispute.
 *
 * Staff need the driver's screenshots on disk to attach them to the Amazon case, and the
 * old list could only window.open a presigned URL: a cross-origin <a download> navigates
 * instead of saving, so an image replaced the page staff were working. Thumbnails render
 * from the same presigned URL, and saving goes through the fetch-then-blob helper.
 */
import { useEffect, useState } from 'react'
import { Download, ExternalLink, FileText, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { getDisputeEvidenceUrl } from '@/lib/apiClient'
import { downloadFromUrl } from '@/lib/download'
import { errorMessage } from '@/lib/utils/errorMessage'
import { Pill, type PillTone } from '@/features/maintenance/maintenanceUi'
import type { DisputeEvidence, DisputeEvidenceKind } from '@/types/dispute'
import {
  evidenceFileName, evidenceSizeLabel, isBrowserRenderable, isPdfEvidence,
} from './disputeEvidence'

const KIND_LABEL: Record<DisputeEvidenceKind, string> = {
  CONFIRMATION: 'Confirmation',
  PHOTO: 'Photo',
  AMAZON_RESPONSE: 'Amazon reply',
}
const KIND_TONE: Record<DisputeEvidenceKind, PillTone> = {
  CONFIRMATION: 'ok',
  PHOTO: 'blue',
  AMAZON_RESPONSE: 'violet',
}

export function EvidenceGallery({ evidence, onRemove }: {
  evidence: DisputeEvidence[]
  /** Supplied only for staff-owned files — driver uploads are never removable. */
  onRemove?: (item: DisputeEvidence) => void
}) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [savingAll, setSavingAll] = useState(false)

  // Presign every file once: the thumbnail, the open link and the download all need it.
  const keys = evidence.map((e) => e.s3Key).join('|')
  useEffect(() => {
    let alive = true
    for (const item of evidence) {
      getDisputeEvidenceUrl(item.s3Key)
        .then((url) => { if (alive) setUrls((u) => (u[item.s3Key] ? u : { ...u, [item.s3Key]: url })) })
        .catch(() => { /* the row still offers open/download, which re-signs on click */ })
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the file list, not the array identity
  }, [keys])

  const urlFor = async (item: DisputeEvidence) => urls[item.s3Key] ?? await getDisputeEvidenceUrl(item.s3Key)

  const open = async (item: DisputeEvidence) => {
    setBusyKey(item.s3Key)
    try {
      window.open(await urlFor(item), '_blank', 'noopener,noreferrer')
    } catch (err) {
      toast.error(`Couldn't open ${evidenceFileName(item)}: ${errorMessage(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const download = async (item: DisputeEvidence) => {
    setBusyKey(item.s3Key)
    try {
      await downloadFromUrl(await urlFor(item), evidenceFileName(item))
    } catch (err) {
      toast.error(`Couldn't download ${evidenceFileName(item)}: ${errorMessage(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const downloadAll = async () => {
    setSavingAll(true)
    let failed = 0
    // Sequential: a burst of parallel saves is what makes browsers block downloads.
    for (const item of evidence) {
      try {
        await downloadFromUrl(await urlFor(item), evidenceFileName(item))
      } catch {
        failed += 1
      }
    }
    setSavingAll(false)
    if (failed === 0) toast.success(`Saved ${evidence.length} file${evidence.length === 1 ? '' : 's'}`)
    else toast.error(`${failed} of ${evidence.length} file${evidence.length === 1 ? '' : 's'} couldn't be saved`)
  }

  if (evidence.length === 0) {
    return <div style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>No files attached.</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {evidence.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => void downloadAll()}
            disabled={savingAll}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px',
              borderRadius: 7, border: '1px solid var(--ds-border-strong)', background: 'var(--ds-surface)',
              color: 'var(--ds-t1)', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
              cursor: savingAll ? 'wait' : 'pointer',
            }}
          >
            {savingAll
              ? <RefreshCw size={13} className="animate-spin" />
              : <Download size={13} />}
            Download all ({evidence.length})
          </button>
        </div>
      )}

      {evidence.map((item, i) => {
        const url = urls[item.s3Key]
        const busy = busyKey === item.s3Key
        return (
          <div
            key={`${item.s3Key}-${i}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: 10,
              borderRadius: 9, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
            }}
          >
            <div style={{
              width: 56, height: 56, flexShrink: 0, borderRadius: 7, overflow: 'hidden',
              border: '1px solid var(--ds-border)', background: 'var(--ds-bg)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {isBrowserRenderable(item) && url
                ? <img src={url} alt={evidenceFileName(item)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <FileText size={20} style={{ color: 'var(--ds-t3)' }} />}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                <Pill tone={KIND_TONE[item.kind] ?? 'neutral'}>{KIND_LABEL[item.kind] ?? item.kind}</Pill>
                {isPdfEvidence(item) && <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>PDF</span>}
              </div>
              <div
                title={evidenceFileName(item)}
                style={{ fontSize: 13, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {evidenceFileName(item)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{evidenceSizeLabel(item.size)}</div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                aria-label={`Open ${evidenceFileName(item)}`}
                title="Open in a new tab"
                onClick={() => void open(item)}
                disabled={busy}
                style={iconAction}
              >
                {busy ? <RefreshCw size={15} className="animate-spin" /> : <ExternalLink size={15} />}
              </button>
              <button
                type="button"
                aria-label={`Download ${evidenceFileName(item)}`}
                title="Download"
                onClick={() => void download(item)}
                disabled={busy}
                style={{ ...iconAction, color: 'var(--ds-blue)' }}
              >
                <Download size={15} />
              </button>
              {onRemove && (
                <button
                  type="button"
                  aria-label={`Remove ${evidenceFileName(item)}`}
                  title="Remove"
                  onClick={() => onRemove(item)}
                  style={{ ...iconAction, color: 'var(--ds-red)' }}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const iconAction: React.CSSProperties = {
  background: 'none', border: 'none', padding: 6, borderRadius: 6,
  cursor: 'pointer', color: 'var(--ds-t3)', display: 'inline-flex',
}
