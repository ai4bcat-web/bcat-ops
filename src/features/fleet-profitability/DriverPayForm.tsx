import { useState } from 'react'
import { X } from 'lucide-react'
import { useDrivers } from '@/hooks/useDrivers'
import { driverPaySchema } from '@/lib/schemas'
import type { DriverPayPeriod } from '@/hooks/useDriverPay'

interface Props {
  onSave: (input: Omit<DriverPayPeriod, 'id' | 'createdAt' | 'updatedAt'>) => Promise<unknown>
  onClose: () => void
  /** Prefill the period to the currently-viewed week. */
  defaultStart?: string
  defaultEnd?: string
}

const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }
const inputStyle: React.CSSProperties = { height: 36, width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)', padding: '0 10px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)' }

/** Manual biweekly driver-pay entry. `source` is fixed to MANUAL (Paychex is the seam). */
export function DriverPayForm({ onSave, onClose, defaultStart, defaultEnd }: Props) {
  const { drivers } = useDrivers()
  const [form, setForm] = useState({
    driverId:    '',
    periodStart: defaultStart ?? '',
    periodEnd:   defaultEnd ?? '',
    grossPay:    '',
    notes:       '',
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const activeDrivers = drivers.filter((d) => d.active !== false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = driverPaySchema.safeParse({
      driverId:    form.driverId,
      periodStart: form.periodStart,
      periodEnd:   form.periodEnd,
      grossPay:    form.grossPay,
      source:      'MANUAL',
      notes:       form.notes || undefined,
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid input')
      return
    }
    setSaving(true)
    try {
      await onSave({
        driverId:    parsed.data.driverId,
        periodStart: parsed.data.periodStart,
        periodEnd:   parsed.data.periodEnd,
        grossPay:    parsed.data.grossPay,
        source:      'MANUAL',
        notes:       parsed.data.notes ?? null,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)', padding: 16 }}>
      <div style={{ background: 'var(--ds-surface)', borderRadius: 16, boxShadow: 'var(--sh-lg, 0 10px 40px rgba(0,0,0,0.2))', width: '100%', maxWidth: 460 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px', borderBottom: '1px solid var(--ds-border)' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>Add driver pay</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>Biweekly gross — spread across the weeks it covers</div>
          </div>
          <button aria-label="Close" onClick={onClose} style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Driver *</label>
            <select value={form.driverId} onChange={(e) => set('driverId', e.target.value)} style={inputStyle}>
              <option value="">— Select driver —</option>
              {activeDrivers.map((d) => (
                <option key={d.id} value={d.id}>{d.name}{d.assignedTruckId ? '' : ' (no truck assigned)'}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={labelStyle}>Period start *</label>
              <input type="date" value={form.periodStart} onChange={(e) => set('periodStart', e.target.value)} style={inputStyle} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={labelStyle}>Period end *</label>
              <input type="date" value={form.periodEnd} onChange={(e) => set('periodEnd', e.target.value)} style={inputStyle} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Gross pay (USD) *</label>
            <input type="number" step="0.01" min="0" value={form.grossPay} onChange={(e) => set('grossPay', e.target.value)} placeholder="0.00" style={inputStyle} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Notes</label>
            <input value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Optional" style={inputStyle} />
          </div>

          {error && <div style={{ fontSize: 12.5, color: '#dc2626' }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
            <button type="button" onClick={onClose} style={{ height: 36, padding: '0 16px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
            <button type="submit" disabled={saving} style={{ height: 36, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save pay'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
