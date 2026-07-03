import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import type { Driver } from '@/types'
import type { DriverAvailability } from '@/lib/apiClient'

type AvailType = DriverAvailability['type']

const TYPE_OPTIONS: { value: AvailType; label: string }[] = [
  { value: 'FULL_DAY_OFF', label: 'Full Day Off' },
  { value: 'EARLY_START',  label: 'Early Start' },
  { value: 'LATE_START',   label: 'Late Start' },
]

interface Props {
  drivers:        Driver[]
  editing?:       DriverAvailability | null   // present = edit mode; absent = add mode
  onClose:        () => void
  onCreate:       (input: Omit<DriverAvailability, 'id' | 'createdAt' | 'updatedAt'>) => Promise<unknown>
  onUpdate:       (id: string, patch: Partial<Omit<DriverAvailability, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<unknown>
  onDelete:       (id: string) => Promise<void>
}

export function TimeOffFormModal({ drivers, editing, onClose, onCreate, onUpdate, onDelete }: Props) {
  const { user } = useAuth()
  const currentUser = user?.email ?? 'dispatch'
  const isEdit = !!editing

  const [driverId,  setDriverId]  = useState(editing?.driverId  ?? '')
  const [type,      setType]      = useState<AvailType>(editing?.type ?? 'FULL_DAY_OFF')
  const [startDate, setStartDate] = useState(editing?.startDate ?? '')
  const [endDate,   setEndDate]   = useState(editing?.endDate   ?? '')
  const [time,      setTime]      = useState(editing?.time ?? '')
  const [note,      setNote]      = useState(editing?.note ?? '')
  const [saving,    setSaving]    = useState(false)
  const [deleting,  setDeleting]  = useState(false)

  const needsTime = type === 'EARLY_START' || type === 'LATE_START'
  const canSubmit = !!driverId && !!startDate && !!endDate && (!needsTime || !!time) && endDate >= startDate

  async function handleSave() {
    if (!canSubmit) return
    setSaving(true)
    try {
      const fields = {
        driverId,
        type,
        startDate,
        endDate,
        time: needsTime ? time : null,
        note: note || null,
      }
      if (isEdit && editing) await onUpdate(editing.id, fields)
      else await onCreate({ ...fields, createdBy: currentUser })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!editing) return
    setDeleting(true)
    try { await onDelete(editing.id); onClose() } finally { setDeleting(false) }
  }

  const activeDrivers = drivers.filter((d) => d.active).sort((a, b) => a.name.localeCompare(b.name))

  const inputStyle: React.CSSProperties = {
    height: 34, padding: '0 9px', borderRadius: 6,
    border: '1px solid var(--ds-border)', background: 'var(--ds-bg)',
    color: 'var(--ds-t1)', fontSize: 13, fontFamily: 'inherit', width: '100%',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: 'var(--ds-t2)',
    textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5,
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={onClose}
    >
      <div
        style={{ background: 'var(--ds-surface)', borderRadius: 10, border: '1px solid var(--ds-border)', boxShadow: '0 8px 32px rgba(0,0,0,0.22)', width: 460, maxWidth: '92vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>{isEdit ? 'Edit time off' : 'Add time off'}</span>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--ds-t3)', lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>

        {/* Form */}
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
          <div>
            <label style={labelStyle}>Driver</label>
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)} style={inputStyle}>
              <option value="">Select driver…</option>
              {activeDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as AvailType)} style={inputStyle}>
              {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: needsTime ? '1fr 1fr 90px' : '1fr 1fr', gap: 10 }}>
            <div>
              <label style={labelStyle}>From</label>
              <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); if (!endDate || endDate < e.target.value) setEndDate(e.target.value) }} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>To</label>
              <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
            </div>
            {needsTime && (
              <div>
                <label style={labelStyle}>Time</label>
                <input type="text" placeholder="08:00" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle} />
              </div>
            )}
          </div>

          <div>
            <label style={labelStyle}>Note (optional)</label>
            <input type="text" placeholder="e.g. Doctor appointment" value={note} onChange={(e) => setNote(e.target.value)} style={inputStyle} />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexShrink: 0 }}>
          {isEdit ? (
            <button
              onClick={handleDelete}
              disabled={deleting || saving}
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: '#dc2626', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: deleting ? 0.5 : 1 }}
            >
              <Trash2 size={14} /> {deleting ? 'Removing…' : 'Remove'}
            </button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onClose}
              style={{ height: 34, padding: '0 14px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || deleting || !canSubmit}
              style={{ height: 34, padding: '0 18px', borderRadius: 6, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: canSubmit ? 'pointer' : 'default', opacity: (!canSubmit || saving) ? 0.5 : 1 }}
            >
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
