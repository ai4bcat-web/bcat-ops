import { useState } from 'react'
import { useAuthenticator } from '@aws-amplify/ui-react'
import type { Driver } from '@/types'
import type { DriverAvailability } from '@/lib/apiClient'

type AvailType = 'FULL_DAY_OFF' | 'EARLY_START' | 'LATE_START'

const TYPE_LABELS: Record<AvailType, string> = {
  FULL_DAY_OFF: 'Full Day Off',
  EARLY_START:  'Early Start',
  LATE_START:   'Late Start',
}

interface Props {
  drivers:        Driver[]
  availabilities: DriverAvailability[]
  onClose:        () => void
  onCreate:       (input: Omit<DriverAvailability, 'id' | 'createdAt' | 'updatedAt'>) => Promise<unknown>
  onDelete:       (id: string) => Promise<void>
}

export function DriverAvailabilityModal({ drivers, availabilities, onClose, onCreate, onDelete }: Props) {
  const { user } = useAuthenticator()
  const currentUser = user?.signInDetails?.loginId ?? 'unknown'

  const [driverId,  setDriverId]  = useState('')
  const [type,      setType]      = useState<AvailType>('FULL_DAY_OFF')
  const [startDate, setStartDate] = useState('')
  const [endDate,   setEndDate]   = useState('')
  const [time,      setTime]      = useState('')
  const [note,      setNote]      = useState('')
  const [saving,    setSaving]    = useState(false)
  const [deleting,  setDeleting]  = useState<string | null>(null)

  const needsTime = type === 'EARLY_START' || type === 'LATE_START'
  const canSubmit = !!driverId && !!startDate && !!endDate && (!needsTime || !!time)

  async function handleAdd() {
    if (!canSubmit) return
    setSaving(true)
    try {
      await onCreate({
        driverId,
        type,
        startDate,
        endDate,
        time:      needsTime ? time : null,
        note:      note || null,
        createdBy: currentUser,
      })
      setDriverId(''); setType('FULL_DAY_OFF'); setStartDate(''); setEndDate(''); setTime(''); setNote('')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id)
    try { await onDelete(id) } finally { setDeleting(null) }
  }

  const activeDrivers = drivers.filter((d) => d.active).sort((a, b) => a.name.localeCompare(b.name))
  const sorted = [...availabilities].sort((a, b) => b.startDate.localeCompare(a.startDate))

  const inputStyle: React.CSSProperties = {
    height: 32, padding: '0 8px', borderRadius: 6,
    border: '1px solid var(--ds-border)', background: 'var(--ds-bg)',
    color: 'var(--ds-t1)', fontSize: 13,
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: 'var(--ds-t2)',
    textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4,
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={onClose}
    >
      <div
        style={{ background: 'var(--ds-surface)', borderRadius: 10, border: '1px solid var(--ds-border)', boxShadow: '0 8px 32px rgba(0,0,0,0.22)', width: 600, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>Driver Availability</span>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--ds-t3)', lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>

        {/* Add form */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
            <div>
              <label style={labelStyle}>Driver</label>
              <select value={driverId} onChange={(e) => setDriverId(e.target.value)} style={{ ...inputStyle, minWidth: 160 }}>
                <option value="">Select driver…</option>
                {activeDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Type</label>
              <select value={type} onChange={(e) => setType(e.target.value as AvailType)} style={{ ...inputStyle, minWidth: 130 }}>
                <option value="FULL_DAY_OFF">Full Day Off</option>
                <option value="EARLY_START">Early Start</option>
                <option value="LATE_START">Late Start</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>From</label>
              <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); if (!endDate) setEndDate(e.target.value) }} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>To</label>
              <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
            </div>
            {needsTime && (
              <div>
                <label style={labelStyle}>Time</label>
                <input type="text" placeholder="08:00" value={time} onChange={(e) => setTime(e.target.value)} style={{ ...inputStyle, width: 72 }} />
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Note (optional)</label>
              <input type="text" placeholder="e.g. Doctor appointment" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
            </div>
            <button
              onClick={handleAdd}
              disabled={saving || !canSubmit}
              style={{ height: 32, padding: '0 18px', borderRadius: 6, border: 'none', cursor: canSubmit ? 'pointer' : 'default', background: 'var(--ds-blue)', color: '#fff', fontWeight: 600, fontSize: 13, flexShrink: 0, opacity: (!canSubmit || saving) ? 0.5 : 1 }}
            >
              {saving ? 'Saving…' : 'Add'}
            </button>
          </div>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {sorted.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>No availability entries yet.</div>
          ) : (
            sorted.map((a) => {
              const driver = drivers.find((d) => d.id === a.driverId)
              const isOff  = a.type === 'FULL_DAY_OFF'
              const rangeStr = a.startDate === a.endDate ? a.startDate : `${a.startDate} → ${a.endDate}`
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 20px', borderBottom: '1px solid var(--ds-border)' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, background: isOff ? '#fef2f2' : '#fffbeb', color: isOff ? '#dc2626' : '#b45309', flexShrink: 0 }}>
                    {TYPE_LABELS[a.type]}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', flexShrink: 0 }}>
                    {driver?.name ?? 'Unknown'}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--ds-t3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {rangeStr}{a.time ? ` · ${a.time}` : ''}{a.note ? ` · ${a.note}` : ''}
                  </span>
                  <button
                    onClick={() => handleDelete(a.id)}
                    disabled={deleting === a.id}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ds-t3)', fontSize: 15, flexShrink: 0, padding: '2px 4px', borderRadius: 3, opacity: deleting === a.id ? 0.4 : 1 }}
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
