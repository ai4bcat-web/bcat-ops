import { useEffect, useRef, useState } from 'react'
import { Trash2, Upload, ExternalLink, ImagePlus } from 'lucide-react'
import { toast } from 'sonner'
import { getStops, updateStop } from '@/lib/stops'
import { uploadApptProof, getApptProofUrl, deleteApptProof, type ApptProofSlot } from '@/lib/apiClient'
import { apptWorkflowStatus, canMarkRequested, canMarkConfirmed, STATUS_META } from '@/lib/apptStatus'
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

// Batory's ladder needs three screenshots per stop: the REQUEST email (→ REQUESTED),
// then the CONFIRMED email + E2Open update (→ CONFIRMED). Non-Batory loads don't use
// screenshots at all — their confirmation is the RATECON on the load.
const BATORY_SLOTS: { slot: ApptProofSlot; label: string }[] = [
  { slot: 'request', label: 'Request email' },
  { slot: 'e2open',  label: 'E2Open update' },
  { slot: 'email',   label: 'Email confirmation' },
]
export const slotsFor = (_customer: string | null | undefined) => BATORY_SLOTS

export function stopProofCount(s: Stop, _customer?: string | null): number {
  return (s.apptProofs?.request ? 1 : 0) + (s.apptProofs?.e2open ? 1 : 0) + (s.apptProofs?.email ? 1 : 0)
}

/** "n/6" completeness across a Batory shipment's pickup + delivery. */
export function loadProofCount(load: Load): { have: number; want: number } {
  const stops = getStops(load)
  const pu = stops.find((s) => s.type === 'pickup')
  const de = [...stops].reverse().find((s) => s.type === 'delivery')
  const ends = [pu, de].filter(Boolean) as Stop[]
  return { have: ends.reduce((n, s) => n + stopProofCount(s), 0), want: ends.length * 3 }
}

function ProofSlot({ label, s3Key, onUpload, onRemove }: {
  label: string
  s3Key: string | null | undefined
  onUpload: (file: Blob) => Promise<void>
  onRemove: () => Promise<void>
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    setUrl(null)
    if (s3Key) getApptProofUrl(s3Key).then((u) => { if (alive) setUrl(u) }).catch(() => {})
    return () => { alive = false }
  }, [s3Key])

  const handle = async (file: Blob | null | undefined) => {
    if (!file) return
    if (!/^image\//.test(file.type)) { toast.error('That is not an image — paste a screenshot or pick a JPG/PNG.'); return }
    setBusy(true)
    try { await onUpload(file) } finally { setBusy(false) }
  }

  const box: React.CSSProperties = {
    border: '1px dashed var(--ds-border)', borderRadius: 8, minHeight: 74,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: 8, background: 'var(--ds-surface)',
  }

  return (
    <div style={{ flex: 1, minWidth: 180 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
      {s3Key ? (
        <div style={{ ...box, borderStyle: 'solid', justifyContent: 'flex-start' }}>
          {url
            ? <a href={url} target="_blank" rel="noreferrer" title="Open full size">
                <img src={url} alt={`${label} screenshot`} style={{ maxHeight: 58, maxWidth: 120, borderRadius: 5, display: 'block' }} />
              </a>
            : <span style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>loading…</span>}
          <div style={{ flex: 1 }} />
          {url && <a href={url} target="_blank" rel="noreferrer" title="Open full size" style={{ color: 'var(--ds-t3)' }}><ExternalLink size={13} /></a>}
          <button
            onClick={async () => { if (window.confirm(`Remove the ${label} screenshot?`)) { setBusy(true); try { await onRemove() } finally { setBusy(false) } } }}
            disabled={busy} title="Remove screenshot"
            style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer', padding: 2 }}
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
          <ImagePlus size={16} style={{ color: 'var(--ds-t3)' }} />
          <span style={{ fontSize: 11, color: 'var(--ds-t3)', textAlign: 'center' }}>
            {busy ? 'Uploading…' : <>Click + paste screenshot<br />or <button onClick={(e) => { e.stopPropagation(); fileRef.current?.click() }} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--ds-blue)', cursor: 'pointer', font: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Upload size={10} /> browse JPG/PNG</button></>}
          </span>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
            onChange={(e) => { void handle(e.target.files?.[0]); e.target.value = '' }} />
        </div>
      )}
    </div>
  )
}

export function ApptProofPanel({ load, updateLoad }: {
  load: Load
  updateLoad: (id: string, patch: Partial<Load>) => Promise<unknown>
}) {
  const stops = getStops(load)
  const pu = stops.find((s) => s.type === 'pickup')
  const de = [...stops].reverse().find((s) => s.type === 'delivery')
  const SLOTS = slotsFor(load.customer)

  const save = async (stop: Stop, slot: ApptProofSlot, key: string | null) => {
    const proofs = { ...(stop.apptProofs ?? {}), [slot]: key }
    // updateStop works for legacy loads too — getStops synthesizes the pair and the
    // store's dual-write keeps the mirror fields consistent when the array is saved.
    await updateLoad(load.id, { stops: updateStop(load, stop.id, { apptProofs: proofs }) })
  }

  const upload = (stop: Stop, slot: ApptProofSlot) => async (file: Blob) => {
    try {
      const key = await uploadApptProof(load.id, stop.id, slot, file)
      await save(stop, slot, key)
      toast.success('Screenshot saved')
    } catch (e) { toast.error(`Couldn't save the screenshot: ${e instanceof Error ? e.message : 'unknown error'}`) }
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
        ...(status === 'confirmed' ? { apptMoveRequested: false, apptChangeTo: null } : {}),
      }) })
      toast.success(status === 'requested' ? 'Marked REQUESTED' : 'Marked CONFIRMED')
    } catch (e) { toast.error(`Couldn't update the status: ${e instanceof Error ? e.message : 'unknown error'}`) }
  }

  const End = ({ title, stop }: { title: string; stop?: Stop }) => {
    if (!stop) return (
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ds-t2)', marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>No {title.toLowerCase()} stop on this load.</div>
      </div>
    )
    const st = apptWorkflowStatus(stop, load)
    const meta = STATUS_META[st]
    return (
      <div style={{ flex: 1, minWidth: 260 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ds-t2)' }}>{title}</span>
          <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 5,
            background: meta.tone === 'green' ? 'var(--ds-green-bg)' : meta.tone === 'amber' ? 'var(--ds-amber-soft)' : meta.tone === 'blue' ? 'var(--ds-blue-soft, #eff6ff)' : 'var(--ds-red-soft)',
            color: meta.tone === 'green' ? '#15803d' : meta.tone === 'amber' ? '#b45309' : meta.tone === 'blue' ? '#0369a1' : '#dc2626' }}>{meta.label}</span>
          {stop.apptChangeTo && st === 'change_needed' && (
            <span style={{ fontSize: 10.5, color: '#b45309' }}>→ wants {new Date(stop.apptChangeTo).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {SLOTS.map(({ slot, label }) => (
            <ProofSlot key={slot} label={label} s3Key={stop.apptProofs?.[slot]}
              onUpload={upload(stop, slot)} onRemove={removeProof(stop, slot)} />
          ))}
        </div>
        {st !== 'confirmed' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {(st === 'need_request' || st === 'need_book' || st === 'change_needed') && (
              <button
                onClick={() => setStatus(stop, 'requested')}
                disabled={!canMarkRequested(stop)}
                title={canMarkRequested(stop) ? 'Move to REQUESTED' : 'Upload the Request-email screenshot first'}
                style={{ height: 26, padding: '0 10px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                  cursor: canMarkRequested(stop) ? 'pointer' : 'not-allowed', opacity: canMarkRequested(stop) ? 1 : 0.5,
                  border: '1px solid #fcd34d', background: 'var(--ds-surface)', color: '#b45309' }}>
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
                  border: '1px solid #86efac', background: 'var(--ds-surface)', color: '#15803d' }}>
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
      <End title="Pickup" stop={pu} />
      <End title="Delivery" stop={de} />
    </div>
  )
}
