import { useEffect, useRef, useState, useCallback, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { Upload, FileText, CheckCircle2, Clock, AlertTriangle, PenLine, ExternalLink, CalendarCheck, Lock } from 'lucide-react'
import { portal, uploadFile, usingMock, PortalError, type OnboardingState, type ChecklistItem } from './portalApi'
import { ApplicationForm } from './ApplicationForm'
import { getRequirement } from '@/lib/complianceRequirements'
import { getOnboardingTemplate } from '@/lib/onboardingTemplates'
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
  display: 'inline-flex', alignItems: 'center', gap: 7,
  borderRadius: 9, padding: '11px 22px', fontSize: 14, fontWeight: 600,
  background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer',
}
const btnSuccess: CSSProperties = { ...btnPrimary, background: 'var(--ds-green)' }
const inputStyle: CSSProperties = {
  borderRadius: 7, border: '1px solid var(--ds-border)', padding: '9px 12px',
  fontSize: 14, background: 'var(--ds-surface)', color: 'var(--ds-t1)', outline: 'none',
}
// Centered content column — matches the redesign spec (720px, generous padding).
const PORTAL_COL = 'mx-auto w-full px-6 py-8'
const PORTAL_MAXW: CSSProperties = { maxWidth: 720 }
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

  // Group the checklist by phase. Drivers see the whole road ahead, but only the
  // current phase is actionable — earlier phases are done, later phases are locked
  // until the office finalizes the phase before them.
  const isPhased = state.checklist.some((c) => c.phase != null)
  const currentPhase = state.currentPhase ?? 1
  const template = state.templateId ? getOnboardingTemplate(state.templateId) : undefined
  const phaseTitle = (n: number) => template?.phases.find((p) => p.phase === n)?.title ?? `Phase ${n}`

  // Phased → group by phase (ascending); flat/legacy → groups keyed by category.
  const phaseGroups: { phase: number; title: string; items: ChecklistItem[] }[] = isPhased
    ? [...new Set(state.checklist.map((c) => c.phase ?? 1))].sort((a, b) => a - b)
        .map((n) => ({ phase: n, title: phaseTitle(n), items: state.checklist.filter((c) => (c.phase ?? 1) === n) }))
    : Object.entries(
        state.checklist.reduce<Record<string, ChecklistItem[]>>((acc, c) => { (acc[c.category] ??= []).push(c); return acc }, {}),
      ).map(([cat, items], i) => ({ phase: i + 1, title: cat, items }))

  return (
    <Shell>
      <div className={PORTAL_COL} style={PORTAL_MAXW}>
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

        {state.checklist.length === 0 ? (
          <div style={{ ...cardStyle, textAlign: 'center' }}>
            <AlertTriangle className="mx-auto mb-3" size={28} style={{ color: 'var(--ds-amber)' }} />
            <div style={{ fontWeight: 600, color: 'var(--ds-t1)' }}>Your onboarding isn’t set up yet.</div>
            <div className="mt-1 text-sm" style={{ color: 'var(--ds-t3)' }}>
              Please contact Ivan Cartage so we can get you started:<br />
              <span style={{ fontWeight: 600, color: 'var(--ds-t2)' }}>{CONTACT_PHONE}</span> · {CONTACT_EMAIL}
            </div>
          </div>
        ) : (
          phaseGroups.map((g) => {
            const title = g.title
            const locked = isPhased && g.phase > currentPhase
            const isDonePhase = isPhased && g.phase < currentPhase
            const isCurrent = isPhased && g.phase === currentPhase
            return (
              <div key={g.phase} className="mb-5" style={{ opacity: locked ? 0.55 : 1 }}>
                <div className="mb-2 flex items-center gap-2">
                  <div className="text-xs font-bold uppercase" style={{ color: 'var(--ds-t3)', letterSpacing: '0.05em' }}>
                    {isPhased ? `Phase ${g.phase} · ` : ''}{title}
                  </div>
                  {locked && <span style={{ ...chipBase, background: 'var(--ds-bg-3)', color: 'var(--ds-t3)' }}><Lock size={12} /> Locked</span>}
                  {isDonePhase && <span style={{ ...chipBase, background: 'var(--ds-green-bg)', color: 'var(--ds-green)' }}><CheckCircle2 size={12} /> Done</span>}
                  {isCurrent && <span style={{ ...chipBase, background: 'var(--ds-blue-bg)', color: 'var(--ds-blue-dark)' }}>Current step</span>}
                </div>
                {locked && (
                  <div className="mb-2 text-sm" style={{ color: 'var(--ds-t3)' }}>
                    Unlocks once Phase {g.phase - 1} is approved.
                  </div>
                )}
                <div className="space-y-2.5">
                  {g.items.map((item) => (
                    <ChecklistRow key={item.requirementKey} item={item} token={token} appStatus={state.application.status}
                      locked={locked} onOpenApplication={() => setView('application')} onChanged={load} />
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>
    </Shell>
  )
}

function ChecklistRow({ item, token, appStatus, locked: phaseLocked = false, onOpenApplication, onChanged }: {
  item: ChecklistItem
  token: string
  appStatus: string
  /** True when this item's phase isn't unlocked yet — render read-only, no actions. */
  locked?: boolean
  onOpenApplication: () => void
  onChanged: () => Promise<void>
}) {
  const req = getRequirement(item.requirementKey)
  const fileRef = useRef<HTMLInputElement>(null)
  const [expiration, setExpiration] = useState('')
  const [signName, setSignName] = useState('')
  const [completedDate, setCompletedDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSign, setShowSign] = useState(false)

  const inReview = item.status === 'PENDING_REVIEW'
  // Locked once a reviewer finalizes it, OR when its phase isn't unlocked yet.
  const statusLocked = item.status === 'COMPLETE' || item.status === 'WAIVED' || item.status === 'NOT_APPLICABLE'
  const editable = !statusLocked && !phaseLocked  // AWAITING_DRIVER, PENDING, PENDING_REVIEW, or rejected — in the current phase
  const isApplication = item.requirementKey === 'employment_application'
  const canUpload = item.driverActionable && item.requiresDocument
  // Checkbox item that records a completion date (e.g. the drug test).
  const needsDate = !!req?.requiresCompletionDate && item.driverActionable && !item.requiresDocument && !isApplication
  const canSign = item.driverActionable && !item.requiresDocument && !isApplication && !needsDate
  // Edited task links win; fall back to the catalog default links.
  const links = ((item.links ?? req?.links) ?? []).filter((l) => l.url)

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

  async function handleMarkComplete() {
    if (!completedDate) return
    setBusy(true)
    try { await portal(token, 'eSign', { requirementKey: item.requirementKey, completedDate }); await onChanged() }
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
          {links.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium"
                  style={{ background: 'var(--ds-blue-bg)', color: 'var(--ds-blue-dark)', textDecoration: 'none' }}>
                  <ExternalLink size={13} /> {l.label}
                </a>
              ))}
            </div>
          )}
          {item.rejectionReason && (
            <div className="mt-2 rounded-md px-2.5 py-1.5 text-sm" style={{ background: 'var(--ds-amber-bg)', color: 'var(--ds-amber)' }}>
              <span style={{ fontWeight: 600 }}>Needs attention:</span> {item.rejectionReason}
            </div>
          )}
        </div>
        <div className="shrink-0">{statusChip(item)}</div>
      </div>

      {/* Actions */}
      {isApplication && appStatus !== 'APPROVED' && !phaseLocked && (
        <button onClick={onOpenApplication} className="mt-3" style={btnPrimary}>
          <FileText size={15} /> {appStatus === 'SUBMITTED' ? 'Review application' : 'Start application'}
        </button>
      )}

      {inReview && (
        <div className="mt-2 text-xs" style={{ color: 'var(--ds-t3)' }}>
          Submitted for review — you can still change it here until we review it.
        </div>
      )}

      {!isApplication && canUpload && editable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {item.requiresExpiration && (
            <label className="text-sm inline-flex items-center gap-1.5" style={{ color: 'var(--ds-t2)' }}>
              Expiration <input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} style={inputStyle} />
            </label>
          )}
          <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          <button disabled={busy} onClick={() => fileRef.current?.click()} style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }}>
            <Upload size={15} /> {inReview ? 'Replace file' : item.rejectionReason ? 'Re-upload' : 'Upload photo or PDF'}
          </button>
        </div>
      )}

      {!isApplication && canSign && editable && (
        <div className="mt-3">
          {!showSign ? (
            <button onClick={() => setShowSign(true)} style={btnPrimary}>
              <PenLine size={15} /> {inReview ? 'Re-sign' : 'Acknowledge & sign'}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input value={signName} onChange={(e) => setSignName(e.target.value)} placeholder="Type your full name" style={{ ...inputStyle, padding: '8px 12px' }} />
              <button disabled={busy || !signName.trim()} onClick={handleSign} style={{ ...btnSuccess, opacity: busy || !signName.trim() ? 0.5 : 1 }}>Sign</button>
            </div>
          )}
        </div>
      )}

      {!isApplication && needsDate && editable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-sm inline-flex items-center gap-1.5" style={{ color: 'var(--ds-t2)' }}>
            Date drug test completed
            <input type="date" value={completedDate} onChange={(e) => setCompletedDate(e.target.value)} style={inputStyle} />
          </label>
          <button disabled={busy || !completedDate} onClick={handleMarkComplete} style={{ ...btnSuccess, opacity: busy || !completedDate ? 0.5 : 1 }}>
            <CalendarCheck size={15} /> {inReview ? 'Update date' : 'Mark complete'}
          </button>
        </div>
      )}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--ds-bg)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)' }}>
        <div className="mx-auto flex w-full items-center gap-2.5 px-6 py-3.5" style={PORTAL_MAXW}>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'linear-gradient(135deg, var(--ds-blue) 0%, var(--ds-blue-dark) 100%)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 4h7a4 4 0 0 1 0 8H5z M5 12h8a4 4 0 0 1 0 8H5z" fill="white" /></svg>
          </div>
          <div className="text-sm font-bold" style={{ color: 'var(--ds-t1)' }}>IVAN <span style={{ color: 'var(--ds-blue)' }}>CARTAGE</span></div>
          <div className="ml-auto text-xs" style={{ color: 'var(--ds-t3)' }}>Driver onboarding</div>
        </div>
      </header>
      {/* Center the content on the page — vertically + horizontally — and scroll when it's tall.
          `margin: auto` in a flex column centers vertically without clipping the top on overflow. */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ margin: 'auto', width: '100%' }}>{children}</div>
      </main>
    </div>
  )
}
