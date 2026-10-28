import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, FileText, PenLine, ShieldCheck, XCircle } from 'lucide-react'
import {
  declineRateCon,
  getRateCon,
  rateConSignAvailable,
  submitRateCon,
  RateConSignError,
  type RateConSignState,
} from '@/lib/rateConSignClient'
import { stampSignature } from '@/lib/carrierRateCon'
import { formatCents } from '@/lib/tmsDirectory'
import type { RateConRequiredField, RateConStatus } from '@/types/tms'

// This page is PUBLIC — a carrier opens it from an emailed link with no account.
// It must never import anything that needs Cognito (no useAuth, no apiClient); the
// only backend it talks to is the rate-con-sign Function URL via rateConSignClient.

// ── Shared styles (design-system tokens, matching the driver portal) ────────────
const cardStyle: CSSProperties = {
  background: 'var(--ds-surface)',
  border: '1px solid var(--ds-border)',
  borderRadius: 12,
  boxShadow: 'var(--sh-sm)',
  padding: 14,
}
const btnPrimary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7,
  borderRadius: 9, padding: '11px 22px', fontSize: 14, fontWeight: 600,
  background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer',
}
const btnGhost: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7,
  borderRadius: 9, padding: '11px 18px', fontSize: 14, fontWeight: 600,
  background: 'var(--ds-surface)', color: 'var(--ds-t2)',
  border: '1px solid var(--ds-border)', cursor: 'pointer',
}
const btnDanger: CSSProperties = { ...btnPrimary, background: 'var(--ds-red)' }
const inputStyle: CSSProperties = {
  width: '100%', borderRadius: 7, border: '1px solid var(--ds-border)', padding: '9px 12px',
  fontSize: 14, background: 'var(--ds-surface)', color: 'var(--ds-t1)', outline: 'none',
}
const labelStyle: CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
  textTransform: 'uppercase', color: 'var(--ds-t3)', marginBottom: 4,
}
// Centered content column — matches the driver portal (720px, generous padding).
const PORTAL_COL = 'mx-auto w-full px-6 py-8'
const PORTAL_MAXW: CSSProperties = { maxWidth: 720 }

const FIELD_LABELS: Record<RateConRequiredField, string> = {
  DRIVER_NAME: 'Driver name',
  DRIVER_PHONE: 'Driver phone',
  TRUCK_NUMBER: 'Truck number',
  TRAILER_NUMBER: 'Trailer number',
  PICKUP_ETA: 'Pickup ETA',
  PLATES: 'Plates',
  VIN: 'VIN',
}

// Statuses the signing endpoint can hand back that leave nothing to sign. SENT and
// OPENED are the only two that render the form.
const CLOSED_STATUS_MESSAGES: Record<Exclude<RateConStatus, 'SENT' | 'OPENED'>, string> = {
  NOT_SENT: 'This rate confirmation has not been sent out yet.',
  SIGNED: 'This rate confirmation has already been signed. Nothing further is needed.',
  DECLINED: 'This rate confirmation was declined. Contact your broker representative if that was a mistake.',
  VOIDED: 'This rate confirmation was voided by the broker. Ask for a new link.',
  EXPIRED: 'This rate confirmation link has expired. Ask your broker representative for a new one.',
}

function fieldInputType(field: RateConRequiredField): string {
  if (field === 'DRIVER_PHONE') return 'tel'
  if (field === 'PICKUP_ETA') return 'datetime-local'
  return 'text'
}

/** PDFs run to hundreds of kilobytes — convert in chunks so the spread stays inside
 *  the engine's argument limit. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function RateConSignPage() {
  const { token = '' } = useParams()
  const [state, setState] = useState<RateConSignState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => rateConSignAvailable && token !== '')

  const [fields, setFields] = useState<Record<string, string>>({})
  const [signerName, setSignerName] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [declineReason, setDeclineReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'SIGNED' | 'DECLINED' | null>(null)
  // Captured when the link loads, so the expiry check below stays pure across re-renders.
  const [loadedAt, setLoadedAt] = useState<number | null>(null)

  // The SPA's index.html title is "BCAT OPS" (internal app) — override for carriers.
  useEffect(() => {
    document.title = 'Rate confirmation'
    return () => { document.title = 'BCAT OPS' }
  }, [])

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!rateConSignAvailable || token === '') return
    getRateCon(token)
      .then((next) => {
        setState(next)
        setLoadedAt(Date.now())
        setLoadError(null)
      })
      .catch((err) => {
        setLoadError(err instanceof RateConSignError ? err.message : 'Could not load this rate confirmation')
      })
      .finally(() => setLoading(false))
  }, [token])

  const requiredFields = useMemo<RateConRequiredField[]>(() => state?.requiredFields ?? [], [state])
  const trimmedFields = useMemo(() => {
    const out: Record<string, string> = {}
    for (const field of requiredFields) out[field] = (fields[field] ?? '').trim()
    return out
  }, [requiredFields, fields])

  // The link is dead the moment it lapses, even if the row still says SENT — the
  // Lambda refuses a late submit, so never show a form that cannot be posted.
  const expired = !!state && (
    state.status === 'EXPIRED'
    || (
      !!state.expiresAt && loadedAt != null
      && Number.isFinite(Date.parse(state.expiresAt)) && Date.parse(state.expiresAt) < loadedAt
    )
  )
  const closedStatus: RateConStatus | null = !state
    ? null
    : expired ? 'EXPIRED'
      : state.status !== 'SENT' && state.status !== 'OPENED' ? state.status
        : null

  // ── The backend is not wired up (no Function URL in amplify_outputs.json) ──
  if (!rateConSignAvailable) {
    return (
      <Shell>
        <Notice tone="warn" title="Rate confirmation signing is not available">
          This link cannot be opened because the signing service is not configured. Contact your broker
          representative and they will send the rate confirmation another way.
        </Notice>
      </Shell>
    )
  }

  if (loading) {
    return <Shell><div className="px-4 py-16 text-center" style={{ color: 'var(--ds-t3)' }}>Loading…</div></Shell>
  }

  // ── Not found / dead link ──
  if (loadError || !state) {
    return (
      <Shell>
        <Notice tone="warn" title={loadError ?? 'This rate confirmation link is not valid'}>
          Ask your broker representative for a new link.
        </Notice>
      </Shell>
    )
  }

  if (outcome === 'SIGNED') {
    return (
      <Shell broker={state.brokerName}>
        <Notice tone="good" title={`Signed — thank you, ${state.carrierName}.`}>
          Load {state.loadNumber} is confirmed at ${formatCents(state.totalCents)}. The signed rate confirmation
          has been filed with {state.brokerName}. You can close this page.
        </Notice>
      </Shell>
    )
  }

  if (outcome === 'DECLINED') {
    return (
      <Shell broker={state.brokerName}>
        <Notice tone="warn" title="Rate confirmation declined">
          We let {state.brokerName} know that load {state.loadNumber} was declined. You can close this page.
        </Notice>
      </Shell>
    )
  }

  // ── Expired / already signed / declined / voided — a message, never a form ──
  if (closedStatus) {
    return (
      <Shell broker={state.brokerName}>
        <Notice
          tone={closedStatus === 'SIGNED' ? 'good' : 'warn'}
          title={`Load ${state.loadNumber} — ${state.carrierName}`}
        >
          {CLOSED_STATUS_MESSAGES[closedStatus]}
        </Notice>
      </Shell>
    )
  }

  const fieldsComplete = requiredFields.every((field) => trimmedFields[field] !== '')
  const canSign = !busy && fieldsComplete && signerName.trim() !== '' && agreed

  const sign = async () => {
    setActionError(null)
    setBusy(true)
    try {
      const response = await fetch(state.pdfUrl)
      if (!response.ok) throw new Error('Could not download the rate confirmation to sign')
      const original = new Uint8Array(await response.arrayBuffer())
      const signed = await stampSignature(original, {
        name: signerName.trim(),
        // The authoritative signer IP is recorded server-side from the request context.
        ip: '',
        at: new Date().toISOString(),
        fields: trimmedFields,
      })
      await submitRateCon({
        token,
        signerName: signerName.trim(),
        fields: trimmedFields,
        pdfBase64: toBase64(signed),
      })
      setOutcome('SIGNED')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not submit your signature')
    } finally {
      setBusy(false)
    }
  }

  const decline = async () => {
    setActionError(null)
    setBusy(true)
    try {
      await declineRateCon({ token, reason: declineReason.trim() })
      setOutcome('DECLINED')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not decline this rate confirmation')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell broker={state.brokerName}>
      <div className={PORTAL_COL} style={PORTAL_MAXW}>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--ds-t1)' }}>
          Rate confirmation — load {state.loadNumber}
        </h1>
        <p className="mt-1" style={{ color: 'var(--ds-t3)' }}>
          {state.brokerName} is offering this load to {state.carrierName} at{' '}
          <span style={{ fontWeight: 600, color: 'var(--ds-t2)' }}>${formatCents(state.totalCents)}</span>.
          Read it, fill in the trip details and sign below.
          {state.expiresAt && ` This link expires ${new Date(state.expiresAt).toLocaleString()}.`}
        </p>

        {/* The rate confirmation itself — read before you sign. */}
        <div className="mt-4" style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
          <div className="flex items-center gap-2 px-3.5 py-2.5" style={{ borderBottom: '1px solid var(--ds-border)' }}>
            <FileText size={15} style={{ color: 'var(--ds-t3)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--ds-t1)' }}>Rate confirmation</span>
            <a href={state.pdfUrl} target="_blank" rel="noreferrer"
              className="ml-auto text-sm font-semibold" style={{ color: 'var(--ds-blue)', textDecoration: 'none' }}>
              Open PDF
            </a>
          </div>
          <iframe title="Rate confirmation" src={state.pdfUrl} style={{ width: '100%', height: 520, border: 'none', display: 'block' }} />
        </div>

        {/* Trip details the broker requires before dispatch. */}
        {requiredFields.length > 0 && (
          <div className="mt-4" style={cardStyle}>
            <div className="mb-3 text-sm font-semibold" style={{ color: 'var(--ds-t1)' }}>Trip details</div>
            <div className="grid grid-cols-2 gap-3">
              {requiredFields.map((field) => (
                <div key={field}>
                  <label style={labelStyle} htmlFor={`rate-con-${field}`}>{FIELD_LABELS[field] ?? field}</label>
                  <input
                    id={`rate-con-${field}`}
                    type={fieldInputType(field)}
                    style={inputStyle}
                    value={fields[field] ?? ''}
                    onChange={(e) => setFields((prev) => ({ ...prev, [field]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Signature block. */}
        <div className="mt-4" style={cardStyle}>
          <div className="mb-3 flex items-center gap-2">
            <PenLine size={15} style={{ color: 'var(--ds-t3)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--ds-t1)' }}>Sign</span>
          </div>
          <label style={labelStyle} htmlFor="rate-con-signer">Your full name</label>
          <input id="rate-con-signer" style={inputStyle} value={signerName} autoComplete="name"
            onChange={(e) => setSignerName(e.target.value)} />
          <label className="mt-3 flex items-start gap-2.5 text-sm" style={{ color: 'var(--ds-t2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={agreed} style={{ marginTop: 3 }}
              onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              I am authorised to sign for {state.carrierName} and I accept this rate confirmation and its terms.
              Typing my name counts as my signature.
            </span>
          </label>

          {actionError && <p className="mt-3 text-sm" style={{ color: 'var(--ds-red)' }}>{actionError}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button type="button" style={{ ...btnPrimary, opacity: canSign ? 1 : 0.5, cursor: canSign ? 'pointer' : 'not-allowed' }}
              disabled={!canSign} onClick={sign}>
              <ShieldCheck size={15} /> {busy ? 'Working…' : 'Sign rate confirmation'}
            </button>
            {!declining && (
              <button type="button" style={btnGhost} disabled={busy} onClick={() => setDeclining(true)}>
                <XCircle size={15} /> Decline
              </button>
            )}
            {!fieldsComplete && requiredFields.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--ds-t3)' }}>Fill in every trip detail first.</span>
            )}
          </div>

          {declining && (
            <div className="mt-4" style={{ borderTop: '1px solid var(--ds-border)', paddingTop: 14 }}>
              <label style={labelStyle} htmlFor="rate-con-decline">Why are you declining?</label>
              <textarea id="rate-con-decline" rows={3} style={{ ...inputStyle, resize: 'vertical' }}
                value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
              <div className="mt-2.5 flex items-center gap-2.5">
                <button type="button" disabled={busy || declineReason.trim() === ''}
                  style={{ ...btnDanger, opacity: busy || declineReason.trim() === '' ? 0.5 : 1 }}
                  onClick={decline}>
                  Decline this load
                </button>
                <button type="button" style={btnGhost} disabled={busy}
                  onClick={() => { setDeclining(false); setDeclineReason('') }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}

function Notice({ tone, title, children }: { tone: 'warn' | 'good'; title: string; children: React.ReactNode }) {
  const Icon = tone === 'good' ? CheckCircle2 : AlertTriangle
  const color = tone === 'good' ? 'var(--ds-green)' : 'var(--ds-amber)'
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <Icon className="mx-auto mb-4" size={40} style={{ color }} />
      <h1 className="mb-2 text-xl font-semibold" style={{ color: 'var(--ds-t1)' }}>{title}</h1>
      <p style={{ color: 'var(--ds-t3)' }}>{children}</p>
    </div>
  )
}

function Shell({ children, broker }: { children: React.ReactNode; broker?: string }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--ds-bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Black sticky top bar — broker identity, always visible while the carrier scrolls. */}
      <header style={{ position: 'sticky', top: 0, zIndex: 20, background: '#0e1116', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="mx-auto flex w-full items-center gap-3 px-6" style={{ ...PORTAL_MAXW, height: 60 }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: 'linear-gradient(135deg, var(--ds-blue) 0%, var(--ds-blue-dark) 100%)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 4h7a4 4 0 0 1 0 8H5z M5 12h8a4 4 0 0 1 0 8H5z" fill="white" /></svg>
          </div>
          <div>
            <div className="text-sm font-bold" style={{ color: '#fff', letterSpacing: '0.02em' }}>{broker ?? 'BCAT'}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 1 }}>Rate confirmation</div>
          </div>
        </div>
      </header>
      <main style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
        <div style={{ width: '100%', maxWidth: 720 }}>{children}</div>
      </main>
    </div>
  )
}

export default RateConSignPage
