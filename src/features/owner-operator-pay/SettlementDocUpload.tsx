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
  driverDocValidationError,
  DRIVER_DOC_ACCEPT,
  type SubmissionKind,
} from '@/lib/driverSubmissionsClient'
import { pagesToPdf } from '@/lib/pagesToPdf'
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
  onUploaded: () => void
}

const LABEL: Record<SubmissionKind, string> = { POD: 'POD', RATECON: 'Rate con' }

/** Combine what was selected into one PDF, or hand back the originals if that fails. */
async function asOneFile(files: File[], kind: SubmissionKind): Promise<File[]> {
  if (files.length < 2 && files[0]?.type === 'application/pdf') return files
  try {
    const combined = await pagesToPdf(
      files.map((f) => ({ fileName: f.name, contentType: f.type, blob: f })),
      kind === 'POD' ? 'POD' : 'RATECON',
    )
    if (!combined) return files
    return [new File([combined.blob], combined.fileName, { type: combined.contentType })]
  } catch (err) {
    console.error('[settlement-upload] could not combine pages; sending them as-is', err)
    return files
  }
}

export function SettlementDocUpload({
  driver, loadId, proNumber, kind, staffEmail, present, onUploaded,
}: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  if (present) {
    return (
      <CheckCircle2
        size={13}
        style={{ color: '#15803d', verticalAlign: '-2px' }}
        aria-label={`${LABEL[kind]} on file`}
      />
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
      const files = await asOneFile(picked, kind)
      await staffUploadDriverDoc({
        driver: { id: driver.id, name: driver.name, email: driver.email },
        kind,
        files,
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
        title={`Upload the ${kind === 'POD' ? 'POD' : 'rate confirmation'} for PRO ${proNumber || 'this load'}`}
        aria-label={`Upload ${LABEL[kind]} for ${proNumber || loadId}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          height: 22, padding: '0 7px', borderRadius: 6,
          border: '1px solid #fcd34d', background: '#fffbeb', color: '#b45309',
          fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
          cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap',
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
