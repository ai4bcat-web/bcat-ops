import { useState } from 'react'
import { X, Plus, Trash2, Upload } from 'lucide-react'
import type { Driver } from '@/types'
import type { BoxTruckTrip, DriverPaySetting, FixedExpense } from '@/hooks/useBoxTruckPay'
import { parseBoxTruckRows, type RawBoxTruckRow } from '@/lib/boxTruckCsv'

type TripInput = Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>
type SettingPatch = Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>

const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }
const input: React.CSSProperties = { height: 36, width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)', padding: '0 10px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', boxSizing: 'border-box' }
const num = (s: string): number | null => { const n = parseFloat(s.replace(/[$,\s]/g, '')); return isFinite(n) ? n : null }
const numStr = (n: number | null | undefined) => (n == null ? '' : String(n))

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

// ── Add / edit a single shipment ─────────────────────────────────────────────
export function TripModal({ driverId, periodStart, initial, onSave, onClose }: { driverId: string; periodStart: string; initial?: BoxTruckTrip; onSave: (t: TripInput) => Promise<void>; onClose: () => void }) {
  const editing = !!initial
  const [f, setF] = useState({
    date: initial?.date ?? periodStart, aljexPro: initial?.aljexPro ?? '',
    proNumber: initial?.proNumber ?? '', customer: initial?.customer ?? '', salesRep: initial?.salesRep ?? '',
    loadDesc: initial?.loadDesc ?? '', customerRate: numStr(initial?.customerRate), carrierCost: numStr(initial?.carrierCost),
    grossProfit: numStr(initial?.grossProfit), status: initial?.status ?? 'RELEASED',
  })
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))

  const save = async () => {
    const gp = num(f.grossProfit)
    if (gp == null) { setErr('Gross profit is required'); return }
    setSaving(true)
    try {
      await onSave({
        driverId, periodStart,
        loadId: initial?.loadId ?? null, date: f.date || null, aljexPro: f.aljexPro.trim() || null,
        proNumber: f.proNumber.trim() || null, customer: f.customer.trim() || null, salesRep: f.salesRep.trim() || null,
        loadDesc: f.loadDesc.trim() || null, customerRate: num(f.customerRate), carrierCost: num(f.carrierCost),
        grossProfit: gp, status: f.status || null,
      })
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSaving(false) }
  }

  return (
    <Modal title={editing ? 'Edit shipment' : 'Add shipment'} sub="One shipment for this pay period" onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field l="Date" half><input type="date" style={input} value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field l="Aljex PRO #" half><input style={input} value={f.aljexPro} onChange={(e) => set('aljexPro', e.target.value)} placeholder="FR-407930" /></Field>
        <Field l="PU / TMS #" half><input style={input} value={f.proNumber} onChange={(e) => set('proNumber', e.target.value)} placeholder="13599" /></Field>
        <Field l="Customer" half><input style={input} value={f.customer} onChange={(e) => set('customer', e.target.value)} placeholder="THE ROYAL GROUP" /></Field>
        <Field l="Sales rep" half><input style={input} value={f.salesRep} onChange={(e) => set('salesRep', e.target.value)} /></Field>
        <Field l="Load description" half><input style={input} value={f.loadDesc} onChange={(e) => set('loadDesc', e.target.value)} placeholder="POD RCVD-FAK" /></Field>
        <Field l="Customer rate" half><input style={input} value={f.customerRate} onChange={(e) => set('customerRate', e.target.value)} placeholder="$1,150.00" /></Field>
        <Field l="Carrier cost" half><input style={input} value={f.carrierCost} onChange={(e) => set('carrierCost', e.target.value)} placeholder="$500.00" /></Field>
        <Field l="Gross profit *" half><input style={input} value={f.grossProfit} onChange={(e) => set('grossProfit', e.target.value)} placeholder="$650.00" /></Field>
        <Field l="Status" half>
          <select style={input} value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option>RELEASED</option><option>COVERED</option>
          </select>
        </Field>
      </div>
      {err && <div style={{ fontSize: 12.5, color: '#dc2626', marginTop: 10 }}>{err}</div>}
      <Footer onClose={onClose} onSave={save} saving={saving} label={editing ? 'Save shipment' : 'Add shipment'} />
    </Modal>
  )
}

export function rowToTrip(r: RawBoxTruckRow, driverId: string, periodStart: string): TripInput {
  return {
    driverId, periodStart,
    loadId: null, date: null, aljexPro: null,
    proNumber: r.proNumber, customer: r.customer, salesRep: r.salesRep, loadDesc: r.loadDesc,
    customerRate: r.customerRate, carrierCost: r.carrierCost, grossProfit: r.grossProfit, status: r.status,
  }
}

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

// ── Import shipments (paste or file) — filed to the selected period ──────────
export function ImportModal({ driverId, periodStart, onImport, onClose }: { driverId: string; periodStart: string; onImport: (rows: TripInput[]) => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const raw = parseBoxTruckRows(text)
  const parsed = raw.map((r) => rowToTrip(r, driverId, periodStart))

  return (
    <Modal title="Import shipments" sub="Upload or paste the Ivan Cartage spreadsheet — all rows file to the selected period" onClose={onClose} width={680}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--ds-t3)', lineHeight: 1.5 }}>
          Columns auto-detected by name: <span style={{ fontFamily: 'monospace', fontSize: 11 }}>shipment_pro · customer name · sales rep name · shipment_load_des · shipment_gross_profit · shipment_status</span>.
          Pay is the sum of <b>gross profit</b>.
        </div>
        <FilePick onText={setText} />
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={9} placeholder="Paste rows (including the header row) from the spreadsheet…" style={importTextarea} />
      <div style={{ fontSize: 12.5, color: parsed.length ? '#15803d' : 'var(--ds-t3)', marginTop: 8 }}>
        {parsed.length ? `${parsed.length} shipment${parsed.length !== 1 ? 's' : ''} ready · gross profit total ${money(parsed.reduce((s, t) => s + (t.grossProfit || 0), 0))}` : 'Upload or paste rows to preview'}
      </div>
      <Footer onClose={onClose} onSave={async () => { setSaving(true); try { await onImport(parsed) } catch { setSaving(false) } }} saving={saving} label={`Import ${parsed.length || ''}`.trim()} />
    </Modal>
  )
}

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

// ── Per-driver pay settings (box-truck: Chad-style % of net after expenses) ──
export function SettingsModal({ driver, existing, onSave, onClose }: { driver: Driver; existing?: DriverPaySetting; onSave: (patch: SettingPatch) => Promise<void>; onClose: () => void }) {
  const [percent, setPercent] = useState(existing ? String(Math.round(existing.payPercent * 100)) : '50')
  // Box-truck drivers use the Chad model: % applied AFTER expenses. Default ON.
  const [afterExp, setAfterExp] = useState(existing?.expensesBeforePercent ?? true)
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
        payGroup: 'BOX_TRUCK', payPercent: p / 100, expensesBeforePercent: afterExp,
        email: email.trim() || null, fuelCardNumber: fuelCard.trim() || null,
        fixedExpenses: cleanFixed, active: true, notes: existing?.notes ?? null,
      })
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSaving(false) }
  }

  return (
    <Modal title={`${driver.name} — box-truck pay settings`} sub="How this driver's biweekly pay is calculated" onClose={onClose} width={560}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field l="Pay percent *" half><input style={input} value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="50" /></Field>
        <Field l="Fuel card # (EFS)" half><input style={input} value={fuelCard} onChange={(e) => setFuelCard(e.target.value)} placeholder="00049" /></Field>
        <Field l="Driver email"><input style={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="driver@example.com" /></Field>
      </div>

      <div style={{ marginTop: 14 }}>
        <label style={label}>Calculation</label>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          {[{ v: true, t: '% of net (after expenses)', hint: 'Zak, Chad' }, { v: false, t: '% of gross, then − expenses', hint: 'Lee, Mike, Roy' }].map((opt) => (
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
          <label style={label}>Fixed expenses (per period)</label>
          <button type="button" onClick={() => setFixed((p) => [...p, { label: '', amount: 0 }])} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--ds-blue)', background: 'none', border: 'none', cursor: 'pointer' }}><Plus size={13} /> Add</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginBottom: 8 }}>Deducted every period. Fuel is pulled from the card automatically — don't add it here.</div>
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
