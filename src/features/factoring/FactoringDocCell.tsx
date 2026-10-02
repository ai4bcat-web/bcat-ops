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
import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Upload, AlertTriangle, Eye } from 'lucide-react'
import { toast } from 'sonner'
import { uploadRateConfirm, getRateConfirmUrl } from '@/lib/apiClient'
import { assembleInvoice } from '@/lib/otrClient'
import { useLoadDriverDocs } from '@/hooks/useLoadDriverDocs'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import { useAppStore } from '@/store/useAppStore'
import {
  staffUploadDriverDoc,
  removeDriverDocs,
  replaceDriverDocs,
  driverDocValidationError,
  DRIVER_DOC_ACCEPT,
} from '@/lib/driverSubmissionsClient'
import type { Load } from '@/types'

type Kind = 'POD' | 'RATECON'

const LABEL: Record<Kind, string> = { POD: 'POD', RATECON: 'Rate con' }


export function FactoringDocCell({
  kind, present, loadId, proNumber, itemId, staffEmail, onUploaded,
}: {
  kind: Kind
  present: boolean
  /** The Load this PRO resolved to. Without it there is nowhere to put the document. */
  loadId: string | null | undefined
  proNumber: string
  /**
   * The factoring row this cell belongs to, so readiness can be rebuilt the moment a
   * document lands. Readiness is a CACHED blob: attaching a POD does not change it, and
   * without this the row kept saying "missing POD" with the POD sitting right there — which
   * also kept Submit disabled.
   */
  itemId: string
  staffEmail: string
  onUploaded: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const loads = useAppStore((s) => s.loads)
  const updateLoad = useAppStore((s) => s.updateLoad)
  const load: Load | undefined = loadId ? loads.find((l) => l.id === loadId) : undefined

  /*
   * Where the document can actually be opened from.
   *
   * A rate confirmation uploaded in the Loads drawer lives on the load; everything else —
   * a driver scan, a staff upload, this cell's own upload — is a submission document. Both
   * are checked, so "present" and "openable" never disagree.
   */
  const { pods, ratecons } = useLoadDriverDocs(loadId, proNumber)
  const submitted = (kind === 'POD' ? pods : ratecons)[0]
  const loadRateConKey = kind === 'RATECON' ? (load?.rateConfirmKey ?? '') : ''
  const viewUrl = submitted?.url ?? null

  /*
   * The rate confirmation on the Load row has no submission behind it, so it can be
   * previewed and downloaded but not removed from here — removing it means clearing the
   * field on the load, which is the Loads drawer's job and its audit trail.
   */
  const [previewing, setPreviewing] = useState(false)
  const [loadRateConUrl, setLoadRateConUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!previewing || viewUrl || !loadRateConKey || loadRateConUrl) return
    let cancelled = false
    getRateConfirmUrl(loadRateConKey)
      .then((u) => { if (!cancelled) setLoadRateConUrl(u) })
      .catch(() => { if (!cancelled) toast.error('Could not open the document') })
    return () => { cancelled = true }
  }, [previewing, viewUrl, loadRateConKey, loadRateConUrl])

  const canOpen = !!viewUrl || !!loadRateConKey

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!picked.length) return

    const invalid = driverDocValidationError(picked)
    if (invalid) { toast.error(invalid); return }
    if (!load) { toast.error('This PRO is not linked to a load yet — prepare the row first'); return }

    setBusy(true)
    try {

      if (kind === 'RATECON') {
        // Straight onto the load, which is where submit reads it from.
        const key = await uploadRateConfirm(load.id, picked[0])
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
          files: picked,
          submittedByEmail: staffEmail,
          referenceNumber: proNumber || undefined,
          loadId: load.id,
        })
        toast.success(`POD saved for PRO ${proNumber}`)
      }
      await refreshReadiness()
      onUploaded()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not upload the ${LABEL[kind]}`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Rebuild the row's cached readiness, then let the caller refresh.
   *
   * Never allowed to fail the upload: the document is attached either way, and the row can
   * always be rebuilt from its own Refresh button.
   */
  async function refreshReadiness(): Promise<void> {
    try {
      await assembleInvoice(itemId)
    } catch (err) {
      console.warn('[factoring] could not rebuild readiness after the upload', itemId, err)
    }
  }

  const noLoad = !loadId

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {/* Present means openable: the preview is where you confirm it is the right one. */}
      {canOpen && (
        <button
          type="button"
          onClick={() => setPreviewing(true)}
          aria-label={`Preview the ${LABEL[kind]} for PRO ${proNumber}`}
          title={`Preview the ${LABEL[kind]}`}
          style={iconBtn}
        >
          <Eye size={12} />
        </button>
      )}
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

      {previewing && (
        <DocumentPreview
          open
          onClose={() => setPreviewing(false)}
          title={`${LABEL[kind]} \u00b7 PRO ${proNumber || '\u2014'}`}
          subtitle={
            submitted
              ? [
                  submitted.driverName,
                  submitted.pageCount > 1 ? `${submitted.pageCount} pages` : '',
                  submitted.enhanced ? 'cleaned scan' : '',
                ].filter(Boolean).join(' \u00b7 ')
              : 'Uploaded on the load'
          }
          url={viewUrl ?? loadRateConUrl}
          contentType={submitted?.contentType ?? (loadRateConKey ? 'application/pdf' : null)}
          downloadName={`${kind === 'POD' ? 'POD' : 'RateCon'}-${proNumber || 'document'}`}
          accept={DRIVER_DOC_ACCEPT}
          onReplace={
            submitted
              ? async (files) => {
                  await replaceDriverDocs({
                    submissionId: submitted.submissionId,
                    driver: { id: submitted.driverId, name: submitted.driverName, email: null },
                    kind,
                    files,
                    submittedByEmail: staffEmail,
                    referenceNumber: proNumber || undefined,
                    loadId: loadId ?? undefined,
                  })
                  toast.success(`${LABEL[kind]} replaced for PRO ${proNumber}`)
                  await refreshReadiness()
                  onUploaded()
                }
              : undefined
          }
          onRemove={
            submitted
              ? async () => {
                  await removeDriverDocs(submitted.submissionId, kind)
                  toast.success(`${LABEL[kind]} removed from PRO ${proNumber}`)
                  await refreshReadiness()
                  onUploaded()
                }
              : undefined
          }
        />
      )}
    </span>
  )
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, borderRadius: 5, cursor: 'pointer',
  border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
  color: 'var(--ds-t2)', fontFamily: 'inherit',
}
