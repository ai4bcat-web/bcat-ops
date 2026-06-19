import { useState } from 'react'
import { X, Plus, Trash2, Upload } from 'lucide-react'
import type { Driver } from '@/types'
import type { AmazonTrip, DriverPaySetting, DriverPayDeduction, FixedExpense } from '@/hooks/useAmazonPay'
import { parseRows, type RawTripRow } from '@/lib/tripCsv'

type TripInput = Omit<AmazonTrip, 'id' | 'createdAt' | 'updatedAt'>
type SettingPatch = Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>

const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }
const input: React.CSSProperties = { height: 36, width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)', padding: '0 10px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', boxSizing: 'border-box' }
const num = (s: string): number | null => { const n = parseFloat(s.replace(/[$,\s]/g, '')); return isFinite(n) ? n : null }

function Modal({ title, sub, onClose, children, width = 520 }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)', padding: 16 }}>
      <div style={{ background: 'var(--ds-surface)', borderRadius: 16, boxShadow: 'var(--sh-lg, 0 10px 40px rgba(0,0,0,0.2))', width: '100%', maxWidth: width, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', position: 'sticky', top: 0, background: 'var(--ds-surface)' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>{title}</div>
            {sub && <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>{sub}</div>}
          </div>
          <button onClick={onClose} style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  )
}

function Field({ children, l, half }: { children: React.ReactNode; l: string; half?: boolean }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 5, gridColumn: half ? 'span 1' : '1 / -1' }}><label style={label}>{l}</label>{children}</div>
}

const saveBtn: React.CSSProperties = { height: 36, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const cancelBtn: React.CSSProperties = { height: 36, padding: '0 16px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }

function Footer({ onClose, onSave, saving, label: lbl = 'Save' }: { onClose: () => void; onSave: () => void; saving?: boolean; label?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 16 }}>
      <button type="button" onClick={onClose} style={cancelBtn}>Cancel</button>
      <button type="button" onClick={onSave} disabled={saving} style={{ ...saveBtn, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : lbl}</button>
    </div>
  )
}

// ── Add / edit a single trip ────────────────────────────────────────────────
const numStr = (n: number | null | undefined) => (n == null ? '' : String(n))
export function TripModal({ driverId, periodStart, initial, onSave, onClose }: { driverId: string; periodStart: string; initial?: AmazonTrip; onSave: (t: TripInput) => Promise<void>; onClose: () => void }) {
  const editing = !!initial
  const [f, setF] = useState({
    loadId: initial?.loadId ?? '', origin: initial?.origin ?? '', destination: initial?.destination ?? '',
    miles: numStr(initial?.miles), equipment: initial?.equipment ?? '', freightAmount: numStr(initial?.freightAmount),
    ratePerMile: numStr(initial?.ratePerMile), dispatcher: initial?.dispatcher ?? '', status: initial?.status ?? 'Completed',
  })
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))

  const save = async () => {
    const freight = num(f.freightAmount)
    if (freight == null) { setErr('Freight amount is required'); return }
    setSaving(true)
    try {
      await onSave({
        driverId, periodStart,
        loadId: f.loadId.trim() || null, origin: f.origin.trim() || null, destination: f.destination.trim() || null,
        miles: num(f.miles), equipment: f.equipment.trim() || null, freightAmount: freight,
        ratePerMile: num(f.ratePerMile), dispatcher: f.dispatcher.trim() || null, status: f.status || null,
      })
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSaving(false) }
  }

  return (
    <Modal title={editing ? 'Edit trip' : 'Add trip'} sub="One freight load for this pay week" onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field l="Load ID" half><input style={input} value={f.loadId} onChange={(e) => set('loadId', e.target.value)} placeholder="112CRP7T7" /></Field>
        <Field l="Equipment" half><input style={input} value={f.equipment} onChange={(e) => set('equipment', e.target.value)} placeholder="53' Trailer" /></Field>
        <Field l="Origin" half><input style={input} value={f.origin} onChange={(e) => set('origin', e.target.value)} /></Field>
        <Field l="Destination" half><input style={input} value={f.destination} onChange={(e) => set('destination', e.target.value)} /></Field>
        <Field l="Freight amount *" half><input style={input} value={f.freightAmount} onChange={(e) => set('freightAmount', e.target.value)} placeholder="$300.00" /></Field>
        <Field l="Miles" half><input style={input} value={f.miles} onChange={(e) => set('miles', e.target.value)} /></Field>
        <Field l="Rate / mile" half><input style={input} value={f.ratePerMile} onChange={(e) => set('ratePerMile', e.target.value)} /></Field>
        <Field l="Status" half>
          <select style={input} value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option>Completed</option><option>Active</option><option>Cancelled</option>
          </select>
        </Field>
        <Field l="Dispatcher"><input style={input} value={f.dispatcher} onChange={(e) => set('dispatcher', e.target.value)} /></Field>
      </div>
      {err && <div style={{ fontSize: 12.5, color: '#dc2626', marginTop: 10 }}>{err}</div>}
      <Footer onClose={onClose} onSave={save} saving={saving} label={editing ? 'Save trip' : 'Add trip'} />
    </Modal>
  )
}

// ── CSV / paste parsing (shared, tested in src/lib/tripCsv.test.ts) ──────────
export function rowToTrip(r: RawTripRow, driverId: string, periodStart: string): TripInput {
  return {
    driverId, periodStart,
    loadId: r.loadId, origin: r.origin, destination: r.destination, miles: r.miles,
    equipment: r.equipment, freightAmount: r.freightAmount, ratePerMile: r.ratePerMile,
    dispatcher: r.dispatcher, status: r.status,
  }
}

/** Read a chosen .csv/.txt file into the textarea. */
function FilePick({ onText }: { onText: (t: string) => void }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
      <Upload size={14} /> Choose file…
      <input type="file" accept=".csv,.tsv,.txt,text/csv" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then(onText); e.currentTarget.value = '' }} />
    </label>
  )
}

const importTextarea: React.CSSProperties = { width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)', padding: 10, fontSize: 12, fontFamily: 'monospace', background: 'var(--ds-surface)', color: 'var(--ds-t1)', resize: 'vertical', boxSizing: 'border-box' }

// ── Per-driver import (paste or file) ───────────────────────────────────────
export function ImportModal({ driverId, periodStart, onImport, onClose }: { driverId: string; periodStart: string; onImport: (rows: TripInput[]) => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const parsed = parseRows(text).map((r) => rowToTrip(r, driverId, periodStart))

  return (
    <Modal title="Import trips" sub="Upload a CSV or paste rows from your pay spreadsheet" onClose={onClose} width={640}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--ds-t3)', lineHeight: 1.5 }}>
          Columns (header auto-detected, else this order):<br />
          <span style={{ fontFamily: 'monospace', fontSize: 11 }}>Load ID · Origin · Destination · Miles · Equipment · Freight · Rate/mi · Dispatcher · Status</span>
        </div>
        <FilePick onText={setText} />
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10}
        placeholder={'112CRP7T7\tUPRR->ELP1\t\t40.73\t53\' Container\t$300.00\t\tLee Lara\tCompleted'}
        style={importTextarea} />
      <div style={{ fontSize: 12.5, color: parsed.length ? '#15803d' : 'var(--ds-t3)', marginTop: 8 }}>
        {parsed.length ? `${parsed.length} trip${parsed.length !== 1 ? 's' : ''} ready to import` : 'Upload or paste rows to preview'}
      </div>
      <Footer onClose={onClose} onSave={async () => { setSaving(true); try { await onImport(parsed) } catch { setSaving(false) } }} saving={saving} label={`Import ${parsed.length || ''}`.trim()} />
    </Modal>
  )
}

// ── Master import (all drivers in one CSV, routed by driver name) ────────────
function matchDriver(name: string, drivers: Driver[]): string {
  const n = name.trim().toLowerCase()
  if (!n) return ''
  const exact = drivers.find((d) => d.name.trim().toLowerCase() === n)
  if (exact) return exact.id
  // last-name + first-initial (handles "R. Workman" → "Roy Workman")
  const parts = n.replace(/\./g, '').split(/\s+/)
  const last = parts[parts.length - 1]
  const firstInit = parts[0]?.[0]
  const byLast = drivers.filter((d) => d.name.trim().toLowerCase().split(/\s+/).pop() === last)
  if (byLast.length === 1) return byLast[0].id
  const byBoth = byLast.find((d) => d.name.trim().toLowerCase()[0] === firstInit)
  return byBoth?.id ?? ''
}

export function MasterImportModal({ periodStart, drivers, onImport, onClose }: {
  periodStart: string; drivers: Driver[]
  onImport: (rows: TripInput[]) => Promise<void>; onClose: () => void
}) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const rows = parseRows(text)

  // Group by the driver-name column and seed a best-guess driver mapping.
  const groups = useState(() => new Map<string, string>())[0]
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const names = Array.from(new Set(rows.map((r) => r.driverName).filter(Boolean)))
  // seed defaults for any newly-seen names
  for (const name of names) {
    if (!(name in mapping) && !groups.has(name)) { groups.set(name, matchDriver(name, drivers)) }
  }
  const effMap = (name: string) => (name in mapping ? mapping[name] : groups.get(name) ?? '')

  const ready = rows.filter((r) => effMap(r.driverName))
  const unmatched = names.filter((n) => !effMap(n))

  const doImport = async () => {
    setSaving(true)
    try {
      const trips = rows
        .map((r) => { const id = effMap(r.driverName); return id ? rowToTrip(r, id, periodStart) : null })
        .filter((t): t is TripInput => t !== null)
      await onImport(trips)
    } catch { setSaving(false) }
  }

  return (
    <Modal title="Upload master CSV" sub="One file with every driver's trips — routed to each driver for this week" onClose={onClose} width={680}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--ds-t3)', lineHeight: 1.5 }}>
          Upload the raw <b>Amazon Relay “Trips” CSV</b> (columns auto-detected: Driver Name,
          Estimated Cost, Estimate Distance, Facility Sequence, Equipment…). Each driver is matched below.
        </div>
        <FilePick onText={setText} />
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7}
        placeholder={'Load ID,Origin,Destination,Miles,Equipment,Freight,Rate/mi,Dispatcher,Status'}
        style={importTextarea} />

      {names.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Map drivers ({rows.length} rows)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
            {names.map((name) => {
              const count = rows.filter((r) => r.driverName === name).length
              const sel = effMap(name)
              return (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ds-t1)' }}>{name} <span style={{ color: 'var(--ds-t3)' }}>· {count}</span></span>
                  <select value={sel} onChange={(e) => setMapping((p) => ({ ...p, [name]: e.target.value }))}
                    style={{ ...input, width: 220, height: 32, border: `1px solid ${sel ? 'var(--ds-border)' : '#f59e0b'}` }}>
                    <option value="">— skip (no match) —</option>
                    {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div style={{ fontSize: 12.5, marginTop: 10, color: ready.length ? '#15803d' : 'var(--ds-t3)' }}>
        {ready.length ? `${ready.length} of ${rows.length} rows ready` : 'Upload or paste a master CSV to preview'}
        {unmatched.length > 0 && <span style={{ color: '#b45309' }}> · {unmatched.length} unmatched driver{unmatched.length !== 1 ? 's' : ''} will be skipped</span>}
      </div>
      <Footer onClose={onClose} onSave={doImport} saving={saving} label={`Import ${ready.length || ''}`.trim()} />
    </Modal>
  )
}

// ── One-off deduction ───────────────────────────────────────────────────────
export function DeductionModal({ driverId, periodStart, onSave, onClose }: { driverId: string; periodStart: string; onSave: (d: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>; onClose: () => void }) {
  const [f, setF] = useState({ label: '', amount: '', date: '' })
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    const amount = num(f.amount)
    if (!f.label.trim() || amount == null || amount <= 0) { setErr('Enter a label and a positive amount'); return }
    setSaving(true)
    try { await onSave({ driverId, periodStart, label: f.label.trim(), amount, date: f.date || null }) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSaving(false) }
  }
  return (
    <Modal title="Add expense" sub="A one-off deduction for this week" onClose={onClose} width={440}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field l="Description"><input style={input} value={f.label} onChange={(e) => setF((p) => ({ ...p, label: e.target.value }))} placeholder="NM Permit one-time charge" /></Field>
        <Field l="Amount *" half><input style={input} value={f.amount} onChange={(e) => setF((p) => ({ ...p, amount: e.target.value }))} placeholder="$98.00" /></Field>
        <Field l="Date" half><input type="date" style={input} value={f.date} onChange={(e) => setF((p) => ({ ...p, date: e.target.value }))} /></Field>
      </div>
      {err && <div style={{ fontSize: 12.5, color: '#dc2626', marginTop: 10 }}>{err}</div>}
      <Footer onClose={onClose} onSave={save} saving={saving} label="Add expense" />
    </Modal>
  )
}

// ── Per-driver pay settings ─────────────────────────────────────────────────
export function SettingsModal({ driver, existing, onSave, onClose }: { driver: Driver; existing?: DriverPaySetting; onSave: (patch: SettingPatch) => Promise<void>; onClose: () => void }) {
  const [percent, setPercent] = useState(existing ? String(Math.round(existing.payPercent * 100)) : '')
  const [afterExp, setAfterExp] = useState(existing?.expensesBeforePercent ?? false)
  const [email, setEmail] = useState(existing?.email ?? driver.email ?? '')
  const [fuelCard, setFuelCard] = useState(existing?.fuelCardNumber ?? '')
  const [fixed, setFixed] = useState<FixedExpense[]>(existing?.fixedExpenses ?? [])
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const setFixedItem = (i: number, patch: Partial<FixedExpense>) => setFixed((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  const save = async () => {
    const p = num(percent)
    if (p == null || p <= 0 || p > 100) { setErr('Enter a pay percent between 1 and 100'); return }
    const cleanFixed = fixed.filter((x) => x.label.trim() && x.amount > 0).map((x) => ({ label: x.label.trim(), amount: x.amount }))
    setSaving(true)
    try {
      await onSave({
        payGroup: 'AMAZON', payPercent: p / 100, expensesBeforePercent: afterExp,
        email: email.trim() || null, fuelCardNumber: fuelCard.trim() || null,
        fixedExpenses: cleanFixed, active: true, notes: existing?.notes ?? null,
      })
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSaving(false) }
  }

  return (
    <Modal title={`${driver.name} — pay settings`} sub="How this driver's weekly pay is calculated" onClose={onClose} width={560}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field l="Pay percent *" half><input style={input} value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="42 or 88" /></Field>
        <Field l="Fuel card # (EFS)" half><input style={input} value={fuelCard} onChange={(e) => setFuelCard(e.target.value)} placeholder="00049" /></Field>
        <Field l="Driver email"><input style={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="driver@example.com" /></Field>
      </div>

      <div style={{ marginTop: 14 }}>
        <label style={label}>Calculation</label>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          {[{ v: false, t: '% of gross, then − expenses', hint: 'Lee, Mike, Roy' }, { v: true, t: '% AFTER expenses', hint: 'Chad' }].map((opt) => (
            <button key={String(opt.v)} type="button" onClick={() => setAfterExp(opt.v)}
              style={{ flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                border: `1.5px solid ${afterExp === opt.v ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
                background: afterExp === opt.v ? 'var(--ds-blue-soft, #eff6ff)' : 'var(--ds-surface)' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t1)' }}>{opt.t}</div>
              <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 2 }}>e.g. {opt.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <label style={label}>Fixed weekly expenses</label>
          <button type="button" onClick={() => setFixed((p) => [...p, { label: '', amount: 0 }])} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--ds-blue)', background: 'none', border: 'none', cursor: 'pointer' }}><Plus size={13} /> Add</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginBottom: 8 }}>Deducted every week (ELD, insurance, occupational, plates, tablet…). Fuel is pulled from the card automatically — don't add it here.</div>
        {fixed.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>No fixed expenses.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {fixed.map((x, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...input, flex: 1 }} value={x.label} onChange={(e) => setFixedItem(i, { label: e.target.value })} placeholder="Insurance" />
              <input style={{ ...input, width: 120 }} value={x.amount ? String(x.amount) : ''} onChange={(e) => setFixedItem(i, { amount: num(e.target.value) ?? 0 })} placeholder="$250" />
              <button type="button" onClick={() => setFixed((p) => p.filter((_, j) => j !== i))} style={{ ...cancelBtn, width: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </div>

      {err && <div style={{ fontSize: 12.5, color: '#dc2626', marginTop: 12 }}>{err}</div>}
      <Footer onClose={onClose} onSave={save} saving={saving} label="Save settings" />
    </Modal>
  )
}
