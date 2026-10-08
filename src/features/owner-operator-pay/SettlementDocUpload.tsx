/**
 * Upload a POD or rate confirmation from the settlement row that is missing it.
 *
 * The settlement is where someone finds out a load cannot be invoiced, and — now that a
 * missing POD holds the driver's pay — where they most want to fix it. Sending them off
 * to the Loads drawer or the PODs page to do that is how paperwork sits for a week.
 *
 * Several photographed pages become ONE PDF before upload, the same way the driver app
 * does it, so the office never has to assemble loose images. A combine failure falls
 * back to sending the pages as they are: a POD in hand is worth more than a tidy one.
 *
 * Uploading writes a DriverSubmission against the load, which is what the readiness
 * check reads (see src/lib/podPresence.ts). The driver sees it in their PWA too, so a
 * POD the office scanned and one the driver scanned end up in the same place.
 */
import { useRef, useState } from 'react'
import { Loader2, Upload, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  staffUploadDriverDoc,
  removeDriverDocs,
  replaceDriverDocs,
  driverDocValidationError,
  DRIVER_DOC_ACCEPT,
  type SubmissionKind,
} from '@/lib/driverSubmissionsClient'
import { useLoadDriverDocs } from '@/hooks/useLoadDriverDocs'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import type { Driver } from '@/types'

interface Props {
  driver: Pick<Driver, 'id' | 'name' | 'email'>
  /** The Load's own id — the strongest link, and what the POD check prefers. */
  loadId: string
  /** The PRO, so a POD still matches if the load link is ever lost. */
  proNumber: string
  kind: SubmissionKind
  /** Who is uploading, recorded on the submission. */
  staffEmail: string
  /** True once the document is on file; the cell then just shows a tick. */
  present: boolean
  /**
   * False when a missing document does not hold anything up. Only the POD does: it gates
   * the driver's pay, so its absence is amber. A rate confirmation is the office's to
   * collect at factoring, so an empty one is an ordinary to-do, not a warning — styling
   * it the same way trains people to ignore the colour that matters.
   */
  blocking?: boolean
  onUploaded: () => void
}

const LABEL: Record<SubmissionKind, string> = { POD: 'POD', RATECON: 'Rate con', MISC: 'Photo' }


export function SettlementDocUpload({
  driver, loadId, proNumber, kind, staffEmail, present, blocking = true, onUploaded,
}: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  /*
   * Only looked up once the document is on file. A settlement shows a whole week of loads
   * at once, and presigning a document for every row of every week would be a lot of work
   * for a column most people only glance at.
   */
  const { pods, ratecons, refresh } = useLoadDriverDocs(present ? loadId : null, present ? proNumber : null)
  const doc = (kind === 'POD' ? pods : ratecons)[0] ?? null

  /*
   * A green tick used to be the whole story, which left the one question anyone has about
   * a POD on a settlement — "is that actually the right document?" — with nowhere to go but
   * the Loads page. The tick is now the way in to the document itself.
   */
  if (present) {
    return (
      <>
        <button
          type="button"
          onClick={() => setPreviewing(true)}
          aria-label={`Preview the ${LABEL[kind]} for ${proNumber || 'this load'}`}
          title={`Preview the ${LABEL[kind]}`}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', background: 'none', padding: 2, cursor: 'pointer',
            color: '#15803d', fontFamily: 'inherit',
          }}
        >
          <CheckCircle2 size={13} />
        </button>
        {previewing && (
          <DocumentPreview
            open
            onClose={() => setPreviewing(false)}
            title={`${LABEL[kind]} \u00b7 PRO ${proNumber || '\u2014'}`}
            subtitle={
              doc
                ? [doc.driverName, doc.pageCount > 1 ? `${doc.pageCount} pages` : '', doc.enhanced ? 'cleaned scan' : '']
                    .filter(Boolean).join(' \u00b7 ')
                : 'Finding the document\u2026'
            }
            url={doc?.url ?? null}
            contentType={doc?.contentType}
            downloadName={`${kind === 'POD' ? 'POD' : 'RateCon'}-${proNumber || loadId.slice(-6)}`}
            accept={DRIVER_DOC_ACCEPT}
            onReplace={
              doc
                ? async (files) => {
                    await replaceDriverDocs({
                      submissionId: doc.submissionId,
                      driver,
                      kind,
                      files,
                      submittedByEmail: staffEmail,
                      referenceNumber: proNumber || undefined,
                      loadId,
                    })
                    toast.success(`${LABEL[kind]} replaced`)
                    refresh()
                    onUploaded()
                  }
                : undefined
            }
            onRemove={
              doc
                ? async () => {
                    await removeDriverDocs(doc.submissionId, kind)
                    toast.success(`${LABEL[kind]} removed`)
                    refresh()
                    onUploaded()
                  }
                : undefined
            }
          />
        )}
      </>
    )
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!picked.length) return

    const invalid = driverDocValidationError(picked)
    if (invalid) {
      toast.error(invalid)
      return
    }

    setBusy(true)
    try {
      await staffUploadDriverDoc({
        driver: { id: driver.id, name: driver.name, email: driver.email },
        kind,
        files: picked,
        submittedByEmail: staffEmail,
        referenceNumber: proNumber || undefined,
        loadId,
      })
      toast.success(
        kind === 'POD'
          ? `POD uploaded${proNumber ? ` for PRO ${proNumber}` : ''} — this load can be paid now`
          : `Rate confirmation uploaded${proNumber ? ` for PRO ${proNumber}` : ''}`,
      )
      onUploaded()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not upload the ${LABEL[kind]}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        title={
          kind === 'POD'
            ? `Upload the POD for PRO ${proNumber || 'this load'} — this load is not paid without it`
            : `Upload the rate confirmation for PRO ${proNumber || 'this load'} — optional here, usually added in the factoring queue`
        }
        aria-label={`Upload ${LABEL[kind]} for ${proNumber || loadId}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          height: 22, padding: '0 7px', borderRadius: 6,
          fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
          cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap',
          ...(blocking
            ? { border: '1px solid #fcd34d', background: '#fffbeb', color: '#b45309' }
            : { border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)' }),
        }}
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
        {LABEL[kind]}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={DRIVER_DOC_ACCEPT}
        onChange={(e) => void onPick(e)}
        style={{ display: 'none' }}
      />
    </>
  )
}
