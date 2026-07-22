import { useEffect, useRef, useState, useCallback, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { Upload, FileText, CheckCircle2, Clock, AlertTriangle, PenLine } from 'lucide-react'
import { portal, uploadFile, usingMock, PortalError, type OnboardingState, type ChecklistItem } from './portalApi'
import { ApplicationForm } from './ApplicationForm'
import { getRequirement } from '@/lib/complianceRequirements'
import type { DriverApplicationDraft } from '@/lib/schemas'

// Driver-facing contact info shown on the expired/error page.
const CONTACT_PHONE = '(847) 450-0899'
const CONTACT_EMAIL = 'onboarding@bcatcorp.com'

// ── Shared styles (design-system tokens, matching the admin app) ────────────────
const cardStyle: CSSProperties = {
  background: 'var(--ds-surface)',
  border: '1px solid var(--ds-border)',
  borderRadius: 12,
  boxShadow: 'var(--sh-sm)',
  padding: 14,
}
const btnPrimary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  borderRadius: 8, padding: '8px 16px', fontSize: 14, fontWeight: 600,
  background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer',
}
const btnSuccess: CSSProperties = { ...btnPrimary, background: 'var(--ds-green)' }
const inputStyle: CSSProperties = {
  borderRadius: 6, border: '1px solid var(--ds-border)', padding: '6px 10px',
  fontSize: 14, background: 'var(--ds-surface)', color: 'var(--ds-t1)', outline: 'none',
}
const chipBase: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
}

function statusChip(item: ChecklistItem) {
  if (item.status === 'COMPLETE' || item.status === 'WAIVED')
    return <span style={{ ...chipBase, background: 'var(--ds-green-bg)', color: 'var(--ds-green)' }}><CheckCircle2 size={13} /> Approved</span>
  if (item.status === 'PENDING_REVIEW')
    return <span style={{ ...chipBase, background: 'var(--ds-blue-bg)', color: 'var(--ds-blue-dark)' }}><Clock size={13} /> Awaiting review</span>
  if (item.rejectionReason)
    return <span style={{ ...chipBase, background: 'var(--ds-amber-bg)', color: 'var(--ds-amber)' }}><AlertTriangle size={13} /> Needs attention</span>
  if (item.status === 'NOT_APPLICABLE')
    return <span style={{ ...chipBase, background: 'var(--ds-bg-3)', color: 'var(--ds-t3)' }}>N/A</span>
  return <span style={{ ...chipBase, background: 'var(--ds-bg-3)', color: 'var(--ds-t2)' }}>To do</span>
}

export function DriverPortalPage() {
  const { token = '' } = useParams()
  const [state, setState] = useState<OnboardingState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, setView] = useState<'checklist' | 'application'>('checklist')

  const load = useCallback(async () => {
    try {
      setState(await portal<OnboardingState>(token, 'getOnboardingState'))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof PortalError ? err.message : 'Could not load your onboarding')
    }
  }, [token])

  useEffect(() => { load() }, [load])

  // The SPA's index.html title is "BCAT OPS" (internal app) — override for drivers.
  useEffect(() => {
    document.title = 'Ivan Cartage — Driver Onboarding'
    return () => { document.title = 'BCAT OPS' }
  }, [])

  // ── Error / expired page ──
  if (loadError) {
    return (
      <Shell>
        <div className="mx-auto max-w-md px-4 py-16 text-center">
          <AlertTriangle className="mx-auto mb-4" size={40} style={{ color: 'var(--ds-amber)' }} />
          <h1 className="mb-2 text-xl font-semibold" style={{ color: 'var(--ds-t1)' }}>{loadError}</h1>
          <p style={{ color: 'var(--ds-t3)' }}>
            Please contact Ivan Cartage to get a new link:<br />
            <span style={{ fontWeight: 600, color: 'var(--ds-t2)' }}>{CONTACT_PHONE}</span> · {CONTACT_EMAIL}
          </p>
        </div>
      </Shell>
    )
  }

  if (!state) {
    return <Shell><div className="px-4 py-16 text-center" style={{ color: 'var(--ds-t3)' }}>Loading…</div></Shell>
  }

  if (view === 'application') {
    return (
      <Shell>
        <ApplicationForm
          driverId="self"
          initial={state.application.draft as Partial<DriverApplicationDraft> | null}
          onSaveDraft={(draft) => portal(token, 'saveApplicationDraft', { draft }).then(() => undefined)}
          onSubmit={async (application) => {
            await portal(token, 'submitApplication', { application })
            await load()
            setView('checklist')
          }}
          onExit={() => { load(); setView('checklist') }}
        />
      </Shell>
    )
  }

  // Group checklist by category
  const groups = state.checklist.reduce<Record<string, ChecklistItem[]>>((acc, c) => {
    (acc[c.category] ??= []).push(c)
    return acc
  }, {})

  return (
    <Shell>
      <div className="mx-auto max-w-xl px-4 py-6">
        {usingMock && (
          <div className="mb-3 rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--ds-amber-bg)', color: 'var(--ds-amber)' }}>
            Demo mode — running on local mock data (no backend configured).
          </div>
        )}
        <h1 className="text-2xl font-bold" style={{ color: 'var(--ds-t1)' }}>Welcome {state.firstName} — let's get you on the road.</h1>
        <p className="mt-1" style={{ color: 'var(--ds-t3)' }}>Complete the items below. Most drivers finish in about 20 minutes.</p>

        {/* Progress */}
        <div className="mt-4 mb-6">
          <div className="mb-1.5 flex justify-between text-sm" style={{ color: 'var(--ds-t3)' }}>
            <span>Your progress</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t2)', fontWeight: 600 }}>{state.progressPct}%</span>
          </div>
          <div style={{ height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)' }}>
            <div style={{ height: '100%', width: `${state.progressPct}%`, background: state.progressPct === 100 ? 'var(--ds-green)' : 'var(--ds-blue)', transition: 'width 200ms' }} />
          </div>
        </div>

        {Object.entries(groups).map(([cat, items]) => (
          <div key={cat} className="mb-5">
            <div className="mb-2 text-xs font-bold uppercase" style={{ color: 'var(--ds-t3)', letterSpacing: '0.05em' }}>{cat}</div>
            <div className="space-y-2.5">
              {items.map((item) => (
                <ChecklistRow key={item.requirementKey} item={item} token={token} appStatus={state.application.status}
                  onOpenApplication={() => setView('application')} onChanged={load} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Shell>
  )
}

function ChecklistRow({ item, token, appStatus, onOpenApplication, onChanged }: {
  item: ChecklistItem
  token: string
  appStatus: string
  onOpenApplication: () => void
  onChanged: () => Promise<void>
}) {
  const req = getRequirement(item.requirementKey)
  const fileRef = useRef<HTMLInputElement>(null)
  const [expiration, setExpiration] = useState('')
  const [signName, setSignName] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSign, setShowSign] = useState(false)

  const isDone = item.status === 'COMPLETE' || item.status === 'WAIVED' || item.status === 'PENDING_REVIEW' || item.status === 'NOT_APPLICABLE'
  const isApplication = item.requirementKey === 'employment_application'
  const canUpload = item.driverActionable && item.requiresDocument
  const canSign = item.driverActionable && !item.requiresDocument && !isApplication

  async function handleFile(file: File) {
    setBusy(true)
    try { await uploadFile(token, item.requirementKey, file, item.requiresExpiration ? (expiration || undefined) : undefined); await onChanged() }
    catch (e) { alert(e instanceof PortalError ? e.message : 'Upload failed') }
    finally { setBusy(false) }
  }

  async function handleSign() {
    if (!signName.trim()) return
    setBusy(true)
    try { await portal(token, 'eSign', { requirementKey: item.requirementKey, signatureName: signName.trim() }); await onChanged() }
    catch (e) { alert(e instanceof PortalError ? e.message : 'Failed') }
    finally { setBusy(false) }
  }

  return (
    <div style={cardStyle}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div style={{ fontWeight: 600, color: 'var(--ds-t1)' }}>
            {item.label}
            {item.required && <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--ds-red)' }}>required</span>}
          </div>
          {req?.helpText && <div className="mt-0.5 text-sm" style={{ color: 'var(--ds-t3)' }}>{req.helpText}</div>}
          {item.rejectionReason && (
            <div className="mt-2 rounded-md px-2.5 py-1.5 text-sm" style={{ background: 'var(--ds-amber-bg)', color: 'var(--ds-amber)' }}>
              <span style={{ fontWeight: 600 }}>Needs attention:</span> {item.rejectionReason}
            </div>
          )}
        </div>
        <div className="shrink-0">{statusChip(item)}</div>
      </div>

      {/* Actions */}
      {isApplication && appStatus !== 'APPROVED' && (
        <button onClick={onOpenApplication} className="mt-3" style={btnPrimary}>
          <FileText size={15} /> {appStatus === 'SUBMITTED' ? 'Review application' : 'Start application'}
        </button>
      )}

      {!isApplication && canUpload && (!isDone || item.rejectionReason) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {item.requiresExpiration && (
            <label className="text-sm inline-flex items-center gap-1.5" style={{ color: 'var(--ds-t2)' }}>
              Expiration <input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} style={inputStyle} />
            </label>
          )}
          <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          <button disabled={busy} onClick={() => fileRef.current?.click()} style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }}>
            <Upload size={15} /> {item.rejectionReason ? 'Re-upload' : 'Upload photo or PDF'}
          </button>
        </div>
      )}

      {!isApplication && canSign && (!isDone || item.rejectionReason) && (
        <div className="mt-3">
          {!showSign ? (
            <button onClick={() => setShowSign(true)} style={btnPrimary}>
              <PenLine size={15} /> Acknowledge & sign
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input value={signName} onChange={(e) => setSignName(e.target.value)} placeholder="Type your full name" style={{ ...inputStyle, padding: '8px 12px' }} />
              <button disabled={busy || !signName.trim()} onClick={handleSign} style={{ ...btnSuccess, opacity: busy || !signName.trim() ? 0.5 : 1 }}>Sign</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--ds-bg)' }}>
      <header style={{ borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)' }}>
        <div className="mx-auto flex max-w-xl items-center gap-2.5 px-4 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'linear-gradient(135deg, var(--ds-blue) 0%, var(--ds-blue-dark) 100%)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 4h7a4 4 0 0 1 0 8H5z M5 12h8a4 4 0 0 1 0 8H5z" fill="white" /></svg>
          </div>
          <div className="text-sm font-bold" style={{ color: 'var(--ds-t1)' }}>IVAN <span style={{ color: 'var(--ds-blue)' }}>CARTAGE</span></div>
          <div className="ml-auto text-xs" style={{ color: 'var(--ds-t3)' }}>Driver onboarding</div>
        </div>
      </header>
      {children}
    </div>
  )
}
