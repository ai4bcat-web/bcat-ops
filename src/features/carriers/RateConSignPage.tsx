import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { FileText, PenLine, ShieldCheck, XCircle } from 'lucide-react'
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
import { TmsAlert, TmsButton, TmsCard, TmsInput, TmsMetaList, TmsPublicFrame, TmsTextarea } from '@/features/tms/kit'

// This page is PUBLIC — a carrier opens it from an emailed link with no account.
// It must never import anything that needs Cognito (no useAuth, no apiClient); the
// only backend it talks to is the rate-con-sign Function URL via rateConSignClient.

/** Step AM: the four the broker needs to track the truck. The rep may already have entered some; the carrier fills the rest. */
const DRIVER_FIELDS: RateConRequiredField[] = ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER', 'TRAILER_NUMBER']

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
  // What the rep already put on the assignment fills the form until the carrier types over it.
  const prefill = useMemo<Record<string, string>>(() => ({
    DRIVER_NAME: state?.driverInfo?.driverName ?? '',
    DRIVER_PHONE: state?.driverInfo?.driverPhone ?? '',
    TRUCK_NUMBER: state?.driverInfo?.truckNumber ?? '',
    TRAILER_NUMBER: state?.driverInfo?.trailerNumber ?? '',
  }), [state])
  const valueOf = (field: string): string => fields[field] ?? prefill[field] ?? ''
  const trimmedFields = useMemo(() => {
    const out: Record<string, string> = {}
    for (const field of requiredFields) out[field] = (fields[field] ?? prefill[field] ?? '').trim()
    return out
  }, [requiredFields, fields, prefill])
  const driverFields = requiredFields.filter((f) => DRIVER_FIELDS.includes(f))
  const tripFields = requiredFields.filter((f) => !DRIVER_FIELDS.includes(f))
  const onFile = DRIVER_FIELDS.filter((f) => !requiredFields.includes(f) && prefill[f] !== '')

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
    return <Shell><div className="tms-public-loading">Loading…</div></Shell>
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
    <Shell broker={state.brokerName} title={`Rate confirmation — load ${state.loadNumber}`} width="lg">
      <div className="tms-public-stack">
        <TmsCard>
          <p className="tms-public-intro">
            {state.brokerName} is offering this load to {state.carrierName}. Read it, fill in the trip details and sign below.
          </p>
          <TmsMetaList
            columns={2}
            items={[
              { label: 'Load', value: state.loadNumber },
              { label: 'Carrier', value: state.carrierName },
              { label: 'Rate', value: <span className="tms-public-strong">${formatCents(state.totalCents)}</span> },
              {
                label: 'Link expires',
                value: state.expiresAt ? new Date(state.expiresAt).toLocaleString() : null,
                hidden: !state.expiresAt,
              },
            ]}
          />
        </TmsCard>

        {/* The rate confirmation itself — read before you sign. The PDF sits on a paper matte in both themes. */}
        <TmsCard
          flush
          title={<span className="tms-public-doc-title"><FileText size={15} /> Rate confirmation</span>}
          actions={<a href={state.pdfUrl} target="_blank" rel="noreferrer" className="tms-link">Open PDF</a>}
        >
          <div className="tms-public-paper" data-tms-paper>
            <iframe title="Rate confirmation" src={state.pdfUrl} className="tms-public-pdf" />
          </div>
        </TmsCard>

        {/* Driver and truck: all four are mandatory, and tracking texts this driver. Only the ones the rep has not entered yet are asked. */}
        {driverFields.length > 0 && (
          <TmsCard title="Driver and truck">
            <p className="tms-public-sub">{state.brokerName} tracks this load by the driver’s phone, so all of these are required.</p>
            {onFile.length > 0 && (
              <p className="tms-public-sub" data-testid="driver-on-file">
                Already on file: {onFile.map((f) => `${FIELD_LABELS[f]} ${prefill[f]}`).join(' · ')}
              </p>
            )}
            <div className="tms-public-grid-2">
              {driverFields.map((field) => (
                <div key={field} className="tms-public-field">
                  <label className="tms-public-label" htmlFor={`rate-con-${field}`}>{FIELD_LABELS[field] ?? field}</label>
                  <TmsInput
                    id={`rate-con-${field}`}
                    type={fieldInputType(field)}
                    value={valueOf(field)}
                    onChange={(e) => setFields((prev) => ({ ...prev, [field]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </TmsCard>
        )}

        {/* Other trip details the broker requires before dispatch. */}
        {tripFields.length > 0 && (
          <TmsCard title="Trip details">
            <div className="tms-public-grid-2">
              {tripFields.map((field) => (
                <div key={field} className="tms-public-field">
                  <label className="tms-public-label" htmlFor={`rate-con-${field}`}>{FIELD_LABELS[field] ?? field}</label>
                  <TmsInput
                    id={`rate-con-${field}`}
                    type={fieldInputType(field)}
                    value={valueOf(field)}
                    onChange={(e) => setFields((prev) => ({ ...prev, [field]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </TmsCard>
        )}

        {/* Signature block. */}
        <TmsCard title={<span className="tms-public-doc-title"><PenLine size={15} /> Sign</span>}>
          <div className="tms-public-field">
            <label className="tms-public-label" htmlFor="rate-con-signer">Your full name</label>
            <TmsInput id="rate-con-signer" value={signerName} autoComplete="name"
              onChange={(e) => setSignerName(e.target.value)} />
          </div>
          <label className="tms-public-agree">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              I am authorised to sign for {state.carrierName} and I accept this rate confirmation and its terms.
              Typing my name counts as my signature.
            </span>
          </label>

          {actionError && <TmsAlert tone="red">{actionError}</TmsAlert>}

          <div className="tms-public-actions">
            <TmsButton variant="primary" disabled={!canSign} onClick={sign}>
              <ShieldCheck size={15} /> {busy ? 'Working…' : 'Sign rate confirmation'}
            </TmsButton>
            {!declining && (
              <TmsButton disabled={busy} onClick={() => setDeclining(true)}>
                <XCircle size={15} /> Decline
              </TmsButton>
            )}
            {!fieldsComplete && requiredFields.length > 0 && (
              <span className="tms-public-sub">Fill in every trip detail first.</span>
            )}
          </div>

          {declining && (
            <div className="tms-public-decline">
              <label className="tms-public-label" htmlFor="rate-con-decline">Why are you declining?</label>
              <TmsTextarea id="rate-con-decline" rows={3} value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
              <div className="tms-public-actions">
                <TmsButton variant="destructive" disabled={busy || declineReason.trim() === ''} onClick={decline}>
                  Decline this load
                </TmsButton>
                <TmsButton disabled={busy} onClick={() => { setDeclining(false); setDeclineReason('') }}>
                  Cancel
                </TmsButton>
              </div>
            </div>
          )}
        </TmsCard>
      </div>
    </Shell>
  )
}

function Notice({ tone, title, children }: { tone: 'warn' | 'good'; title: string; children: React.ReactNode }) {
  return (
    <TmsAlert tone={tone === 'good' ? 'green' : 'orange'} title={title}>
      {children}
    </TmsAlert>
  )
}

function Shell({ children, broker, title, width = 'md' }: { children: React.ReactNode; broker?: string; title?: string; width?: 'md' | 'lg' }) {
  return (
    <TmsPublicFrame brand={broker ?? 'BCAT'} subtitle="Rate confirmation" title={title} width={width}>
      {children}
    </TmsPublicFrame>
  )
}

export default RateConSignPage
