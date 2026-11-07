import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { useAuth } from '@/hooks/useAuth'
import type { Driver } from '@/types'
import type { DriverAvailability } from '@/lib/apiClient'
import { addStaffPtoDay } from '@/lib/staffTimeOff'
import { PTO_HOURS } from '@/lib/timeOff'

type AvailType = DriverAvailability['type']

const TYPE_OPTIONS: { value: AvailType; label: string }[] = [
  { value: 'FULL_DAY_OFF', label: 'Full Day Off' },
  { value: 'EARLY_START',  label: 'In Early By' },
  { value: 'LATE_START',   label: 'Late Start' },
  { value: 'PTO',          label: 'PTO (8h)' },
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
  const [error,     setError]     = useState<string | null>(null)

  const isPto = type === 'PTO'
  // A saved PTO day is also a time-clock row on the server: remove it here, edit nothing.
  const readOnly = isEdit && editing?.type === 'PTO'
  const needsTime = type === 'EARLY_START' || type === 'LATE_START'
  const canSubmit = !!driverId && !!startDate && (isPto || (!!endDate && endDate >= startDate)) && (!needsTime || !!time)

  async function handleSave() {
    if (!canSubmit || readOnly) return
    setSaving(true)
    setError(null)
    try {
      if (isPto) {
        // The server writes the approved PTO row and the 8-hour time-clock row together.
        await addStaffPtoDay(driverId, startDate, note)
      } else {
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
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!editing) return
    setDeleting(true)
    setError(null)
    try { await onDelete(editing.id); onClose() }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not remove') }
    finally { setDeleting(false) }
  }

  const activeDrivers = drivers.filter((d) => d.active).sort((a, b) => a.name.localeCompare(b.name))

  const inputStyle: React.CSSProperties = {
    height: 34, padding: '0 9px', borderRadius: 6,
    border: '1px solid var(--tms-border)', background: 'var(--tms-bg)',
    color: 'var(--tms-text)', fontSize: 13, fontFamily: 'inherit', width: '100%',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: 'var(--tms-text-2)',
    textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5,
  }

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title={isEdit ? 'Edit time off' : 'Add time off'}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%' }}>
          {isEdit ? (
            <TmsButton variant="destructive" onClick={handleDelete} disabled={deleting || saving}>
              <Trash2 size={14} /> {deleting ? 'Removing…' : 'Remove'}
            </TmsButton>
          ) : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <TmsButton variant="secondary" onClick={onClose}>Cancel</TmsButton>
            {!readOnly && (
              <TmsButton variant="primary" onClick={handleSave} disabled={saving || deleting || !canSubmit}>
                {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add'}
              </TmsButton>
            )}
          </div>
        </div>
      }
    >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Driver</label>
            <select aria-label="Driver" value={driverId} onChange={(e) => setDriverId(e.target.value)} disabled={readOnly} style={inputStyle}>
              <option value="">Select driver…</option>
              {activeDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Type</label>
            <select
              aria-label="Type"
              value={type}
              onChange={(e) => setType(e.target.value as AvailType)}
              disabled={readOnly}
              style={inputStyle}
            >
              {/* A saved day keeps its type; PTO only exists as a new entry (it has a time-clock row). */}
              {TYPE_OPTIONS.filter((o) => o.value !== 'PTO' || !isEdit || readOnly).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isPto ? '1fr 90px' : needsTime ? '1fr 1fr 90px' : '1fr 1fr', gap: 10 }}>
            <div>
              <label style={labelStyle}>{isPto ? 'Day' : 'From'}</label>
              <input
                type="date"
                aria-label={isPto ? 'Day' : 'From'}
                value={startDate}
                disabled={readOnly}
                onChange={(e) => { setStartDate(e.target.value); if (!endDate || endDate < e.target.value) setEndDate(e.target.value) }}
                style={inputStyle}
              />
            </div>
            {isPto ? (
              <div>
                <label style={labelStyle}>Hours</label>
                <div style={{ ...inputStyle, display: 'flex', alignItems: 'center' }}>{PTO_HOURS}h</div>
              </div>
            ) : (
              <div>
                <label style={labelStyle}>To</label>
                <input type="date" aria-label="To" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
              </div>
            )}
            {needsTime && (
              <div>
                <label style={labelStyle}>{type === 'EARLY_START' ? 'In by' : 'Time'}</label>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle} />
              </div>
            )}
          </div>

          <div>
            <label style={labelStyle}>Note (optional)</label>
            <input type="text" aria-label="Note" placeholder="e.g. Doctor appointment" value={note} disabled={readOnly} onChange={(e) => setNote(e.target.value)} style={inputStyle} />
          </div>
          {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--tms-badge-red)' }}>{error}</div>}
        </div>
    </TmsDialog>
  )
}
