import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, Check, RefreshCw, Truck, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { listAllOnboardingTasks, setTaskStatus } from '@/lib/complianceClient'
import { isTaskDone } from '@/lib/onboardingPhases'
import { TaskStatusBadge, Card, InitialsAvatar } from './components'
import type { OnboardingTask } from '@/types'

function todayIso() { return new Date().toISOString().slice(0, 10) }

/**
 * Every outstanding OFFICE/HR-owned onboarding task across all drivers/trucks — so HR
 * can see their full to-do list, not just one driver at a time.
 */
export function OfficeTasksSection() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)
  const [tasks, setTasks] = useState<OnboardingTask[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try { setTasks(await listAllOnboardingTasks()) }
    catch (e) { console.error('[office tasks] load error', e) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  // Office-owned (or explicitly assigned) tasks that aren't finished yet.
  const office = tasks
    .filter((t) => (t.owner === 'OFFICE' || !!t.assignee) && !isTaskDone(t))
    .sort((a, b) =>
      (a.assignee ?? 'zzz').localeCompare(b.assignee ?? 'zzz') ||
      (a.phase ?? 0) - (b.phase ?? 0) ||
      a.sortOrder - b.sortOrder,
    )

  function entityFor(t: OnboardingTask) {
    if (t.entityType === 'TRUCK') {
      const eq = equipment.find((e) => e.id === t.entityId)
      const drv = drivers.find((d) => d.assignedTruckId === t.entityId)
      return { name: `Truck #${eq?.unitNumber ?? '—'}${drv ? ` · ${drv.name}` : ''}`, driverId: drv?.id, truckId: t.entityId, isTruck: true as const }
    }
    const d = drivers.find((x) => x.id === t.entityId)
    return { name: d?.name ?? t.entityId, driverId: d?.id, truckId: undefined, isTruck: false as const }
  }

  function open(t: OnboardingTask) {
    const e = entityFor(t)
    if (e.driverId) navigate(`/compliance/driver/${e.driverId}`)
    else if (e.isTruck) navigate(`/compliance/truck/${e.truckId}`)
  }

  async function markDone(t: OnboardingTask) {
    setBusyId(t.id)
    try { await setTaskStatus(t.id, 'COMPLETE', { completedBy: user?.email }); await load(); toast.success('Marked done') }
    catch (e) { console.error(e); toast.error('Could not update') }
    finally { setBusyId(null) }
  }

  const today = todayIso()

  return (
    <Card
      title="Office / HR tasks"
      sub={loading ? 'Loading…' : `${office.length} outstanding across all drivers`}
      right={<Button size="sm" variant="outline" onClick={load} disabled={loading}><RefreshCw size={14} /> Refresh</Button>}
      noPad
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
              {['Driver / Truck', 'Task', 'Phase', 'Assignee', 'Due', 'Status', ''].map((h, i) => (
                <th key={h} style={{ padding: '8px 16px', textAlign: i === 6 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!loading && office.length === 0 && (
              <tr><td colSpan={7} style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--ds-t3)' }}>No outstanding office tasks. 🎉</td></tr>
            )}
            {office.map((t) => {
              const e = entityFor(t)
              const overdue = !!t.dueDate && t.dueDate < today
              return (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <td style={{ padding: '9px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {e.isTruck
                        ? <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--ds-blue-bg)', color: 'var(--ds-blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Truck size={15} /></div>
                        : <InitialsAvatar name={e.name} colorKey={drivers.find((d) => d.id === e.driverId)?.colorKey} />}
                      <span style={{ fontWeight: 500, color: 'var(--ds-t1)' }}>{e.name}</span>
                    </div>
                  </td>
                  <td style={{ padding: '9px 16px', color: 'var(--ds-t2)' }}>{t.label}</td>
                  <td style={{ padding: '9px 16px', color: 'var(--ds-t3)' }}>{t.phase ? `Phase ${t.phase}` : '—'}</td>
                  <td style={{ padding: '9px 16px' }}>
                    {t.assignee ? <Badge variant="secondary">{t.assignee}</Badge> : <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Office</span>}
                  </td>
                  <td style={{ padding: '9px 16px', color: overdue ? 'var(--ds-red)' : 'var(--ds-t3)', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {t.dueDate ? <>{overdue && <AlertTriangle size={11} style={{ display: 'inline', marginRight: 3 }} />}{t.dueDate}</> : '—'}
                  </td>
                  <td style={{ padding: '9px 16px' }}><TaskStatusBadge status={t.status} /></td>
                  <td style={{ padding: '9px 16px' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
                      {!t.requiresDocument && (
                        <Button size="sm" disabled={busyId === t.id} onClick={() => markDone(t)} style={{ background: 'var(--ds-green)', color: '#fff', border: 'none' }}><Check size={13} /> Mark done</Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => open(t)} title="Open"><ExternalLink size={14} /> Open</Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
