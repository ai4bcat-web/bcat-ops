import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Upload, FileText, CheckCircle2, Clock, AlertTriangle, PenLine } from 'lucide-react'
import { portal, uploadFile, usingMock, PortalError, type OnboardingState, type ChecklistItem } from './portalApi'
import { ApplicationForm } from './ApplicationForm'
import { getRequirement } from '@/lib/complianceRequirements'
import type { DriverApplicationDraft } from '@/lib/schemas'

// Driver-facing contact info shown on the expired/error page.
const CONTACT_PHONE = '(847) 450-0899'
const CONTACT_EMAIL = 'onboarding@bcatcorp.com'

function statusChip(item: ChecklistItem) {
  if (item.status === 'COMPLETE' || item.status === 'WAIVED')
    return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"><CheckCircle2 size={13} /> Approved</span>
  if (item.status === 'PENDING_REVIEW')
    return <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700"><Clock size={13} /> Awaiting review</span>
  if (item.rejectionReason)
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700"><AlertTriangle size={13} /> Needs attention</span>
  if (item.status === 'NOT_APPLICABLE')
    return <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">N/A</span>
  return <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">To do</span>
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
          <AlertTriangle className="mx-auto mb-4 text-amber-500" size={40} />
          <h1 className="mb-2 text-xl font-semibold text-slate-800">{loadError}</h1>
          <p className="text-slate-500">
            Please contact Ivan Cartage to get a new link:<br />
            <span className="font-medium text-slate-700">{CONTACT_PHONE}</span> · {CONTACT_EMAIL}
          </p>
        </div>
      </Shell>
    )
  }

  if (!state) {
    return <Shell><div className="px-4 py-16 text-center text-slate-400">Loading…</div></Shell>
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
          <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Demo mode — running on local mock data (no backend configured).
          </div>
        )}
        <h1 className="text-2xl font-bold text-slate-800">Welcome {state.firstName} — let's get you on the road.</h1>
        <p className="mt-1 text-slate-500">Complete the items below. Most drivers finish in about 20 minutes.</p>

        {/* Progress */}
        <div className="mt-4 mb-6">
          <div className="mb-1 flex justify-between text-sm text-slate-500"><span>Your progress</span><span>{state.progressPct}%</span></div>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${state.progressPct}%` }} />
          </div>
        </div>

        {Object.entries(groups).map(([cat, items]) => (
          <div key={cat} className="mb-5">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">{cat}</div>
            <div className="space-y-2">
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
    <div className="rounded-xl border border-slate-200 bg-white p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-slate-800">{item.label}{item.required && <span className="ml-1.5 text-xs text-rose-500">required</span>}</div>
          {req?.helpText && <div className="mt-0.5 text-sm text-slate-500">{req.helpText}</div>}
          {item.rejectionReason && (
            <div className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-sm text-amber-700">
              <span className="font-medium">Needs attention:</span> {item.rejectionReason}
            </div>
          )}
        </div>
        <div className="shrink-0">{statusChip(item)}</div>
      </div>

      {/* Actions */}
      {isApplication && appStatus !== 'APPROVED' && (
        <button onClick={onOpenApplication} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white">
          <FileText size={15} /> {appStatus === 'SUBMITTED' ? 'Review application' : 'Start application'}
        </button>
      )}

      {!isApplication && canUpload && (!isDone || item.rejectionReason) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {item.requiresExpiration && (
            <label className="text-sm text-slate-600">
              Expiration <input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} className="ml-1 rounded-md border border-slate-300 px-2 py-1 text-sm" />
            </label>
          )}
          <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          <button disabled={busy} onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            <Upload size={15} /> {item.rejectionReason ? 'Re-upload' : 'Upload photo or PDF'}
          </button>
        </div>
      )}

      {!isApplication && canSign && (!isDone || item.rejectionReason) && (
        <div className="mt-3">
          {!showSign ? (
            <button onClick={() => setShowSign(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white">
              <PenLine size={15} /> Acknowledge & sign
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input value={signName} onChange={(e) => setSignName(e.target.value)} placeholder="Type your full name" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
              <button disabled={busy || !signName.trim()} onClick={handleSign} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Sign</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-xl items-center gap-2.5 px-4 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'linear-gradient(135deg, #1ea8f3 0%, #0b8fd9 100%)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 4h7a4 4 0 0 1 0 8H5z M5 12h8a4 4 0 0 1 0 8H5z" fill="white" /></svg>
          </div>
          <div className="text-sm font-bold text-slate-800">IVAN <span className="text-sky-500">CARTAGE</span></div>
          <div className="ml-auto text-xs text-slate-400">Driver onboarding</div>
        </div>
      </header>
      {children}
    </div>
  )
}
