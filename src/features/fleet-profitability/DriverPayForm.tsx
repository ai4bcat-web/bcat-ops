import { useState } from 'react'
import { PayModal } from '@/features/driver-pay/DriverPayForms'
import { useDrivers } from '@/hooks/useDrivers'
import { driverPaySchema } from '@/lib/schemas'
import { combinedPayDriverId } from '@/lib/fleetGroups'
import { useDriverTypes } from '@/hooks/useDriverTypes'
import type { FleetGroup } from '@/types/equipment'
import type { DriverPayPeriod } from '@/hooks/useDriverPay'
import { errorText } from '@/lib/errorText'

interface Props {
  onSave: (input: Omit<DriverPayPeriod, 'id' | 'createdAt' | 'updatedAt'>) => Promise<unknown>
  onClose: () => void
  /** Prefill the period to the currently-viewed week. */
  defaultStart?: string
  defaultEnd?: string
  /** Fleet the entry is for — enables a single "all {fleet} drivers combined" option. */
  fleetGroup?: FleetGroup
}

const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }
const inputStyle: React.CSSProperties = { height: 36, width: '100%', borderRadius: 8, border: '1px solid var(--tms-border)', padding: '0 10px', fontSize: 13, background: 'var(--tms-card)', color: 'var(--tms-text)' }

/** Manual biweekly driver-pay entry. `source` is fixed to MANUAL (Paychex is the seam). */
export function DriverPayForm({ onSave, onClose, defaultStart, defaultEnd, fleetGroup = 'LOCAL' }: Props) {
  const { fleetGroupLabel } = useDriverTypes()
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
      setError(errorText(err))
      setSaving(false)
    }
  }

  return (
    <PayModal title="Add driver pay" sub="Biweekly gross — spread across the weeks it covers" onClose={onClose}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Driver / fleet *</label>
            <select value={form.driverId} onChange={(e) => set('driverId', e.target.value)} style={inputStyle}>
              <option value="">— Select driver —</option>
              <option value={combinedPayDriverId(fleetGroup)}>All {fleetGroupLabel(fleetGroup)} drivers (combined)</option>
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

          {error && <div style={{ fontSize: 12.5, color: 'var(--tms-badge-red)' }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
            <button type="button" onClick={onClose} style={{ height: 36, padding: '0 16px', borderRadius: 8, border: '1px solid var(--tms-border)', background: 'var(--tms-card)', color: 'var(--tms-text-2)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
            <button type="submit" disabled={saving} style={{ height: 36, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--tms-primary)', color: 'var(--tms-on-primary)', fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save pay'}</button>
          </div>
        </form>
    </PayModal>
  )
}
