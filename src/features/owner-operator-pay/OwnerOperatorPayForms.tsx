import { useState } from 'react'
import { X } from 'lucide-react'
import type { Driver } from '@/types'
import type { DriverPaySetting, DriverPayCredit, DriverPayCreditInput } from '@/lib/apiClient'
import { CREDIT_REASONS, DEFAULT_CREDIT_REASON, DEBIT_REASONS, DEFAULT_DEBIT_REASON, creditReason } from '@/lib/payCredits'
import { FixedExpenseEditor } from '@/features/driver-pay/FixedExpenseEditor'
import type { FixedExpenseInput } from '@/lib/driverPay'

type SettingPatch = Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>

const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }
const input: React.CSSProperties = { height: 36, width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)', padding: '0 10px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', boxSizing: 'border-box' }
const num = (s: string): number | null => { const n = parseFloat(s.replace(/[$,\s]/g, '')); return isFinite(n) ? n : null }
const moneyFmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

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

function Footer({ onClose, onSave, saving, disabled, label: lbl = 'Save' }: { onClose: () => void; onSave: () => void; saving?: boolean; disabled?: boolean; label?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 16 }}>
      <button type="button" onClick={onClose} style={cancelBtn}>Cancel</button>
      <button type="button" onClick={onSave} disabled={saving || disabled} style={{ ...saveBtn, opacity: saving || disabled ? 0.6 : 1 }}>{saving ? 'Saving…' : lbl}</button>
    </div>
  )
}

// ── Add / edit a credit (extra pay on the check) ─────────────────────────────
export function CreditModal({ driverId, driverName, periodStart, periodLabel, initial, createdBy, kind = 'CREDIT', onSave, onClose }: {
  driverId: string; driverName: string; periodStart: string; periodLabel: string
  initial?: DriverPayCredit; createdBy: string | null; kind?: 'CREDIT' | 'DEBIT'
  onSave: (input: DriverPayCreditInput) => Promise<void>; onClose: () => void
}) {
  const debit = kind === 'DEBIT'
  const REASONS = debit ? DEBIT_REASONS : CREDIT_REASONS
  const defaultReason = debit ? DEFAULT_DEBIT_REASON : DEFAULT_CREDIT_REASON
  const [f, setF] = useState({
    reasonCode: initial?.reasonCode ?? defaultReason,
    amount: initial ? String(initial.amount) : '',
    label: initial?.label ?? '',
    date: initial?.date ?? '',
    loadRef: initial?.loadRef ?? '',
    notes: initial?.notes ?? '',
  })
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))

  const amount = num(f.amount)
  const reason = creditReason(f.reasonCode)
  const noun = debit ? 'debit' : 'credit'

  const save = async () => {
    if (amount == null || amount <= 0) { setErr('Enter a positive amount'); return }
    setSaving(true)
    try {
      await onSave({
        driverId, periodStart, kind,
        reasonCode: f.reasonCode,
        amount,
        label: f.label.trim() || null,
        date: f.date || null,
        loadRef: f.loadRef.trim() || null,
        notes: f.notes.trim() || null,
        createdBy: initial?.createdBy ?? createdBy ?? null,
      })
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSaving(false) }
  }

  return (
    <Modal title={initial ? `Edit ${noun}` : `Add ${noun}`} sub={debit ? `Taken off ${driverName}'s ${periodLabel} check, after the net` : `Extra pay for ${driverName} on the ${periodLabel} check`} onClose={onClose} width={520}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field l="Reason code *" half>
          <select style={input} value={f.reasonCode} onChange={(e) => set('reasonCode', e.target.value)}>
            {REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
        </Field>
        <Field l="Amount *" half><input style={input} value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="$150.00" /></Field>
        <Field l="Description"><input style={input} value={f.label} onChange={(e) => set('label', e.target.value)} placeholder={reason?.hint ?? 'What is this credit for?'} /></Field>
        <Field l="Date earned" half><input type="date" style={input} value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field l="Related PRO / PU #" half><input style={input} value={f.loadRef} onChange={(e) => set('loadRef', e.target.value)} placeholder="FR-407930" /></Field>
        <Field l="Internal note"><input style={input} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Approved by…" /></Field>
      </div>

      <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', fontSize: 12.5, color: 'var(--ds-t2)' }}>
        {debit
          ? <>Debits come off the check <b>in full, after the net</b> — the driver's pay percentage is not applied.</>
          : <>Credits are added to the check <b>in full</b> — the driver's pay percentage is not applied.</>}
        {amount != null && amount > 0 && <> This check goes {debit ? 'down' : 'up'} by <b style={{ color: debit ? '#dc2626' : '#15803d' }}>{moneyFmt(amount)}</b>.</>}
      </div>

      {err && <div style={{ fontSize: 12.5, color: '#dc2626', marginTop: 10 }}>{err}</div>}
      <Footer onClose={onClose} onSave={save} saving={saving} label={initial ? `Save ${noun}` : `Add ${noun}`} />
    </Modal>
  )
}

// ── Per-driver pay settings (owner operator: % of freight) ───────────────────
export function SettingsModal({ driver, existing, onSave, onClose }: { driver: Driver; existing?: DriverPaySetting; onSave: (patch: SettingPatch, expectedUpdatedAt: string | undefined) => Promise<void>; onClose: () => void }) {
  const [percent, setPercent] = useState(existing ? String(Math.round(existing.payPercent * 100)) : '50')
  const [afterExp, setAfterExp] = useState(existing?.expensesBeforePercent ?? true)
  const [email, setEmail] = useState(existing?.email ?? driver.email ?? '')
  const [fuelCard, setFuelCard] = useState(existing?.fuelCardNumber ?? '')
  const [fixed, setFixed] = useState<FixedExpenseInput[]>(existing?.fixedExpenses ?? [])
  const [capturedUpdatedAt] = useState(existing?.updatedAt)
  const [fixedEditing, setFixedEditing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const p = num(percent)
    if (p == null || p <= 0 || p > 100) { setErr('Enter a pay percent between 1 and 100'); return }
    setSaving(true)
    try {
      await onSave({
        payGroup: 'OWNER_OPERATOR', payPercent: p / 100, expensesBeforePercent: afterExp,
        email: email.trim() || null, fuelCardNumber: fuelCard.trim() || null,
        fixedExpenses: fixed, active: true, notes: existing?.notes ?? null,
      }, capturedUpdatedAt)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSaving(false) }
  }

  return (
    <Modal title={`${driver.name} — owner operator pay settings`} sub="How this driver's weekly pay is calculated" onClose={onClose} width={560}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field l="Pay percent *" half><input style={input} value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="50" /></Field>
        <Field l="Fuel card # (EFS)" half><input style={input} value={fuelCard} onChange={(e) => setFuelCard(e.target.value)} placeholder="00049" /></Field>
        <Field l="Driver email"><input style={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="driver@example.com" /></Field>
      </div>

      <div style={{ marginTop: 14 }}>
        <label style={label}>Calculation</label>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          {[{ v: true, t: '% of net (after expenses)' }, { v: false, t: '% of gross, then − expenses' }].map((opt) => (
            <button key={String(opt.v)} type="button" onClick={() => setAfterExp(opt.v)}
              style={{ flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                border: `1.5px solid ${afterExp === opt.v ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
                background: afterExp === opt.v ? 'var(--ds-blue-soft, #eff6ff)' : 'var(--ds-surface)' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t1)' }}>{opt.t}</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <FixedExpenseEditor
          value={fixed}
          onChange={setFixed}
          periodDays={7}
          onEditingChange={setFixedEditing}
          title="Fixed expenses (per week)"
        />
      </div>

      {fixedEditing && (
        <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 8 }}>
          Finish or cancel the fixed-expense edit before saving settings.
        </div>
      )}

      {err && <div style={{ fontSize: 12.5, color: '#dc2626', marginTop: 12 }}>{err}</div>}
      <Footer onClose={onClose} onSave={save} saving={saving} disabled={fixedEditing} label="Save settings" />
    </Modal>
  )
}
