import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Plus, Trash2, Check } from 'lucide-react'
import {
  driverApplicationSubmitSchema,
  findEmploymentGaps,
  employmentMeetsCoverage,
  addressMeetsCoverage,
  type DriverApplicationDraft,
} from '@/lib/schemas'

type Draft = Partial<DriverApplicationDraft>

interface Props {
  driverId: string
  initial: Draft | null
  onSaveDraft: (draft: Draft) => Promise<void> | void
  onSubmit: (application: Draft) => Promise<void>
  onExit: () => void
}

const STEPS = ['Personal', 'Address history', 'License', 'Employment', 'Driving record', 'Review & sign'] as const

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-base'
const labelCls = 'block text-sm font-medium text-slate-600 mb-1'

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className={labelCls}>{label}</label>{children}</div>
}

export function ApplicationForm({ driverId, initial, onSaveDraft, onSubmit, onExit }: Props) {
  const [step, setStep] = useState(0)
  const [data, setData] = useState<Draft>(() => ({
    driverId,
    addressHistory: [],
    employmentHistory: [],
    accidents: [],
    violations: [],
    endorsements: [],
    ...initial,
  }))
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setData((d) => ({ ...d, [key]: value }))
  }

  const employment = data.employmentHistory ?? []
  const addresses = data.addressHistory ?? []
  const requiredYears = data.cdlNumber || data.cdlIssuedAfterFeb2022 ? 10 : 3
  const gaps = useMemo(() => findEmploymentGaps(employment), [employment])
  const employmentCovered = employmentMeetsCoverage(employment, requiredYears)
  const addressCovered = addressMeetsCoverage(addresses)
  const unexplainedGaps = gaps.filter((_, i) => !(employment[i]?.gapExplanation?.trim()))

  async function goTo(next: number) {
    await onSaveDraft(data)
    setStep(next)
    setErrors([])
  }

  async function handleSubmit() {
    const parsed = driverApplicationSubmitSchema.safeParse(data)
    const problems: string[] = []
    if (!parsed.success) problems.push(...parsed.error.issues.map((i) => i.message))
    if (!employmentCovered) problems.push(`Employment history must cover at least ${requiredYears} years`)
    if (unexplainedGaps.length > 0) problems.push('Explain each employment gap longer than 30 days')
    if (problems.length) { setErrors(problems); return }
    setSubmitting(true)
    try { await onSubmit(data) }
    finally { setSubmitting(false) }
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-6">
      <button onClick={onExit} className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500">
        <ArrowLeft size={15} /> Back to checklist
      </button>

      {/* Stepper */}
      <div className="mb-5 flex items-center gap-1">
        {STEPS.map((s, i) => (
          <div key={s} className={`h-1.5 flex-1 rounded-full ${i <= step ? 'bg-sky-500' : 'bg-slate-200'}`} title={s} />
        ))}
      </div>
      <h2 className="mb-1 text-xl font-semibold text-slate-800">{STEPS[step]}</h2>
      <p className="mb-4 text-sm text-slate-500">Step {step + 1} of {STEPS.length}</p>

      {step === 0 && (
        <div className="space-y-3">
          <Labeled label="Full legal name"><input className={inputCls} value={data.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} /></Labeled>
          <Labeled label="Date of birth"><input type="date" className={inputCls} value={data.dob ?? ''} onChange={(e) => set('dob', e.target.value)} /></Labeled>
          <Labeled label="SSN — last 4 digits only"><input inputMode="numeric" maxLength={4} className={inputCls} value={data.ssnLast4 ?? ''} onChange={(e) => set('ssnLast4', e.target.value.replace(/\D/g, ''))} /></Labeled>
          <Labeled label="Phone"><input type="tel" className={inputCls} value={data.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Labeled>
          <Labeled label="Current address"><input className={inputCls} value={data.currentAddress ?? ''} onChange={(e) => set('currentAddress', e.target.value)} /></Labeled>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">List where you've lived over the past 3 years (49 CFR 391.21).</p>
          {addresses.map((a, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3 space-y-2">
              <input className={inputCls} placeholder="Street" value={a.street ?? ''} onChange={(e) => updateItem('addressHistory', i, { street: e.target.value })} />
              <div className="grid grid-cols-3 gap-2">
                <input className={inputCls} placeholder="City" value={a.city ?? ''} onChange={(e) => updateItem('addressHistory', i, { city: e.target.value })} />
                <input className={inputCls} placeholder="State" value={a.state ?? ''} onChange={(e) => updateItem('addressHistory', i, { state: e.target.value })} />
                <input className={inputCls} placeholder="ZIP" value={a.zip ?? ''} onChange={(e) => updateItem('addressHistory', i, { zip: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="From"><input type="date" className={inputCls} value={a.fromDate ?? ''} onChange={(e) => updateItem('addressHistory', i, { fromDate: e.target.value })} /></Labeled>
                <Labeled label="To (blank = present)"><input type="date" className={inputCls} value={a.toDate ?? ''} onChange={(e) => updateItem('addressHistory', i, { toDate: e.target.value })} /></Labeled>
              </div>
              <button onClick={() => removeItem('addressHistory', i)} className="text-sm text-red-600 inline-flex items-center gap-1"><Trash2 size={13} /> Remove</button>
            </div>
          ))}
          <button onClick={() => addItem('addressHistory', { street: '', city: '', state: '', zip: '', fromDate: '', toDate: '' })} className="inline-flex items-center gap-1 text-sm text-sky-600"><Plus size={14} /> Add residence</button>
          <div className={`text-sm ${addressCovered ? 'text-emerald-600' : 'text-amber-600'}`}>{addressCovered ? '✓ 3-year coverage met' : 'Add residences back to 3 years'}</div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <Labeled label="CDL number"><input className={inputCls} value={data.cdlNumber ?? ''} onChange={(e) => set('cdlNumber', e.target.value)} /></Labeled>
          <div className="grid grid-cols-2 gap-2">
            <Labeled label="State"><input className={inputCls} value={data.cdlState ?? ''} onChange={(e) => set('cdlState', e.target.value)} /></Labeled>
            <Labeled label="Class"><input className={inputCls} value={data.cdlClass ?? ''} onChange={(e) => set('cdlClass', e.target.value)} /></Labeled>
          </div>
          <Labeled label="Expiration"><input type="date" className={inputCls} value={data.cdlExpiration ?? ''} onChange={(e) => set('cdlExpiration', e.target.value)} /></Labeled>
          <Labeled label="Endorsements (comma-separated)"><input className={inputCls} value={(data.endorsements ?? []).join(', ')} onChange={(e) => set('endorsements', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></Labeled>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={!!data.cdlIssuedAfterFeb2022} onChange={(e) => set('cdlIssuedAfterFeb2022', e.target.checked)} />
            My CDL was issued after February 7, 2022
          </label>
          {data.cdlIssuedAfterFeb2022 && (
            <Labeled label="ELDT training provider"><input className={inputCls} value={data.eldtProviderName ?? ''} onChange={(e) => set('eldtProviderName', e.target.value)} /></Labeled>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">Account for the last {requiredYears} years. We'll flag any gap over 30 days for you to explain.</p>
          {employment.map((e, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3 space-y-2">
              <input className={inputCls} placeholder="Employer name" value={e.employerName ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { employerName: ev.target.value })} />
              <input className={inputCls} placeholder="Address" value={e.address ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { address: ev.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                <input className={inputCls} placeholder="Phone" value={e.phone ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { phone: ev.target.value })} />
                <input className={inputCls} placeholder="Position" value={e.position ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { position: ev.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="From"><input type="date" className={inputCls} value={e.fromDate ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { fromDate: ev.target.value })} /></Labeled>
                <Labeled label="To (blank = present)"><input type="date" className={inputCls} value={e.toDate ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { toDate: ev.target.value })} /></Labeled>
              </div>
              <input className={inputCls} placeholder="Reason for leaving" value={e.reasonForLeaving ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { reasonForLeaving: ev.target.value })} />
              <div className="flex gap-4 text-sm text-slate-700">
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!e.subjectToFMCSR} onChange={(ev) => updateItem('employmentHistory', i, { subjectToFMCSR: ev.target.checked })} /> Subject to FMCSR</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!e.safetySensitive} onChange={(ev) => updateItem('employmentHistory', i, { safetySensitive: ev.target.checked })} /> Safety-sensitive</label>
              </div>
              {gaps[i] && (
                <div className="rounded-md bg-amber-50 p-2">
                  <div className="text-xs font-medium text-amber-700">Gap of {gaps[i].days} days before this job — please explain</div>
                  <input className={`${inputCls} mt-1`} placeholder="What were you doing during this gap?" value={e.gapExplanation ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { gapExplanation: ev.target.value })} />
                </div>
              )}
              <button onClick={() => removeItem('employmentHistory', i)} className="text-sm text-red-600 inline-flex items-center gap-1"><Trash2 size={13} /> Remove</button>
            </div>
          ))}
          <button onClick={() => addItem('employmentHistory', { employerName: '', address: '', phone: '', fromDate: '', toDate: '', position: '', reasonForLeaving: '', subjectToFMCSR: false, safetySensitive: false })} className="inline-flex items-center gap-1 text-sm text-sky-600"><Plus size={14} /> Add employer</button>
          <div className={`text-sm ${employmentCovered ? 'text-emerald-600' : 'text-amber-600'}`}>{employmentCovered ? `✓ ${requiredYears}-year coverage met` : `Add history back to ${requiredYears} years`}</div>
          {unexplainedGaps.length > 0 && <div className="text-sm text-amber-600">{unexplainedGaps.length} gap(s) need an explanation before you can submit.</div>}
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-sm font-medium text-slate-600">Accidents in the last 3 years</div>
            {(data.accidents ?? []).map((a, i) => (
              <div key={i} className="mb-2 rounded-lg border border-slate-200 p-3 space-y-2">
                <input type="date" className={inputCls} value={a.date ?? ''} onChange={(e) => updateItem('accidents', i, { date: e.target.value })} />
                <input className={inputCls} placeholder="Nature of accident" value={a.nature ?? ''} onChange={(e) => updateItem('accidents', i, { nature: e.target.value })} />
                <button onClick={() => removeItem('accidents', i)} className="text-sm text-red-600">Remove</button>
              </div>
            ))}
            <button onClick={() => addItem('accidents', { date: '', nature: '', fatalities: 0, injuries: 0, hazmatSpill: false })} className="text-sm text-sky-600 inline-flex items-center gap-1"><Plus size={14} /> Add accident</button>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium text-slate-600">Traffic violations in the last 3 years</div>
            {(data.violations ?? []).map((v, i) => (
              <div key={i} className="mb-2 rounded-lg border border-slate-200 p-3 space-y-2">
                <input type="date" className={inputCls} value={v.date ?? ''} onChange={(e) => updateItem('violations', i, { date: e.target.value })} />
                <input className={inputCls} placeholder="Offense" value={v.offense ?? ''} onChange={(e) => updateItem('violations', i, { offense: e.target.value })} />
                <button onClick={() => removeItem('violations', i)} className="text-sm text-red-600">Remove</button>
              </div>
            ))}
            <button onClick={() => addItem('violations', { date: '', offense: '', location: '', penalty: '' })} className="text-sm text-sky-600 inline-flex items-center gap-1"><Plus size={14} /> Add violation</button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="space-y-4">
          <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
            By typing your name below you certify that all information in this application is true and complete to the
            best of your knowledge (FMCSA electronic signature).
          </div>
          <Labeled label="Type your full legal name to sign"><input className={inputCls} value={data.signatureName ?? ''} onChange={(e) => set('signatureName', e.target.value)} /></Labeled>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-1" checked={!!data.attestation} onChange={(e) => set('attestation', e.target.checked)} />
            I attest that the information provided is true and complete.
          </label>
          {errors.length > 0 && (
            <ul className="rounded-md bg-red-50 p-3 text-sm text-red-700 list-disc list-inside">
              {errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Nav */}
      <div className="mt-6 flex items-center justify-between">
        <button disabled={step === 0} onClick={() => goTo(step - 1)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 disabled:opacity-40">
          <ArrowLeft size={15} /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button onClick={() => goTo(step + 1)} className="inline-flex items-center gap-1 rounded-lg bg-sky-500 px-5 py-2 text-sm font-semibold text-white">
            Save & continue <ArrowRight size={15} />
          </button>
        ) : (
          <button onClick={handleSubmit} disabled={submitting} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">
            <Check size={15} /> {submitting ? 'Submitting…' : 'Submit application'}
          </button>
        )}
      </div>
    </div>
  )

  // ── array helpers ──
  function addItem<K extends keyof Draft>(key: K, item: unknown) {
    setData((d) => ({ ...d, [key]: [...((d[key] as unknown[]) ?? []), item] } as Draft))
  }
  function removeItem<K extends keyof Draft>(key: K, index: number) {
    setData((d) => ({ ...d, [key]: ((d[key] as unknown[]) ?? []).filter((_, i) => i !== index) } as Draft))
  }
  function updateItem<K extends keyof Draft>(key: K, index: number, patch: Record<string, unknown>) {
    setData((d) => {
      const arr = [...((d[key] as Record<string, unknown>[]) ?? [])]
      arr[index] = { ...arr[index], ...patch }
      return { ...d, [key]: arr } as Draft
    })
  }
}
