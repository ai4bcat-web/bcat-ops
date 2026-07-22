import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, RefreshCw, Rocket } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store/useAppStore'
import { listAllOnboardingTasks, listAllOnboardingInvites } from '@/lib/complianceClient'
import { getOnboardingTemplate, ONBOARDING_TEMPLATES } from '@/lib/onboardingTemplates'
import { currentPhaseNumber, isTaskDone, overdueTasks } from '@/lib/onboardingPhases'
import { onboardingStatusLabel } from '@/lib/complianceStatus'
import { ProgressBar, Card } from './components'
import type { Driver, DriverOnboardingStatus, OnboardingInvite, OnboardingTask, OnboardingInviteStatus } from '@/types'

// Drivers actively moving through onboarding (excludes not-started and fully-complete).
const ACTIVE_STATUSES: DriverOnboardingStatus[] = ['INVITED', 'IN_PROGRESS', 'PENDING_REVIEW']

const INVITE_BADGE: Record<OnboardingInviteStatus, { variant: 'default' | 'green' | 'secondary' | 'orange' | 'destructive'; label: string }> = {
  SENT: { variant: 'default', label: 'Invite sent' },
  OPENED: { variant: 'default', label: 'Opened' },
  IN_PROGRESS: { variant: 'orange', label: 'In portal' },
  SUBMITTED: { variant: 'green', label: 'Submitted' },
  EXPIRED: { variant: 'secondary', label: 'Invite expired' },
  REVOKED: { variant: 'secondary', label: 'Invite revoked' },
}

function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

interface Row {
  driver: Driver
  templateLabel: string | null
  phased: boolean
  currentPhase: number
  totalPhases: number
  doneCount: number
  requiredCount: number
  overdueCount: number
  invite: OnboardingInvite | null
  lastActivity: string | null
}

/**
 * The "In progress" roster: drivers currently moving through onboarding, with template,
 * phase, progress, and invite status. Rendered as a section inside the merged Onboarding page.
 */
export function OnboardingPipelineSection() {
  const navigate = useNavigate()
  const drivers = useAppStore((s) => s.drivers)
  const [tasks, setTasks] = useState<OnboardingTask[]>([])
  const [invites, setInvites] = useState<OnboardingInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<'ACTIVE' | DriverOnboardingStatus | 'ALL'>('ACTIVE')
  const [templateFilter, setTemplateFilter] = useState<string>('ALL')

  async function load() {
    setLoading(true)
    try {
      const [t, i] = await Promise.all([listAllOnboardingTasks(), listAllOnboardingInvites()])
      setTasks(t)
      setInvites(i)
    } catch (e) {
      console.error('[onboarding pipeline] load error', e)
    } finally {
      setLoading(false)
    }
  }

  // Same data-load-on-mount pattern as the other compliance hooks/pages in this app.
  useEffect(() => { load() }, [])

  const rows = useMemo<Row[]>(() => {
    // Index tasks & invites for O(1) lookups.
    const driverTasks = new Map<string, OnboardingTask[]>()
    const truckTasks = new Map<string, OnboardingTask[]>()
    for (const t of tasks) {
      const bucket = t.entityType === 'TRUCK' ? truckTasks : driverTasks
      ;(bucket.get(t.entityId) ?? bucket.set(t.entityId, []).get(t.entityId)!).push(t)
    }
    const activeInviteByDriver = new Map<string, OnboardingInvite>()
    for (const inv of [...invites].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      // last write wins → newest invite per driver
      activeInviteByDriver.set(inv.driverId, inv)
    }

    return drivers
      .map((driver): Row | null => {
        const dTasks = driverTasks.get(driver.id) ?? []
        const inv = activeInviteByDriver.get(driver.id) ?? null
        const active = ACTIVE_STATUSES.includes(driver.onboardingStatus ?? 'NOT_STARTED')
        // Show a driver once they've entered onboarding by ANY signal: an invite was sent,
        // a checklist/template exists, or their status is active. (A sent invite alone —
        // e.g. before the phased checklist is generated — is enough to appear here.)
        if (dTasks.length === 0 && !driver.onboardingTemplateId && !inv && !active) return null
        const template = getOnboardingTemplate(driver.onboardingTemplateId ?? '')
        const phased = !!template
        const tTasks = driver.assignedTruckId ? (truckTasks.get(driver.assignedTruckId) ?? []) : []
        const combined = phased ? [...dTasks, ...tTasks] : dTasks

        const required = combined.filter((t) => t.required && t.status !== 'NOT_APPLICABLE')
        const doneCount = required.filter(isTaskDone).length
        const lastActivity = combined.reduce<string | null>((max, t) => {
          const ts = t.updatedAt || t.createdAt
          return !max || ts > max ? ts : max
        }, null)

        return {
          driver,
          templateLabel: template?.label ?? (dTasks.length ? 'Standard checklist' : null),
          phased,
          currentPhase: phased ? currentPhaseNumber(combined) : 0,
          totalPhases: template?.phases.length ?? 0,
          doneCount,
          requiredCount: required.length,
          overdueCount: overdueTasks(combined).length,
          invite: inv,
          lastActivity: lastActivity ?? inv?.sentAt ?? inv?.createdAt ?? null,
        }
      })
      .filter((r): r is Row => r !== null)
      .filter((r) => {
        if (statusFilter === 'ALL') return true
        const status = r.driver.onboardingStatus ?? 'NOT_STARTED'
        const liveInvite = !!r.invite && r.invite.status !== 'REVOKED' && r.invite.status !== 'EXPIRED'
        if (statusFilter === 'ACTIVE') return ACTIVE_STATUSES.includes(status) || liveInvite
        return status === statusFilter
      })
      .filter((r) => templateFilter === 'ALL' || (r.driver.onboardingTemplateId ?? 'STANDARD') === templateFilter)
      .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
  }, [drivers, tasks, invites, statusFilter, templateFilter])

  return (
    <>
      {/* Filters + refresh */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="h-9 rounded-md border border-input bg-white px-3 text-sm">
            <option value="ACTIVE">Active (invited · in progress · review)</option>
            <option value="INVITED">Invited</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="PENDING_REVIEW">Pending review</option>
            <option value="COMPLETE">Complete</option>
            <option value="ALL">All</option>
          </select>
          <select value={templateFilter} onChange={(e) => setTemplateFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-white px-3 text-sm">
            <option value="ALL">All templates</option>
            <option value="STANDARD">Standard checklist</option>
            {ONBOARDING_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}><RefreshCw size={14} /> Refresh</Button>
      </div>

      <Card title="In progress" sub={loading ? 'Loading…' : `${rows.length} driver${rows.length === 1 ? '' : 's'}`} noPad>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  {['Driver', 'Template', 'Phase', 'Progress', 'Invite', 'Last activity', ''].map((h, i) => (
                    <th key={h} style={{ padding: '8px 16px', textAlign: i === 6 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--ds-t3)' }}>
                    No drivers match. Start one from Drivers → a driver → Start onboarding.
                  </td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.driver.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ fontWeight: 500, color: 'var(--ds-t1)' }}>{r.driver.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>{onboardingStatusLabel(r.driver.onboardingStatus)}</div>
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--ds-t2)' }}>
                      {r.templateLabel ? <Badge variant={r.phased ? 'default' : 'secondary'}>{r.templateLabel}</Badge> : '—'}
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--ds-t2)' }}>
                      {r.phased ? `Phase ${r.currentPhase} / ${r.totalPhases}` : '—'}
                      {r.overdueCount > 0 && <Badge variant="destructive" className="ml-2">{r.overdueCount} overdue</Badge>}
                    </td>
                    <td style={{ padding: '10px 16px', minWidth: 150 }}>
                      <ProgressBar value={r.doneCount} max={r.requiredCount} />
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {r.invite ? <Badge variant={INVITE_BADGE[r.invite.status].variant}>{INVITE_BADGE[r.invite.status].label}</Badge>
                        : <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>No invite</span>}
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--ds-t3)', fontSize: 12 }}>{fmtDateTime(r.lastActivity)}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/compliance/driver/${r.driver.id}`)}>
                        <ExternalLink size={14} /> Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ds-t3)' }}>
        <Rocket size={13} /> Start a new driver from Drivers → open a driver → Start onboarding.
      </div>
    </>
  )
}
