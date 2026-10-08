/**
 * ELD oversight for the fleet manager: every recent run that left the 150 air-mile
 * radius — so needed logs — who drove it, and whether somebody confirmed the logs were
 * kept. The tick records who and when on the load, so the answer survives the page.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardList, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { eldRunsOutsideRadius, type EldRunRow } from '@/lib/eldMonitor'
import { SHORT_HAUL_AIR_MILES, WORK_REPORTING_LOCATION } from '@/lib/eldRadius'
import { fleetBucketOf } from '@/lib/revenueByFleet'
import { formatDateShort } from '@/lib/date'

const WINDOWS = [7, 30, 90] as const
const KIND: Record<string, string> = { OWNER_OP: 'Owner op', IVAN: 'Ivan local', BOX_TRUCK: 'Box truck', BROKER: 'Broker', UNASSIGNED: '' }

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function EldLogsWidget() {
  const loads = useAppStore((s) => s.loads)
  const drivers = useAppStore((s) => s.drivers)
  const updateLoad = useAppStore((s) => s.updateLoad)
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  const { user } = useAuth()
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30)
  const [busy, setBusy] = useState<string | null>(null)

  const rows = useMemo(() => eldRunsOutsideRadius(loads, { sinceDays: days, now: new Date() }), [loads, days])
  const open = rows.filter((r) => !r.reviewed).length
  const driverById = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers])

  async function setHandled(row: EldRunRow, handled: boolean) {
    setBusy(row.load.id)
    try {
      await updateLoad(row.load.id, handled
        ? { eldLogsReviewedAt: new Date().toISOString(), eldLogsReviewedBy: user?.email ?? 'staff' }
        : { eldLogsReviewedAt: null, eldLogsReviewedBy: null })
      toast.success(handled ? `Logs handled for PRO ${row.load.aljexId || '—'}` : 'Reopened')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', display: 'flex', alignItems: 'center', gap: 7 }}>
            <ClipboardList size={15} /> ELD logs — runs outside {SHORT_HAUL_AIR_MILES} air miles
            {open > 0 && (
              <span aria-label={`${open} runs with logs not yet confirmed`} style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 999, padding: '1px 8px', fontSize: 11.5, fontWeight: 700 }}>
                {open} to confirm
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
            Every run in the window that left the radius from {WORK_REPORTING_LOCATION.name} and needed records of duty status. Tick it once the logs are checked.
          </div>
        </div>
        <div role="group" aria-label="Window" style={{ display: 'flex', gap: 4 }}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              aria-pressed={days === w}
              style={{ height: 28, padding: '0 10px', borderRadius: 6, border: '1px solid var(--ds-border)', background: days === w ? 'var(--ds-t1)' : 'var(--ds-bg)', color: days === w ? '#fff' : 'var(--ds-t2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              {w}d
            </button>
          ))}
          <Link to="/hours" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 28, padding: '0 10px', fontSize: 12, fontWeight: 600, color: 'var(--ds-blue)' }}>
            Motive logs <ExternalLink size={12} />
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: '20px', fontSize: 13, color: 'var(--ds-t3)', textAlign: 'center' }}>
          No runs left the radius in the last {days} days.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>
                {['Day', 'Driver', 'PRO', 'Farthest stop', 'Logs', 'Handled'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 16px', borderBottom: '1px solid var(--ds-border)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const driver = r.driverId ? driverById.get(r.driverId) : undefined
                const kind = driver ? KIND[fleetBucketOf(driver)] : ''
                return (
                  <tr key={r.load.id} style={{ borderBottom: '1px solid var(--ds-border)', opacity: r.reviewed ? 0.7 : 1 }}>
                    <td style={{ padding: '10px 16px', whiteSpace: 'nowrap', color: 'var(--ds-t1)' }}>{formatDateShort(`${r.day}T12:00:00Z`)}</td>
                    <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: 600, color: 'var(--ds-t1)' }}>{driver?.name ?? 'Unassigned'}</span>
                      {kind && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>{kind}</span>}
                    </td>
                    <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>
                      <button type="button" onClick={() => setSelectedLoad(r.load.id, 'view')} style={{ all: 'unset', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--ds-blue)' }}>
                        {r.load.aljexId || '—'}
                      </button>
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--ds-t2)' }}>
                      {r.status === 'REQUIRED'
                        ? `${r.farthestCity} · ${r.farthestMiles} air mi`
                        : `Could not place ${r.unplaceable.join(', ') || 'a stop'}`}
                    </td>
                    <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', padding: '2px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 600, background: r.status === 'REQUIRED' ? '#dbeafe' : '#fef3c7', color: r.status === 'REQUIRED' ? '#1d4ed8' : '#b45309' }}>
                        {r.status === 'REQUIRED' ? 'Logs required' : 'Check'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          aria-label={`Logs handled for PRO ${r.load.aljexId || r.load.id}`}
                          checked={!!r.reviewed}
                          disabled={busy === r.load.id}
                          onChange={(e) => void setHandled(r, e.target.checked)}
                          style={{ width: 16, height: 16, accentColor: '#16a34a' }}
                        />
                        <span style={{ fontSize: 12, color: r.reviewed ? '#15803d' : 'var(--ds-t3)' }}>
                          {r.reviewed ? `${r.reviewed.by ?? 'staff'} · ${when(r.reviewed.at)}` : 'Not yet'}
                        </span>
                      </label>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
