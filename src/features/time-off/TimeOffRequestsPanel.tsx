import { useState } from 'react'
import { Check, X } from 'lucide-react'
import type { DriverAvailability } from '@/lib/apiClient'
import { describeRange, statusOf } from '@/lib/timeOff'

const TYPE_LABEL: Record<DriverAvailability['type'], string> = {
  FULL_DAY_OFF: 'Full Day Off',
  EARLY_START: 'In Early By',
  LATE_START: 'Late Start',
  PTO: 'PTO',
}

interface Props {
  requests: DriverAvailability[]
  driverName: (driverId: string) => string
  onApprove: (id: string) => void
  onDeny: (id: string, note: string) => void
  /** The request being reviewed right now: its buttons are disabled. */
  busyId: string | null
}

function requestedOn(createdAt: string): string {
  const d = new Date(createdAt)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const btn: React.CSSProperties = {
  height: 30, padding: '0 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600,
  fontFamily: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
}

export function TimeOffRequestsPanel({ requests, driverName, onApprove, onDeny, busyId }: Props) {
  // Oldest first: the request that has waited longest is answered first.
  const pending = requests
    .filter((r) => statusOf(r) === 'PENDING')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const [denying, setDenying] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const closeDeny = () => { setDenying(null); setNote('') }

  return (
    <section
      aria-label="Requests"
      style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}
    >
      <div style={{ padding: pending.length === 0 ? '10px 20px' : '14px 20px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: pending.length === 0 ? 'none' : '1px solid var(--tms-border)' }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)', margin: 0 }}>Requests</h2>
        <span
          data-testid="requests-count"
          style={{ fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 10, background: pending.length ? 'var(--tms-badge-orange-tint)' : 'var(--tms-bg)', color: pending.length ? 'var(--tms-badge-orange)' : 'var(--tms-muted)' }}
        >
          {pending.length}
        </span>
        {pending.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--tms-muted)' }}>No requests waiting</span>}
      </div>

      {pending.map((r) => {
        const busy = busyId === r.id
        return (
          <div key={r.id} data-testid="request-row" style={{ padding: '10px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-text)', minWidth: 130 }}>{driverName(r.driverId)}</span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: 'var(--tms-bg)', color: 'var(--tms-text-2)' }}>
                {TYPE_LABEL[r.type]}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--tms-text-2)', fontVariantNumeric: 'tabular-nums' }}>
                {describeRange(r.startDate, r.endDate)}{r.time ? ` · ${r.time}` : ''}
              </span>
              {r.hours != null && <span style={{ fontSize: 12.5, color: 'var(--tms-text-2)', fontVariantNumeric: 'tabular-nums' }}>{r.hours}h</span>}
              {r.note && <span style={{ fontSize: 12, color: 'var(--tms-muted)', flex: 1, minWidth: 80 }}>{r.note}</span>}
              <span style={{ fontSize: 11.5, color: 'var(--tms-muted)', marginLeft: 'auto' }}>requested {requestedOn(r.createdAt)}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onApprove(r.id)}
                  style={{ ...btn, border: 'none', background: 'var(--tms-badge-green)', color: 'var(--tms-on-primary)', opacity: busy ? 0.5 : 1 }}
                >
                  <Check size={13} /> Approve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { setDenying(r.id); setNote('') }}
                  style={{ ...btn, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-badge-red)', opacity: busy ? 0.5 : 1 }}
                >
                  <X size={13} /> Deny
                </button>
              </div>
            </div>

            {denying === r.id && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="text"
                  autoFocus
                  aria-label="Reason for denying (optional)"
                  placeholder="Reason for denying (optional)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  style={{ flex: 1, height: 30, padding: '0 9px', borderRadius: 6, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text)', fontSize: 13, fontFamily: 'inherit' }}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { onDeny(r.id, note.trim()); closeDeny() }}
                  style={{ ...btn, border: 'none', background: 'var(--tms-badge-red)', color: 'var(--tms-on-primary)', opacity: busy ? 0.5 : 1 }}
                >
                  Confirm deny
                </button>
                <button type="button" onClick={closeDeny} style={{ ...btn, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text-2)' }}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
