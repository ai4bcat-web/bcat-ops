import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Rocket } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store/useAppStore'
import { useOnboardingTasks } from '@/hooks/useOnboardingTasks'
import { onboardingStatusLabel } from '@/lib/complianceStatus'
import { ComplianceBadge, ProgressBar, TaskStatusBadge, Card } from './components'
import { InvitePanel } from './InvitePanel'
import { ComplianceDocumentsCard } from './ComplianceDocumentsCard'
import { DriverApplicationView } from './DriverApplicationView'
import { OnboardingKickoffDialog } from './OnboardingKickoffDialog'

export function DriverComplianceDetailPage() {
  const { driverId = '' } = useParams()
  const navigate = useNavigate()
  const driver = useAppStore((s) => s.drivers.find((d) => d.id === driverId))
  const { tasks, loading, doneCount, requiredCount } = useOnboardingTasks('DRIVER', driverId)
  const [kickoffOpen, setKickoffOpen] = useState(false)

  if (!driver) {
    return (
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 32px' }}>
        <Button variant="ghost" onClick={() => navigate('/drivers')}><ArrowLeft size={15} /> Back</Button>
        <p style={{ marginTop: 16, color: 'var(--ds-t3)' }}>Driver not found.</p>
      </div>
    )
  }

  const classificationLabel = driver.driverType === 'COMPANY' ? 'Company Driver'
    : driver.driverType === 'OWNER_OPERATOR' ? 'Owner-Operator' : 'Unclassified'

  // Group tasks by category for display
  const byCategory = tasks.reduce<Record<string, typeof tasks>>((acc, t) => {
    (acc[t.category] ??= []).push(t)
    return acc
  }, {})

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/drivers')}><ArrowLeft size={15} /> Drivers</Button>
        </div>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>{driver.name}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Badge variant={driver.driverType ? 'outline' : 'secondary'}>{classificationLabel}</Badge>
              <ComplianceBadge status={driver.complianceStatus} />
              <span style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>Onboarding: {onboardingStatusLabel(driver.onboardingStatus)}</span>
            </div>
          </div>
          {tasks.length === 0 && !loading && (
            <Button onClick={() => setKickoffOpen(true)}><Rocket size={15} /> Start onboarding</Button>
          )}
        </div>

        {/* Onboarding progress */}
        {tasks.length > 0 && driver.onboardingStatus !== 'COMPLETE' && (
          <Card title="Onboarding progress" sub={`${doneCount} of ${requiredCount} required items complete`}>
            <ProgressBar value={doneCount} max={requiredCount} />
          </Card>
        )}

        {/* Checklist */}
        {tasks.length > 0 && (
          <Card title="Checklist" sub={`${tasks.length} items`} noPad>
            <div style={{ padding: '8px 0' }}>
              {Object.entries(byCategory).map(([cat, items]) => (
                <div key={cat}>
                  <div style={{ padding: '8px 18px 4px', fontSize: 11, fontWeight: 700, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{cat}</div>
                  {items.map((t) => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 18px', borderBottom: '1px solid var(--ds-border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13.5, color: 'var(--ds-t1)' }}>{t.label}</span>
                        {t.required && <span style={{ fontSize: 10, color: '#dc2626' }}>required</span>}
                        {!t.driverVisible && <span style={{ fontSize: 10, color: 'var(--ds-t3)' }}>internal</span>}
                      </div>
                      <TaskStatusBadge status={t.status} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Invite + Application + Documents */}
        <InvitePanel driver={driver} />
        <DriverApplicationView driverId={driver.id} />
        <ComplianceDocumentsCard entityType="DRIVER" entityId={driver.id} />
      </div>

      <OnboardingKickoffDialog driver={driver} open={kickoffOpen} onOpenChange={setKickoffOpen} />
    </div>
  )
}
