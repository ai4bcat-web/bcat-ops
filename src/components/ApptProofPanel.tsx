import { useEffect, useRef, useState } from 'react'
import { Trash2, Upload, ExternalLink, ImagePlus } from 'lucide-react'
import { toast } from 'sonner'
import { getStops, updateStop } from '@/lib/stops'
import { graphqlErrorText, uploadApptProof, getApptProofUrl, deleteApptProof, sendApptRequestEmail, type ApptProofSlot } from '@/lib/apiClient'
import { useDirectory } from '@/hooks/useDirectory'
import { formatDateShort, apptTimeLabel } from '@/lib/date'
import { BATORY_PICKUP_REQUEST_TIME, defaultRequestedFor } from '@/lib/apptStatus'
import { Mail } from 'lucide-react'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { apptWorkflowStatus, canMarkRequested, canMarkConfirmed, STATUS_META, STATUS_TONE_COLORS, statusLabel } from '@/lib/apptStatus'
import type { Load, Stop } from '@/types'

/**
 * Booking-proof screenshots for one shipment's appointments.
 *
 * Two slots per stop — the E2Open update and the email confirmation — for the pickup
 * and the delivery: four screenshots when fully documented. Each slot takes a pasted
 * image (click the slot, ⌘/Ctrl+V) or a JPG/PNG upload, stores it in S3 under
 * appt-proofs/, and remembers the key on the stop itself (stops is a.json, so the
 * proof travels with the appointment — same trick as apptThreadTs).
 */

// Batory's ladder needs three screenshots per stop (see src/lib/apptProofs.ts).
const BATORY_SLOTS: { slot: ApptProofSlot; label: string }[] = [
  { slot: 'request', label: 'Request email' },
  { slot: 'e2open',  label: 'E2Open update' },
  { slot: 'email',   label: 'Email confirmation' },
]

function ProofSlot({ label, s3Key, onUpload, onRemove }: {
  label: string
  s3Key: string | null | undefined
  onUpload: (file: Blob) => Promise<void>
  onRemove: () => Promise<void>
}) {
  // The presigned URL is keyed to the stored object: track which key it was fetched for
  // so a slot whose key changed shows nothing (not the old image) until the new URL lands.
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null)
  const url = preview && preview.key === s3Key ? preview.url : null
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!s3Key) return
    let alive = true
    getApptProofUrl(s3Key).then((u) => { if (alive) setPreview({ key: s3Key, url: u }) }).catch(() => {})
    return () => { alive = false }
  }, [s3Key])

  const handle = async (file: Blob | null | undefined) => {
    if (!file) return
    if (!/^image\//.test(file.type)) { toast.error('That is not an image — paste a screenshot or pick a JPG/PNG.'); return }
    setBusy(true)
    try { await onUpload(file) } finally { setBusy(false) }
  }

  const box: React.CSSProperties = {
    border: '1px dashed var(--tms-border)', borderRadius: 8, minHeight: 74,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: 8, background: 'var(--tms-card)',
  }

  return (
    <div style={{ flex: 1, minWidth: 180 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
      {s3Key ? (
        <div style={{ ...box, borderStyle: 'solid', justifyContent: 'flex-start' }}>
          {url
            ? <a href={url} target="_blank" rel="noreferrer" title="Open full size">
                <img src={url} alt={`${label} screenshot`} style={{ maxHeight: 58, maxWidth: 120, borderRadius: 5, display: 'block' }} />
              </a>
            : <span style={{ fontSize: 11.5, color: 'var(--tms-muted)' }}>loading…</span>}
          <div style={{ flex: 1 }} />
          {url && <a href={url} target="_blank" rel="noreferrer" title="Open full size" style={{ color: 'var(--tms-muted)' }}><ExternalLink size={13} /></a>}
          <button
            onClick={async () => { if (window.confirm(`Remove the ${label} screenshot?`)) { setBusy(true); try { await onRemove() } finally { setBusy(false) } } }}
            disabled={busy} title="Remove screenshot"
            style={{ background: 'none', border: 'none', color: 'var(--tms-muted)', cursor: 'pointer', padding: 2 }}
          ><Trash2 size={13} /></button>
        </div>
      ) : (
        <div
          role="button" tabIndex={0}
          aria-label={`${label} — click, then paste a screenshot (Ctrl+V), or use Browse`}
          title="Click here, then paste (⌘/Ctrl+V) — or drop an image, or Browse"
          onPaste={(e) => { const f = Array.from(e.clipboardData.files)[0]; if (f) { e.preventDefault(); void handle(f) } }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void handle(e.dataTransfer.files[0]) }}
          style={{ ...box, cursor: 'pointer', outline: 'none', flexDirection: 'column', gap: 4 }}
          onClick={(e) => (e.currentTarget as HTMLElement).focus()}
          onKeyDown={(e) => { if (e.key === 'Enter') fileRef.current?.click() }}
        >
          <ImagePlus size={16} style={{ color: 'var(--tms-muted)' }} />
          <span style={{ fontSize: 11, color: 'var(--tms-muted)', textAlign: 'center' }}>
            {busy ? 'Uploading…' : <>Click + paste screenshot<br />or <button onClick={(e) => { e.stopPropagation(); fileRef.current?.click() }} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--tms-primary)', cursor: 'pointer', font: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Upload size={10} /> browse JPG/PNG</button></>}
          </span>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
            onChange={(e) => { void handle(e.target.files?.[0]); e.target.value = '' }} />
        </div>
      )}
    </div>
  )
}

/** A readable reason from an Error, a GraphQL error bundle or an Amplify storage error (name + message), never just "unknown". */
function errorDetail(e: unknown): string {
  const text = graphqlErrorText(e)
  const name = (e as { name?: string } | null)?.name
  if (text) return name && name !== 'Error' && !text.includes(name) ? `${name}: ${text}` : text
  return name || (typeof e === 'object' ? JSON.stringify(e)?.slice(0, 200) : String(e)) || 'no detail from the server'
}

export function ApptProofPanel({ load, updateLoad }: {
  load: Load
  updateLoad: (id: string, patch: Partial<Load>) => Promise<unknown>
}) {
  const { locations } = useDirectory()
  const [emailFor, setEmailFor] = useState<Stop | null>(null)
  const stops = getStops(load)
  const pu = stops.find((s) => s.type === 'pickup')
  const de = [...stops].reverse().find((s) => s.type === 'delivery')
  /*
   * Every stop gets a panel, not just the two ends. Batory's ladder is per stop — request,
   * confirm, two screenshots — and a middle pickup with no panel is a stop whose ladder
   * cannot be walked at all.
   */
  const middle = stops.filter((s) => s.id !== pu?.id && s.id !== de?.id)

  const save = async (stop: Stop, slot: ApptProofSlot, key: string | null) => {
    const proofs = { ...(stop.apptProofs ?? {}), [slot]: key }
    // updateStop works for legacy loads too — getStops synthesizes the pair and the
    // store's dual-write keeps the mirror fields consistent when the array is saved.
    await updateLoad(load.id, { stops: updateStop(load, stop.id, { apptProofs: proofs }) })
  }

  const upload = (stop: Stop, slot: ApptProofSlot) => async (file: Blob) => {
    try {
      let key: string
      try { key = await uploadApptProof(load.id, stop.id, slot, file) } catch (e) { throw new Error(`upload to storage failed (${errorDetail(e)})`, { cause: e }) }
      try { await save(stop, slot, key) } catch (e) { throw new Error(`attaching it to the load failed (${errorDetail(e)})`, { cause: e }) }
      toast.success('Screenshot saved')
    } catch (e) { toast.error(`Couldn't save the screenshot: ${errorDetail(e)}`) }
  }
  const removeProof = (stop: Stop, slot: ApptProofSlot) => async () => {
    const key = stop.apptProofs?.[slot]
    try {
      await save(stop, slot, null)
      if (key) void deleteApptProof(key).catch(() => {}) // best-effort; the reference is already gone
      toast.success('Screenshot removed')
    } catch (e) { toast.error(`Couldn't remove it: ${e instanceof Error ? e.message : 'unknown error'}`) }
  }

  const setStatus = async (stop: Stop, status: 'requested' | 'confirmed') => {
    try {
      await updateLoad(load.id, { stops: updateStop(load, stop.id, {
        apptStatus: status,
        ...(status === 'requested' ? { apptRequestedFor: stop.apptRequestedFor ?? defaultRequestedFor(stop) } : {}),
        ...(status === 'confirmed' ? { apptMoveRequested: false, apptChangeTo: null } : {}),
      }) })
      toast.success(status === 'requested' ? 'Marked REQUESTED' : 'Marked CONFIRMED')
    } catch (e) { toast.error(`Couldn't update the status: ${e instanceof Error ? e.message : 'unknown error'}`) }
  }

  const renderEnd = (title: string, stop?: Stop) => {
    if (!stop) return (
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--tms-text-2)', marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>No {title.toLowerCase()} stop on this load.</div>
      </div>
    )
    const st = apptWorkflowStatus(stop, load)
    const meta = STATUS_META[st]
    return (
      <div style={{ flex: 1, minWidth: 260 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tms-text-2)' }}>{title}</span>
          <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 5,
            background: STATUS_TONE_COLORS[meta.tone].bg, color: STATUS_TONE_COLORS[meta.tone].fg }}>{statusLabel(st, stop.type)}</span>
          {stop.apptChangeTo && st === 'change_needed' && (
            <span style={{ fontSize: 10.5, color: 'var(--tms-badge-orange)' }}>→ wants {new Date(stop.apptChangeTo).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {BATORY_SLOTS.map(({ slot, label }) => (
            <ProofSlot key={slot} label={label} s3Key={stop.apptProofs?.[slot]}
              onUpload={upload(stop, slot)} onRemove={removeProof(stop, slot)} />
          ))}
        </div>
        {st !== 'confirmed' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => setEmailFor(stop)}
              title="Email the appointment request to this facility's appt contact (from the Locations directory) — sending marks it REQUESTED"
              style={{ height: 26, padding: '0 10px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                cursor: 'pointer', border: '1px solid var(--tms-border)', background: 'var(--tms-card)', color: 'var(--tms-primary-ink)',
                display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Mail size={12} /> Email appt request
            </button>
            {(st === 'need_request' || st === 'need_book' || st === 'change_needed') && (
              <button
                onClick={() => setStatus(stop, 'requested')}
                disabled={!canMarkRequested(stop)}
                title={canMarkRequested(stop) ? 'Move to REQUESTED' : 'Upload the Request-email screenshot first'}
                style={{ height: 26, padding: '0 10px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                  cursor: canMarkRequested(stop) ? 'pointer' : 'not-allowed', opacity: canMarkRequested(stop) ? 1 : 0.5,
                  border: '1px solid var(--tms-badge-orange)', background: 'var(--tms-card)', color: 'var(--tms-badge-orange)' }}>
                Mark REQUESTED
              </button>
            )}
            {(st === 'requested' || st === 'change_needed') && (
              <button
                onClick={() => setStatus(stop, 'confirmed')}
                disabled={!canMarkConfirmed(stop)}
                title={canMarkConfirmed(stop) ? 'Move to CONFIRMED' : 'Upload the Confirmed-email AND E2Open screenshots first'}
                style={{ height: 26, padding: '0 10px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                  cursor: canMarkConfirmed(stop) ? 'pointer' : 'not-allowed', opacity: canMarkConfirmed(stop) ? 1 : 0.5,
                  border: '1px solid var(--tms-badge-green)', background: 'var(--tms-card)', color: 'var(--tms-badge-green)' }}>
                Mark CONFIRMED
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div data-testid="appt-proofs" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
      {renderEnd('Pickup', pu)}
      {middle.map((s) => renderEnd(s.type === 'pickup' ? 'Extra pickup' : 'Extra drop', s))}
      {renderEnd('Delivery', de)}
      {emailFor && (
        <ApptRequestEmailModal
          load={load} stop={emailFor} locations={locations}
          onSent={async () => {
            // Sending the request IS the request — the ladder advances without a screenshot
            // (the app itself is the record; the audit history logs the transition).
            await updateLoad(load.id, { stops: updateStop(load, emailFor.id, {
              apptStatus: 'requested',
              // What the email actually asked for — shown on the chip as "requested 12:00 PM".
              apptRequestedFor: emailFor.apptRequestedFor ?? defaultRequestedFor(emailFor),
            }) })
            setEmailFor(null)
          }}
          onClose={() => setEmailFor(null)}
        />
      )}
    </div>
  )
}

/**
 * Compose + send the appointment-request email for one stop. To/phone prefill from the
 * Locations directory (matched by facility name); the body prefills the Batory rules —
 * 12:00 PM pickups, Ruben's chosen delivery time, or the CHANGE NEEDED target.
 */
function ApptRequestEmailModal({ load, stop, locations, onSent, onClose }: {
  load: Load
  stop: Stop
  locations: { name: string; city?: string | null; apptContactEmail?: string | null; apptContactPhone?: string | null; apptContactName?: string | null }[]
  onSent: () => Promise<void>
  onClose: () => void
}) {
  const loc = locations.find((l) => l.name.toLowerCase() === (stop.name ?? '').trim().toLowerCase())
  const kind = stop.type === 'delivery' ? 'delivery' : 'pickup'
  const dateStr = stop.appt ? formatDateShort(stop.appt) : 'the scheduled date'
  const wanted = stop.apptChangeTo
    ? `${formatDateShort(stop.apptChangeTo)} at ${apptTimeLabel(stop.apptChangeTo, 'exact')}`
    : kind === 'pickup'
      ? `${dateStr} at ${BATORY_PICKUP_REQUEST_TIME}`
      : `${dateStr}${stop.appt && apptTimeLabel(stop.appt, stop.apptType, stop.apptEnd) !== '—' ? ` at ${apptTimeLabel(stop.appt, stop.apptType, stop.apptEnd)}` : ''}`
  const ref = [load.aljexId ? `Pro# ${load.aljexId}` : null, load.pickupNumber ? `PU# ${load.pickupNumber}` : null].filter(Boolean).join(' · ')

  const [to, setTo] = useState(loc?.apptContactEmail ?? '')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState(`Appointment request — ${ref || 'load'} — ${stop.name ?? ''}`.trim())
  const [body, setBody] = useState([
    `Hello${loc?.apptContactName ? ` ${loc.apptContactName}` : ''},`,
    '',
    stop.apptChangeTo
      ? `We need to MOVE our ${kind} appointment for ${ref || 'the load below'} to ${wanted}. Please confirm the new time.`
      : `We would like to request a ${kind} appointment for ${ref || 'the load below'} on ${wanted}.`,
    '',
    `Facility: ${[stop.name, stop.city].filter(Boolean).join(' — ')}`,
    load.customer ? `Customer: ${load.customer}` : '',
    '',
    'Please reply to confirm. Thank you!',
    '',
    'Dennis — Ivan Cartage / BCAT dispatch',
  ].filter((l) => l !== null).join('\n'))
  const [sending, setSending] = useState(false)

  const inp: React.CSSProperties = { height: 32, width: '100%', borderRadius: 8, border: '1px solid var(--tms-border)', padding: '0 10px', fontSize: 12.5, background: 'var(--tms-card)', color: 'var(--tms-text)', boxSizing: 'border-box' }

  const send = async () => {
    if (!to.trim()) { toast.error('No appointment email — add one to this facility on the Locations page, or type it here.'); return }
    setSending(true)
    try {
      const res = await sendApptRequestEmail({ to: to.trim(), cc: cc.trim() || null, subject, body, replyTo: null })
      if (!res.ok) { toast.error(`Send failed: ${res.error ?? 'unknown error'}`); setSending(false); return }
      toast.success(`Request emailed to ${to.trim()} — marked REQUESTED`)
      await onSent()
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); setSending(false) }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title="Email appointment request"
      className="tms-dialog-wide"
      description={(
        <>
      Sends from dennis@bcatcorp.com — the facility's reply lands with Dennis. Sending marks this {kind} REQUESTED.
      {loc?.apptContactPhone && <> · Phone: <b>{loc.apptContactPhone}</b></>}
      {!loc && <> · <span style={{ color: 'var(--tms-badge-orange)' }}>Facility not found in the Locations directory — add it there to prefill this next time.</span></>}
        </>
      )}
      footer={(
        <>
      <button onClick={onClose} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text-2)', fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
      <button onClick={send} disabled={sending}
        style={{ height: 32, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--tms-primary)', color: 'var(--tms-on-primary)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: sending ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Mail size={13} /> {sending ? 'Sending…' : 'Send request'}
      </button>
        </>
      )}
    >
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
      <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', marginBottom: 3 }}>To *</div>
        <input style={inp} value={to} onChange={(e) => setTo(e.target.value)} placeholder="appointments@facility.com" aria-label="Request to" /></div>
      <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', marginBottom: 3 }}>Cc</div>
        <input style={inp} value={cc} onChange={(e) => setCc(e.target.value)} placeholder="optional" /></div>
    </div>
    <div style={{ marginBottom: 10 }}><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', marginBottom: 3 }}>Subject</div>
      <input style={inp} value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
    <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', marginBottom: 3 }}>Message</div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10}
        style={{ ...inp, height: 'auto', padding: 10, fontFamily: 'inherit', resize: 'vertical' }} aria-label="Request body" /></div>
    </TmsDialog>
  )
}
