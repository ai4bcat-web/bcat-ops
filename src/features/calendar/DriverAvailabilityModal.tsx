import { useState } from 'react'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { useAuth } from '@/hooks/useAuth'
import type { Driver } from '@/types'
import type { DriverAvailability } from '@/lib/apiClient'
import type { TimeOffType } from '@/lib/timeOff'

type AvailType = 'FULL_DAY_OFF' | 'EARLY_START' | 'LATE_START'

// PTO rows are listed here too (approved ones), though only the Time Off page adds them.
const TYPE_LABELS: Record<TimeOffType, string> = {
  FULL_DAY_OFF: 'Full Day Off',
  EARLY_START:  'In Early By',
  LATE_START:   'Late Start',
  PTO:          'PTO',
}

interface Props {
  drivers:        Driver[]
  availabilities: DriverAvailability[]
  onClose:        () => void
  onCreate:       (input: Omit<DriverAvailability, 'id' | 'createdAt' | 'updatedAt'>) => Promise<unknown>
  onDelete:       (id: string) => Promise<void>
}

export function DriverAvailabilityModal({ drivers, availabilities, onClose, onCreate, onDelete }: Props) {
  const { user } = useAuth()
  const currentUser = user?.email ?? 'dispatch'

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
    border: '1px solid var(--tms-border)', background: 'var(--tms-bg)',
    color: 'var(--tms-text)', fontSize: 13,
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: 'var(--tms-text-2)',
    textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4,
  }

  return (
    <TmsDialog open onOpenChange={(o) => { if (!o) onClose() }} title="Driver Availability">
      <div style={{ margin: 'calc(var(--tms-pad) * -1)', display: 'flex', flexDirection: 'column' }}>
        {/* Add form */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--tms-border)', flexShrink: 0 }}>
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
                <option value="EARLY_START">In Early By</option>
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
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ ...inputStyle, width: 110 }} />
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Note (optional)</label>
              <input type="text" placeholder="e.g. Doctor appointment" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
            </div>
            <TmsButton
              variant="primary"
              onClick={handleAdd}
              disabled={saving || !canSubmit}
              style={{ flexShrink: 0 }}
            >
              {saving ? 'Saving…' : 'Add'}
            </TmsButton>
          </div>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {sorted.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--tms-muted)', fontSize: 13 }}>No availability entries yet.</div>
          ) : (
            sorted.map((a) => {
              const driver = drivers.find((d) => d.id === a.driverId)
              const isOff  = a.type === 'FULL_DAY_OFF' || a.type === 'PTO'
              const rangeStr = a.startDate === a.endDate ? a.startDate : `${a.startDate} → ${a.endDate}`
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 20px', borderBottom: '1px solid var(--tms-border)' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, background: isOff ? 'var(--tms-badge-red-tint)' : 'var(--tms-badge-orange-tint)', color: isOff ? 'var(--tms-badge-red)' : 'var(--tms-badge-orange)', flexShrink: 0 }}>
                    {TYPE_LABELS[a.type]}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-text)', flexShrink: 0 }}>
                    {driver?.name ?? 'Unknown'}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--tms-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {rangeStr}{a.time ? ` · ${a.time}` : ''}{a.note ? ` · ${a.note}` : ''}
                  </span>
                  <button
                    onClick={() => handleDelete(a.id)}
                    disabled={deleting === a.id}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--tms-muted)', fontSize: 15, flexShrink: 0, padding: '2px 4px', borderRadius: 3, opacity: deleting === a.id ? 0.4 : 1 }}
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
    </TmsDialog>
  )
}
