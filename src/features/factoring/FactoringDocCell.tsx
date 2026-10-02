/**
 * The POD and rate confirmation on a factoring row: whether it is there, and a way to
 * put it there or replace it before the invoice goes to OTR.
 *
 * Both documents have to land where the SUBMIT path reads them, which is not one place:
 *
 *  - A rate confirmation is read from `Load.rateConfirmKey`, so it is uploaded onto the
 *    load itself. That is also what the Loads drawer writes, so the two agree.
 *  - A POD is read from the JobsDone PodDocument table or from a DriverSubmissionDoc. The
 *    office cannot write the former — a human assigns those on the PODs page — so an
 *    upload here becomes a submission against the load and its delivery driver, exactly
 *    as a staff upload from the load drawer does.
 *
 * Uploading the wrong thing to the wrong store is how a document appears on screen and is
 * still refused at submit, so this does not invent a third path.
 */
import { useRef, useState } from 'react'
import { Check, Loader2, Upload, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { uploadRateConfirm } from '@/lib/apiClient'
import { useAppStore } from '@/store/useAppStore'
import {
  staffUploadDriverDoc,
  driverDocValidationError,
  DRIVER_DOC_ACCEPT,
} from '@/lib/driverSubmissionsClient'
import { pagesToPdf } from '@/lib/pagesToPdf'
import type { Load } from '@/types'

type Kind = 'POD' | 'RATECON'

const LABEL: Record<Kind, string> = { POD: 'POD', RATECON: 'Rate con' }

/** Several photographed pages become one PDF, as everywhere else documents are taken. */
async function asOneFile(files: File[], kind: Kind): Promise<File[]> {
  if (files.length < 2 && files[0]?.type === 'application/pdf') return files
  try {
    const combined = await pagesToPdf(
      files.map((f) => ({ fileName: f.name, contentType: f.type, blob: f })),
      kind === 'POD' ? 'POD' : 'RATECON',
    )
    if (!combined) return files
    return [new File([combined.blob], combined.fileName, { type: combined.contentType })]
  } catch (err) {
    console.error('[factoring] could not combine pages; sending them as-is', err)
    return files
  }
}

export function FactoringDocCell({
  kind, present, loadId, proNumber, staffEmail, onUploaded,
}: {
  kind: Kind
  present: boolean
  /** The Load this PRO resolved to. Without it there is nowhere to put the document. */
  loadId: string | null | undefined
  proNumber: string
  staffEmail: string
  onUploaded: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const loads = useAppStore((s) => s.loads)
  const updateLoad = useAppStore((s) => s.updateLoad)
  const load: Load | undefined = loadId ? loads.find((l) => l.id === loadId) : undefined

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!picked.length) return

    const invalid = driverDocValidationError(picked)
    if (invalid) { toast.error(invalid); return }
    if (!load) { toast.error('This PRO is not linked to a load yet — prepare the row first'); return }

    setBusy(true)
    try {
      const files = await asOneFile(picked, kind)

      if (kind === 'RATECON') {
        // Straight onto the load, which is where submit reads it from.
        const key = await uploadRateConfirm(load.id, files[0])
        await updateLoad(load.id, { rateConfirmKey: key } as Partial<Load>)
        toast.success(`Rate confirmation saved for PRO ${proNumber}`)
      } else {
        const driverId = load.deliveryDriverId
        if (!driverId) {
          toast.error('This load has no delivery driver, so a POD cannot be attached to it')
          return
        }
        await staffUploadDriverDoc({
          driver: { id: driverId, name: 'Driver', email: null },
          kind: 'POD',
          files,
          submittedByEmail: staffEmail,
          referenceNumber: proNumber || undefined,
          loadId: load.id,
        })
        toast.success(`POD saved for PRO ${proNumber}`)
      }
      onUploaded()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not upload the ${LABEL[kind]}`)
    } finally {
      setBusy(false)
    }
  }

  const noLoad = !loadId

  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy || noLoad}
        aria-label={`${present ? 'Replace' : 'Upload'} the ${LABEL[kind]} for PRO ${proNumber}`}
        title={
          noLoad
            ? 'Prepare this row first so it resolves to a load'
            : present
              ? `Replace the ${LABEL[kind]}`
              : `Upload the ${LABEL[kind]} — OTR will not take the invoice without it`
        }
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          height: 24, padding: '0 7px', borderRadius: 6,
          fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
          cursor: busy || noLoad ? 'default' : 'pointer',
          opacity: noLoad ? 0.5 : 1, whiteSpace: 'nowrap',
          ...(present
            ? { border: '1px solid #86efac', background: '#dcfce7', color: '#15803d' }
            : { border: '1px solid #fca5a5', background: '#fee2e2', color: '#b91c1c' }),
        }}
      >
        {busy ? (
          <Loader2 size={11} className="animate-spin" />
        ) : present ? (
          <Check size={11} />
        ) : (
          <AlertTriangle size={11} />
        )}
        {LABEL[kind]}
        {!busy && <Upload size={10} style={{ opacity: 0.7 }} />}
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
