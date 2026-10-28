import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Check, Clock, FileUp, MapPin, Phone, Truck } from 'lucide-react'
import {
  commitUpload, fetchCarrierUpload, requestUpload, TrackingError,
  type CarrierUploadView, type PortalUploadMeta,
} from '@/lib/trackingClient'
import { putPresignedFile } from '@/lib/apiClient'
import { CARRIER_UPLOADABLE_TYPES, DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import type { ShipmentDocumentType } from '@/types/tms'

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
    <div style={{ minHeight: '100vh', background: '#f4f6f8', color: '#15202b', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', padding: '24px 16px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Truck size={22} style={{ color: '#1ea8f3' }} />
          <div>
            <div style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600 }}>
              {view ? `${view.broker.name} · paperwork` : 'Paperwork'}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{view ? `Load ${view.loadNumber}` : error ? 'Paperwork' : 'Loading…'}</div>
          </div>
        </div>

        {error ? (
          <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: 20, fontSize: 15 }}>
            {error.message}
          </div>
        ) : view ? (
          <div style={{ display: 'grid', gap: 12 }}>
            {view.stops.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px', display: 'grid', gap: 14 }}>
                {view.stops.map((stop, i) => (
                  <div key={`${stop.type}-${i}`} style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: 10, alignItems: 'start' }}>
                    <span style={{ color: '#1ea8f3', marginTop: 2 }}><MapPin size={16} /></span>
                    <div>
                      <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600 }}>{stop.type === 'pickup' ? 'Pickup' : 'Delivery'}</div>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>{[stop.city, stop.state].filter(Boolean).join(', ') || stop.name || 'Stop'}</div>
                      {stop.name && <div style={{ fontSize: 13, color: '#5c6b7a', marginTop: 2 }}>{stop.name}</div>}
                      {stop.appt && <div style={{ fontSize: 13, color: '#5c6b7a', marginTop: 2 }}>Appointment {when(stop.appt)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600, marginBottom: 10 }}>We still need</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {view.needed.map((need) => (
                  <div key={need.type} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15 }}>
                    <span style={{
                      width: 20, height: 20, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: need.satisfied ? '#1b9e4b' : '#fff', border: `1px solid ${need.satisfied ? '#1b9e4b' : '#cdd6df'}`, color: '#fff',
                    }}>
                      {need.satisfied && <Check size={13} />}
                    </span>
                    <span style={{ fontWeight: need.satisfied ? 500 : 600, color: need.satisfied ? '#5c6b7a' : '#15202b', textDecoration: need.satisfied ? 'line-through' : 'none' }}>
                      {need.label}
                    </span>
                  </div>
                ))}
                {view.needed.length === 0 && <div style={{ fontSize: 15, color: '#5c6b7a' }}>Nothing outstanding — send anything else you have.</div>}
              </div>
            </div>

            <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px', display: 'grid', gap: 12 }}>
              <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600 }}>Send a document</div>

              <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#5c6b7a', fontWeight: 600 }}>
                What is it?
                <select
                  value={chosenType}
                  onChange={(e) => setType(e.target.value as ShipmentDocumentType)}
                  disabled={busy}
                  style={{ fontFamily: 'inherit', fontSize: 16, padding: '10px 12px', borderRadius: 10, border: '1px solid #cdd6df', background: '#fff', color: '#15202b', fontWeight: 500 }}
                >
                  {typeChoices.map((choice) => (
                    <option key={choice} value={choice}>{DOCUMENT_TYPE_LABELS[choice]}</option>
                  ))}
                </select>
              </label>

              <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#5c6b7a', fontWeight: 600 }}>
                Pick the file
                <input
                  ref={fileRef}
                  type="file"
                  accept={view.acceptedTypes.join(',')}
                  onChange={pick}
                  disabled={busy}
                  style={{ fontFamily: 'inherit', fontSize: 15, padding: '10px 12px', borderRadius: 10, border: '1px solid #cdd6df', background: '#fff' }}
                />
              </label>
              <div style={{ fontSize: 13, color: '#5c6b7a', marginTop: -4 }}>
                {acceptedWords} up to {mb(view.maxBytes)}.
              </div>

              <button
                type="button"
                onClick={() => void upload()}
                disabled={busy || !file}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  width: '100%', padding: '18px', border: 'none', borderRadius: 12,
                  background: busy || !file ? '#8ac9ef' : '#1ea8f3', color: '#fff',
                  fontSize: 18, fontWeight: 700, fontFamily: 'inherit',
                  cursor: busy || !file ? 'default' : 'pointer',
                }}
              >
                <FileUp size={19} />
                {busy ? 'Sending…' : 'Send this document'}
              </button>

              {stage && (
                <div>
                  <div style={{ height: 6, borderRadius: 3, background: '#e3e8ee', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${stage.pct}%`, background: '#1ea8f3' }} />
                  </div>
                  <div style={{ fontSize: 13, color: '#5c6b7a', marginTop: 6 }}>{stage.label}</div>
                </div>
              )}

              {uploadError && (
                <div style={{ background: '#fff4f4', border: '1px solid #f3c4c4', borderRadius: 12, padding: '14px 16px', fontSize: 14, color: '#8a1f1f' }}>
                  {uploadError}
                </div>
              )}

              {sent && !uploadError && !busy && (
                <div style={{ background: '#f1fbf4', border: '1px solid #bfe6cc', borderRadius: 12, padding: '14px 16px', fontSize: 14, color: '#14612f' }}>
                  Thanks — we have {sent}. Somebody will check it.
                </div>
              )}
            </div>

            {view.uploads.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e3e8ee', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5c6b7a', fontWeight: 600, marginBottom: 10 }}>Received — being reviewed</div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {view.uploads.map((up) => (
                    <div key={up.id} style={{ fontSize: 14 }}>
                      <div style={{ fontWeight: 600 }}>{up.name}</div>
                      <div style={{ color: '#5c6b7a', marginTop: 2 }}>
                        {DOCUMENT_TYPE_LABELS[up.type]} · {when(up.uploadedAt)} · {REVIEW_LABELS[up.reviewStatus] ?? up.reviewStatus}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: 13, color: '#5c6b7a', textAlign: 'center', display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}>
              <Clock size={14} />
              This link stops working {when(view.expiresAt)}.
            </div>

            <div style={{ fontSize: 13, color: '#5c6b7a', textAlign: 'center', display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}>
              <Phone size={14} />
              {view.contactPhone
                ? <a href={`tel:${view.contactPhone}`} style={{ color: '#1ea8f3' }}>{view.contactPhone}</a>
                : 'Call dispatch if anything here looks wrong.'}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default CarrierUploadPage
