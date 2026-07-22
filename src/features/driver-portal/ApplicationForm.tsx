import { useMemo, useState, type CSSProperties } from 'react'
import { ArrowLeft, ArrowRight, Plus, Trash2, Check, Info } from 'lucide-react'
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

// Standard CDL endorsements — tapped, not typed.
const ENDORSEMENTS: { code: string; label: string }[] = [
  { code: 'H', label: 'Hazmat' },
  { code: 'N', label: 'Tanker' },
  { code: 'T', label: 'Doubles / Triples' },
  { code: 'P', label: 'Passenger' },
  { code: 'S', label: 'School bus' },
  { code: 'X', label: 'Hazmat + Tanker' },
]

// A blank row for the two required, list-style sections — pre-seeded so the driver sees
// the fields immediately instead of hunting for an "Add" button.
const BLANK_ADDRESS = { street: '', city: '', state: '', zip: '', fromDate: '', toDate: '' }
const BLANK_EMPLOYMENT = {
  employerName: '', address: '', phone: '', fromDate: '', toDate: '',
  position: '', reasonForLeaving: '', subjectToFMCSR: false, safetySensitive: false,
}

// ── Design-system token styles (match the admin app) ────────────────────────────
const inputStyle: CSSProperties = {
  width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)', padding: '10px 12px',
  fontSize: 16, background: 'var(--ds-surface)', color: 'var(--ds-t1)', outline: 'none',
}
const labelStyle: CSSProperties = { display: 'block', fontSize: 14, fontWeight: 500, color: 'var(--ds-t2)', marginBottom: 4 }
const subCard: CSSProperties = { border: '1px solid var(--ds-border)', borderRadius: 10, background: 'var(--ds-surface)', padding: 12 }
const btnPrimary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 8, padding: '9px 20px',
  fontSize: 14, fontWeight: 600, background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer',
}
const btnSuccess: CSSProperties = { ...btnPrimary, background: 'var(--ds-green)' }
const btnGhost: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 8, padding: '9px 16px',
  fontSize: 14, fontWeight: 500, background: 'var(--ds-surface)', color: 'var(--ds-t2)',
  border: '1px solid var(--ds-border)', cursor: 'pointer',
}
const linkBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 14,
  color: 'var(--ds-blue-dark)', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
}
const removeBtn: CSSProperties = { ...linkBtn, color: 'var(--ds-red)' }

function Req() { return <span style={{ color: 'var(--ds-red)', marginLeft: 3 }} title="Required">*</span> }

// Derive the required `currentAddress` string from the current residence in address
// history (the entry with no move-out date, else the most recent), so we don't ask twice.
function deriveCurrentAddress(addrs: { street?: string; city?: string; state?: string; zip?: string; fromDate?: string; toDate?: string | null }[]): string | undefined {
  if (!addrs.length) return undefined
  const sorted = [...addrs].sort((a, b) => (b.fromDate ?? '').localeCompare(a.fromDate ?? ''))
  const cur = sorted.find((a) => !a.toDate) ?? sorted[0]
  const cityState = [cur.city, cur.state].filter(Boolean).join(', ')
  const line = [cur.street, [cityState, cur.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return line || undefined
}

// The schema accepts a real date, null, or undefined — but NOT an empty string. Date
// inputs emit '' when cleared (blank "to" = present job/residence), so coerce '' → undefined.
// Also default the required booleans that only get set on user interaction, and fill
// currentAddress from the current residence.
function normalizeForSubmit(d: Draft): Draft {
  const blank = (v?: string | null) => (v ? v : undefined)
  const addressHistory = (d.addressHistory ?? []).map((a) => ({ ...a, toDate: blank(a.toDate) }))
  return {
    ...d,
    currentAddress: d.currentAddress?.trim() || deriveCurrentAddress(addressHistory),
    cdlIssuedAfterFeb2022: d.cdlIssuedAfterFeb2022 ?? false,
    addressHistory,
    employmentHistory: (d.employmentHistory ?? []).map((e) => ({
      ...e,
      toDate: blank(e.toDate),
      subjectToFMCSR: e.subjectToFMCSR ?? false,
      safetySensitive: e.safetySensitive ?? false,
    })),
  }
}

function Labeled({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return <div><label style={labelStyle}>{label}{required && <Req />}</label>{children}</div>
}

export function ApplicationForm({ driverId, initial, onSaveDraft, onSubmit, onExit }: Props) {
  const [step, setStep] = useState(0)
  const [data, setData] = useState<Draft>(() => ({
    driverId,
    accidents: [],
    violations: [],
    endorsements: [],
    ...initial,
    cdlIssuedAfterFeb2022: initial?.cdlIssuedAfterFeb2022 ?? false,
    // Required list sections start with one blank row so the fields are visible up front.
    addressHistory: initial?.addressHistory?.length ? initial.addressHistory : [{ ...BLANK_ADDRESS }],
    employmentHistory: initial?.employmentHistory?.length ? initial.employmentHistory : [{ ...BLANK_EMPLOYMENT }],
  }))
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setData((d) => ({ ...d, [key]: value }))
  }

  const employment = data.employmentHistory ?? []
  const addresses = data.addressHistory ?? []
  const endorsements = data.endorsements ?? []
  const requiredYears = data.cdlNumber || data.cdlIssuedAfterFeb2022 ? 10 : 3
  const gaps = useMemo(() => findEmploymentGaps(employment), [employment])
  const employmentCovered = employmentMeetsCoverage(employment, requiredYears)
  const addressCovered = addressMeetsCoverage(addresses)
  const unexplainedGaps = gaps.filter((_, i) => !(employment[i]?.gapExplanation?.trim()))

  function toggleEndorsement(code: string) {
    set('endorsements', endorsements.includes(code) ? endorsements.filter((c) => c !== code) : [...endorsements, code])
  }

  // What must be completed on the current step — shown as a clear banner.
  const stepNote = [
    'Every field on this step is required.',
    'Start with your current address, then list where else you\'ve lived over the last 3 years (49 CFR 391.21). Street, city, state, ZIP and the move-in date are required for each.',
    'CDL number, state, class and expiration are required. Tap any endorsements you hold — leave them all off if you have none.',
    `At least one employer is required, and your history must cover the last ${requiredYears} years. Explain any gap longer than 30 days.`,
    'Optional — list any accidents or traffic violations from the last 3 years. Leave this step empty if you have none.',
    'Type your full legal name and check the attestation box to submit.',
  ][step]

  async function goTo(next: number) {
    await onSaveDraft(normalizeForSubmit(data))
    setStep(next)
    setErrors([])
  }

  async function handleSubmit() {
    const payload = normalizeForSubmit(data)
    const parsed = driverApplicationSubmitSchema.safeParse(payload)
    const problems: string[] = []
    if (!parsed.success) problems.push(...parsed.error.issues.map((i) => i.message))
    if (!employmentCovered) problems.push(`Employment history must cover at least ${requiredYears} years`)
    if (unexplainedGaps.length > 0) problems.push('Explain each employment gap longer than 30 days')
    if (problems.length) { setErrors([...new Set(problems)]); return }
    setSubmitting(true)
    try { await onSubmit(payload) }
    finally { setSubmitting(false) }
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-6">
      <button onClick={onExit} className="mb-4" style={linkBtn}>
        <ArrowLeft size={15} /> Back to checklist
      </button>

      {/* Stepper */}
      <div className="mb-5 flex items-center gap-1">
        {STEPS.map((s, i) => (
          <div key={s} title={s} style={{ height: 6, flex: 1, borderRadius: 999, background: i <= step ? 'var(--ds-blue)' : 'var(--ds-bg-3)' }} />
        ))}
      </div>
      <h2 className="mb-1 text-xl font-semibold" style={{ color: 'var(--ds-t1)' }}>{STEPS[step]}</h2>
      <p className="mb-3 text-sm" style={{ color: 'var(--ds-t3)' }}>Step {step + 1} of {STEPS.length}</p>

      {/* Per-step required guidance */}
      <div className="mb-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm"
        style={{ background: 'var(--ds-blue-bg)', border: '1px solid var(--ds-border)', color: 'var(--ds-t2)' }}>
        <Info size={15} style={{ color: 'var(--ds-blue-dark)', flexShrink: 0, marginTop: 1 }} />
        <span>{stepNote} <span style={{ color: 'var(--ds-t3)' }}>Fields marked <Req /> are required.</span></span>
      </div>

      {step === 0 && (
        <div className="space-y-3">
          <Labeled label="Full legal name" required><input style={inputStyle} value={data.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} /></Labeled>
          <Labeled label="Date of birth" required><input type="date" style={inputStyle} value={data.dob ?? ''} onChange={(e) => set('dob', e.target.value)} /></Labeled>
          <Labeled label="SSN — last 4 digits only" required><input inputMode="numeric" maxLength={4} style={inputStyle} value={data.ssnLast4 ?? ''} onChange={(e) => set('ssnLast4', e.target.value.replace(/\D/g, ''))} /></Labeled>
          <Labeled label="Phone" required><input type="tel" style={inputStyle} value={data.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Labeled>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          {addresses.map((a, i) => (
            <div key={i} className="space-y-2" style={subCard}>
              <Labeled label="Street" required><input style={inputStyle} value={a.street ?? ''} onChange={(e) => updateItem('addressHistory', i, { street: e.target.value })} /></Labeled>
              <div className="grid grid-cols-3 gap-2">
                <Labeled label="City" required><input style={inputStyle} value={a.city ?? ''} onChange={(e) => updateItem('addressHistory', i, { city: e.target.value })} /></Labeled>
                <Labeled label="State" required><input style={inputStyle} value={a.state ?? ''} onChange={(e) => updateItem('addressHistory', i, { state: e.target.value })} /></Labeled>
                <Labeled label="ZIP" required><input style={inputStyle} value={a.zip ?? ''} onChange={(e) => updateItem('addressHistory', i, { zip: e.target.value })} /></Labeled>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Moved in" required><input type="date" style={inputStyle} value={a.fromDate ?? ''} onChange={(e) => updateItem('addressHistory', i, { fromDate: e.target.value })} /></Labeled>
                <Labeled label="Moved out (blank = current)"><input type="date" style={inputStyle} value={a.toDate ?? ''} onChange={(e) => updateItem('addressHistory', i, { toDate: e.target.value })} /></Labeled>
              </div>
              {addresses.length > 1 && (
                <button onClick={() => removeItem('addressHistory', i)} style={removeBtn}><Trash2 size={13} /> Remove</button>
              )}
            </div>
          ))}
          <button onClick={() => addItem('addressHistory', { ...BLANK_ADDRESS })} style={linkBtn}><Plus size={14} /> Add another residence</button>
          <div className="text-sm" style={{ color: addressCovered ? 'var(--ds-green)' : 'var(--ds-amber)' }}>{addressCovered ? '✓ 3-year coverage met' : 'Add residences back to 3 years'}</div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <Labeled label="CDL number" required><input style={inputStyle} value={data.cdlNumber ?? ''} onChange={(e) => set('cdlNumber', e.target.value)} /></Labeled>
          <div className="grid grid-cols-2 gap-2">
            <Labeled label="State" required><input style={inputStyle} value={data.cdlState ?? ''} onChange={(e) => set('cdlState', e.target.value)} /></Labeled>
            <Labeled label="Class" required><input style={inputStyle} value={data.cdlClass ?? ''} onChange={(e) => set('cdlClass', e.target.value)} /></Labeled>
          </div>
          <Labeled label="Expiration" required><input type="date" style={inputStyle} value={data.cdlExpiration ?? ''} onChange={(e) => set('cdlExpiration', e.target.value)} /></Labeled>

          <div>
            <label style={labelStyle}>Endorsements <span style={{ color: 'var(--ds-t3)', fontWeight: 400 }}>(tap any you hold — optional)</span></label>
            <div className="flex flex-wrap gap-2">
              {ENDORSEMENTS.map(({ code, label }) => {
                const on = endorsements.includes(code)
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => toggleEndorsement(code)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999,
                      padding: '6px 12px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                      border: `1px solid ${on ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
                      background: on ? 'var(--ds-blue)' : 'var(--ds-surface)',
                      color: on ? '#fff' : 'var(--ds-t2)',
                    }}
                  >
                    {on && <Check size={13} />}<strong>{code}</strong> · {label}
                  </button>
                )
              })}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--ds-t2)' }}>
            <input type="checkbox" checked={!!data.cdlIssuedAfterFeb2022} onChange={(e) => set('cdlIssuedAfterFeb2022', e.target.checked)} />
            My CDL was issued after February 7, 2022
          </label>
          {data.cdlIssuedAfterFeb2022 && (
            <Labeled label="ELDT training provider" required><input style={inputStyle} value={data.eldtProviderName ?? ''} onChange={(e) => set('eldtProviderName', e.target.value)} /></Labeled>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          {employment.map((e, i) => (
            <div key={i} className="space-y-2" style={subCard}>
              <Labeled label="Employer name" required><input style={inputStyle} value={e.employerName ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { employerName: ev.target.value })} /></Labeled>
              <Labeled label="Address" required><input style={inputStyle} value={e.address ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { address: ev.target.value })} /></Labeled>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Phone" required><input style={inputStyle} value={e.phone ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { phone: ev.target.value })} /></Labeled>
                <Labeled label="Position" required><input style={inputStyle} value={e.position ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { position: ev.target.value })} /></Labeled>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="From" required><input type="date" style={inputStyle} value={e.fromDate ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { fromDate: ev.target.value })} /></Labeled>
                <Labeled label="To (blank = present)"><input type="date" style={inputStyle} value={e.toDate ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { toDate: ev.target.value })} /></Labeled>
              </div>
              <Labeled label="Reason for leaving"><input style={inputStyle} placeholder="Optional" value={e.reasonForLeaving ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { reasonForLeaving: ev.target.value })} /></Labeled>
              <div className="flex gap-4 text-sm" style={{ color: 'var(--ds-t2)' }}>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!e.subjectToFMCSR} onChange={(ev) => updateItem('employmentHistory', i, { subjectToFMCSR: ev.target.checked })} /> Subject to FMCSR</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!e.safetySensitive} onChange={(ev) => updateItem('employmentHistory', i, { safetySensitive: ev.target.checked })} /> Safety-sensitive</label>
              </div>
              {gaps[i] && (
                <div className="rounded-md p-2" style={{ background: 'var(--ds-amber-bg)' }}>
                  <div className="text-xs font-medium" style={{ color: 'var(--ds-amber)' }}>Gap of {gaps[i].days} days before this job — please explain<Req /></div>
                  <input style={{ ...inputStyle, marginTop: 4 }} placeholder="What were you doing during this gap?" value={e.gapExplanation ?? ''} onChange={(ev) => updateItem('employmentHistory', i, { gapExplanation: ev.target.value })} />
                </div>
              )}
              {employment.length > 1 && (
                <button onClick={() => removeItem('employmentHistory', i)} style={removeBtn}><Trash2 size={13} /> Remove</button>
              )}
            </div>
          ))}
          <button onClick={() => addItem('employmentHistory', { ...BLANK_EMPLOYMENT })} style={linkBtn}><Plus size={14} /> Add another employer</button>
          <div className="text-sm" style={{ color: employmentCovered ? 'var(--ds-green)' : 'var(--ds-amber)' }}>{employmentCovered ? `✓ ${requiredYears}-year coverage met` : `Add history back to ${requiredYears} years`}</div>
          {unexplainedGaps.length > 0 && <div className="text-sm" style={{ color: 'var(--ds-amber)' }}>{unexplainedGaps.length} gap(s) need an explanation before you can submit.</div>}
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-sm font-medium" style={{ color: 'var(--ds-t2)' }}>Accidents in the last 3 years</div>
            {(data.accidents ?? []).map((a, i) => (
              <div key={i} className="mb-2 space-y-2" style={subCard}>
                <Labeled label="Date" required><input type="date" style={inputStyle} value={a.date ?? ''} onChange={(e) => updateItem('accidents', i, { date: e.target.value })} /></Labeled>
                <Labeled label="Nature of accident" required><input style={inputStyle} value={a.nature ?? ''} onChange={(e) => updateItem('accidents', i, { nature: e.target.value })} /></Labeled>
                <button onClick={() => removeItem('accidents', i)} style={removeBtn}><Trash2 size={13} /> Remove</button>
              </div>
            ))}
            <button onClick={() => addItem('accidents', { date: '', nature: '', fatalities: 0, injuries: 0, hazmatSpill: false })} style={linkBtn}><Plus size={14} /> Add accident</button>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium" style={{ color: 'var(--ds-t2)' }}>Traffic violations in the last 3 years</div>
            {(data.violations ?? []).map((v, i) => (
              <div key={i} className="mb-2 space-y-2" style={subCard}>
                <Labeled label="Date" required><input type="date" style={inputStyle} value={v.date ?? ''} onChange={(e) => updateItem('violations', i, { date: e.target.value })} /></Labeled>
                <Labeled label="Offense" required><input style={inputStyle} value={v.offense ?? ''} onChange={(e) => updateItem('violations', i, { offense: e.target.value })} /></Labeled>
                <button onClick={() => removeItem('violations', i)} style={removeBtn}><Trash2 size={13} /> Remove</button>
              </div>
            ))}
            <button onClick={() => addItem('violations', { date: '', offense: '', location: '', penalty: '' })} style={linkBtn}><Plus size={14} /> Add violation</button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="space-y-4">
          <div className="rounded-lg p-4 text-sm" style={{ background: 'var(--ds-bg-2)', border: '1px solid var(--ds-border)', color: 'var(--ds-t2)' }}>
            By typing your name below you certify that all information in this application is true and complete to the
            best of your knowledge (FMCSA electronic signature).
          </div>
          <Labeled label="Type your full legal name to sign" required><input style={inputStyle} value={data.signatureName ?? ''} onChange={(e) => set('signatureName', e.target.value)} /></Labeled>
          <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--ds-t2)' }}>
            <input type="checkbox" className="mt-1" checked={!!data.attestation} onChange={(e) => set('attestation', e.target.checked)} />
            <span>I attest that the information provided is true and complete.<Req /></span>
          </label>
          {errors.length > 0 && (
            <ul className="rounded-md p-3 text-sm list-disc list-inside" style={{ background: 'var(--ds-red-bg)', color: 'var(--ds-red)' }}>
              {errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Nav */}
      <div className="mt-6 flex items-center justify-between">
        <button disabled={step === 0} onClick={() => goTo(step - 1)} style={{ ...btnGhost, opacity: step === 0 ? 0.4 : 1, cursor: step === 0 ? 'default' : 'pointer' }}>
          <ArrowLeft size={15} /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button onClick={() => goTo(step + 1)} style={btnPrimary}>
            Save & continue <ArrowRight size={15} />
          </button>
        ) : (
          <button onClick={handleSubmit} disabled={submitting} style={{ ...btnSuccess, opacity: submitting ? 0.5 : 1 }}>
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
