import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Check, Clock, FileUp, Phone } from 'lucide-react'
import {
  commitUpload, fetchCarrierUpload, requestUpload, TrackingError,
  type CarrierUploadView, type PortalUploadMeta,
} from '@/lib/trackingClient'
import { putPresignedFile } from '@/lib/apiClient'
import { CARRIER_UPLOADABLE_TYPES, DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import type { ShipmentDocumentType } from '@/types/tms'
import { TmsAlert, TmsButton, TmsCard, TmsPublicFrame, TmsSelect, TmsTimeline } from '@/features/tms/kit'

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })

const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`

/**
 * How long to wait before the one retry of a commit the server refused with 409. The
 * PUT has been accepted by then; the commit's HeadObject simply has not seen the new
 * object yet, and a second's pause is the whole fix.
 */
const COMMIT_RETRY_MS = 1200

/** What a carrier reads about a file somebody in the office has not looked at yet. */
const REVIEW_LABELS: Record<string, string> = {
  PENDING: 'Being reviewed',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected — please send another copy',
}

/** "application/pdf, image/jpeg" is not something to show a driver. */
const CONTENT_TYPE_WORDS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
}

/**
 * One commit, retried exactly once when the bytes have not landed. Every other
 * TrackingError — 400 wrong type, 404 dead link, 429 link full — is the server's
 * final answer and is shown as it was written.
 */
async function commitOnceRetrying(
  token: string,
  meta: PortalUploadMeta & { documentId: string; s3Key: string },
): Promise<void> {
  try {
    await commitUpload(token, meta)
    return
  } catch (e) {
    if (!(e instanceof TrackingError) || e.status !== 409) throw e
  }
  // The executor form, not `Promise.withResolvers`: the app compiles against the
  // ES2023 lib, where that method does not exist.
  await new Promise<void>((resolve) => { setTimeout(resolve, COMMIT_RETRY_MS) })
  await commitUpload(token, meta)
}

/**
 * The public page behind a carrier's upload link. No sign-in; the token in the URL is
 * the key. It shows only what `CarrierUploadView` carries — which load this is, what
 * paperwork is still missing and what this link has already sent — because an outside
 * carrier must never see the customer, the rate, the margin or anybody else's
 * documents. Nothing on this page reads from any other source, so there is nothing to
 * leak by accident.
 */
export function CarrierUploadPage() {
  const { token = '' } = useParams()
  const [view, setView] = useState<CarrierUploadView | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [type, setType] = useState<ShipmentDocumentType | ''>('')
  const [file, setFile] = useState<File | null>(null)
  const [stage, setStage] = useState<{ label: string; pct: number } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so the state writes live in an explicit promise chain.
  const refresh = useCallback(() => fetchCarrierUpload(token)
    .then((v) => { setView(v); setError(null) })
    .catch((e: unknown) => {
      setError(e instanceof TrackingError ? { status: e.status, message: e.message } : { status: 0, message: 'Could not load this upload link' })
    }), [token])

  useEffect(() => { void refresh() }, [refresh])

  // The types this load is waiting on come first; the rest of what the portal accepts
  // follows, because a carrier often has a lumper receipt nobody asked for.
  const typeChoices = useMemo<ShipmentDocumentType[]>(() => {
    const needed = (view?.needed ?? []).map((n) => n.type)
    return [...needed, ...CARRIER_UPLOADABLE_TYPES.filter((t) => !needed.includes(t))]
  }, [view])

  const acceptedWords = useMemo(
    () => (view?.acceptedTypes ?? []).map((t) => CONTENT_TYPE_WORDS[t] ?? t).join(', '),
    [view],
  )

  // Derived, not synced: until the carrier picks something, the selection is whatever
  // is still outstanding, so the common case is one tap.
  const chosenType: ShipmentDocumentType =
    type || view?.needed.find((n) => !n.satisfied)?.type || typeChoices[0] || 'POD'

  const pick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null)
    setUploadError(null)
    setSent(null)
  }, [])

  const upload = useCallback(async () => {
    if (!view || !file) return
    // Both checks are the server's rules repeated here so a carrier on a phone finds
    // out before a 15 MB photo crosses the wire, not after.
    const contentType = file.type
    if (!view.acceptedTypes.includes(contentType)) {
      setUploadError(`We can only take ${acceptedWords} files. Photograph or scan it and send that instead.`)
      return
    }
    if (file.size > view.maxBytes) {
      setUploadError(`That file is ${mb(file.size)}. The limit is ${mb(view.maxBytes)} — send a smaller scan or photo.`)
      return
    }

    const meta: PortalUploadMeta = { type: chosenType, name: file.name, contentType, sizeBytes: file.size }
    setUploadError(null)
    setSent(null)
    try {
      // Progress is by step, not by byte: the presigned PUT goes through `fetch`,
      // which cannot report upload progress at all.
      setStage({ label: 'Getting ready…', pct: 10 })
      const ticket = await requestUpload(token, meta)
      setStage({ label: `Sending ${file.name}…`, pct: 45 })
      await putPresignedFile(ticket.uploadUrl, file, contentType)
      setStage({ label: 'Filing it…', pct: 85 })
      await commitOnceRetrying(token, { ...meta, documentId: ticket.documentId, s3Key: ticket.s3Key })
      setSent(file.name)
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      await refresh()
    } catch (e) {
      setUploadError(
        e instanceof TrackingError ? e.message
          : e instanceof Error ? e.message
            : 'Could not send that file. Try again in a minute.',
      )
    } finally {
      setStage(null)
    }
  }, [view, file, chosenType, token, refresh, acceptedWords])

  const busy = stage !== null

  return (
    <TmsPublicFrame
      brand={view?.broker.name}
      subtitle="Paperwork"
      title={view ? `Load ${view.loadNumber}` : error ? 'Paperwork' : 'Loading…'}
      width="md"
      footer={
        <>
          <span className="tms-public-footer-line">
            {view && (<><Clock size={14} />This link stops working {when(view.expiresAt)}.</>)}
          </span>
          {view && (
            <span className="tms-public-footer-line">
              <Phone size={14} />
              {view.contactPhone
                ? <a href={`tel:${view.contactPhone}`}>{view.contactPhone}</a>
                : 'Call dispatch if anything here looks wrong.'}
            </span>
          )}
        </>
      }
    >
      {error ? (
        <TmsAlert tone="red">{error.message}</TmsAlert>
      ) : view ? (
        <div className="tms-public-stack">
          {view.stops.length > 0 && (
            <TmsCard title="Stops">
              <TmsTimeline
                ariaLabel="Stops"
                items={view.stops.map((stop, i) => ({
                  id: `${stop.type}-${i}`,
                  title: [stop.city, stop.state].filter(Boolean).join(', ') || stop.name || 'Stop',
                  tag: stop.type === 'pickup' ? 'Pickup' : 'Delivery',
                  tone: 'blue' as const,
                  description: (
                    <>
                      {stop.name && <div>{stop.name}</div>}
                      {stop.appt && <div>Appointment {when(stop.appt)}</div>}
                    </>
                  ),
                }))}
              />
            </TmsCard>
          )}

          <section className="tms-card tms-public-section">
            <div className="tms-public-label">We still need</div>
            <ul className="tms-public-checklist">
              {view.needed.map((need) => (
                <li key={need.type} className="tms-public-check" data-done={need.satisfied ? 'true' : 'false'}>
                  <span className="tms-public-check-box" aria-hidden="true">
                    {need.satisfied && <Check size={13} />}
                  </span>
                  <span className="tms-public-check-label">{need.label}</span>
                </li>
              ))}
            </ul>
            {view.needed.length === 0 && <div className="tms-muted">Nothing outstanding — send anything else you have.</div>}
          </section>

          <section className="tms-card tms-public-section">
            <div className="tms-public-label">Send a document</div>

            <label className="tms-public-field">
              What is it?
              <TmsSelect value={chosenType} onChange={(e) => setType(e.target.value as ShipmentDocumentType)} disabled={busy}>
                {typeChoices.map((choice) => (
                  <option key={choice} value={choice}>{DOCUMENT_TYPE_LABELS[choice]}</option>
                ))}
              </TmsSelect>
            </label>

            <label className="tms-public-field">
              Pick the file
              <input
                ref={fileRef}
                type="file"
                className="tms-input tms-public-file"
                accept={view.acceptedTypes.join(',')}
                onChange={pick}
                disabled={busy}
              />
            </label>
            <div className="tms-public-sub">{acceptedWords} up to {mb(view.maxBytes)}.</div>

            <TmsButton variant="primary" className="tms-public-cta" onClick={() => void upload()} disabled={busy || !file}>
              <FileUp size={19} />
              {busy ? 'Sending…' : 'Send this document'}
            </TmsButton>

            {stage && (
              <div>
                <div className="tms-public-progress"><div style={{ width: `${stage.pct}%` }} /></div>
                <div className="tms-public-sub">{stage.label}</div>
              </div>
            )}

            {uploadError && <TmsAlert tone="red">{uploadError}</TmsAlert>}

            {sent && !uploadError && !busy && (
              <TmsAlert tone="green">Thanks — we have {sent}. Somebody will check it.</TmsAlert>
            )}
          </section>

          {view.uploads.length > 0 && (
            <TmsCard title="Received — being reviewed">
              <ul className="tms-public-list">
                {view.uploads.map((up) => (
                  <li key={up.id}>
                    <div className="tms-public-strong">{up.name}</div>
                    <div className="tms-public-sub">
                      {DOCUMENT_TYPE_LABELS[up.type]} · {when(up.uploadedAt)} · {REVIEW_LABELS[up.reviewStatus] ?? up.reviewStatus}
                    </div>
                  </li>
                ))}
              </ul>
            </TmsCard>
          )}
        </div>
      ) : null}
    </TmsPublicFrame>
  )
}

export default CarrierUploadPage
