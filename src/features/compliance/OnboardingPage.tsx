import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardCheck, Users, Rocket, CheckCircle2, ExternalLink, Pencil, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { KpiCard } from '@/components/ui/kpi-card'
import { useAppStore } from '@/store/useAppStore'
import { useReviewQueue } from '@/hooks/useReviewQueue'
import { listAllOnboardingTasks, getTemplateConfig } from '@/lib/complianceClient'
import { isTaskDone } from '@/lib/onboardingPhases'
import { AMAZON_DRIVER_TEMPLATE } from '@/lib/onboardingTemplates'
import { ReviewQueueSection } from '@/features/compliance-review/ReviewQueuePage'
import { OnboardingPipelineSection } from './OnboardingPipelinePage'
import { OnboardingTemplateEditor } from './OnboardingTemplateEditor'
import { OfficeTasksSection } from './OfficeTasksSection'
import type { OnboardingTask, DriverOnboardingStatus } from '@/types'

const ACTIVE: DriverOnboardingStatus[] = ['INVITED', 'IN_PROGRESS', 'PENDING_REVIEW']

export function OnboardingPage() {
  const navigate = useNavigate()
  const drivers = useAppStore((s) => s.drivers)
  const { pendingCount } = useReviewQueue()
  const [tasks, setTasks] = useState<OnboardingTask[]>([])
  const [customized, setCustomized] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)

  useEffect(() => {
    listAllOnboardingTasks().then(setTasks).catch((e) => console.error('[onboarding kpis]', e))
    getTemplateConfig(AMAZON_DRIVER_TEMPLATE.id).then((c) => setCustomized(!!c)).catch(() => {})
  }, [editorOpen])

  const officeOutstanding = tasks.filter((t) => (t.owner === 'OFFICE' || !!t.assignee) && !isTaskDone(t)).length
  const inProgress = drivers.filter((d) => ACTIVE.includes(d.onboardingStatus ?? 'NOT_STARTED')).length
  const completed = drivers.filter((d) => d.onboardingStatus === 'COMPLETE').length

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Onboarding</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>Approve portal submissions and track drivers moving through onboarding.</p>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button variant="outline" onClick={() => window.open('/onboard/MOCK', '_blank', 'noopener')}><ExternalLink size={15} /> View driver portal</Button>
            <Button variant="outline" onClick={() => setEditorOpen(true)}><Pencil size={15} /> Edit template</Button>
            <Button onClick={() => navigate('/drivers')}><UserPlus size={15} /> Start a driver</Button>
          </div>
        </div>

        {/* Gradient template banner */}
        <div style={{ borderRadius: 14, padding: '16px 20px', color: '#fff', display: 'flex', alignItems: 'center', gap: 14, background: 'linear-gradient(120deg, #0b8fd9 0%, #1ea8f3 55%, #6d28d9 140%)', boxShadow: 'var(--sh-md)' }}>
          <div style={{ width: 42, height: 42, borderRadius: 11, background: 'rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Rocket size={20} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.85 }}>Onboarding template</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              <span style={{ fontSize: 17, fontWeight: 600 }}>{AMAZON_DRIVER_TEMPLATE.label}</span>
              <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 9px', background: 'rgba(255,255,255,0.2)' }}>{customized ? 'Customized' : 'Default'}</span>
            </div>
          </div>
          <button onClick={() => setEditorOpen(true)}
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 9, padding: '9px 18px', fontSize: 14, fontWeight: 600, background: '#fff', color: 'var(--ds-blue-dark)', border: 'none', cursor: 'pointer', flexShrink: 0 }}>
            <Pencil size={15} /> Edit
          </button>
        </div>

        {/* 4 KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <KpiCard label="Needs review" value={pendingCount} sublabel="portal submissions" icon={<ClipboardCheck size={15} />} accent="#1ea8f3" />
          <KpiCard label="Office / HR tasks" value={officeOutstanding} sublabel="outstanding" icon={<Users size={15} />} accent="#6d28d9" />
          <KpiCard label="In progress" value={inProgress} sublabel="drivers onboarding" icon={<Rocket size={15} />} accent="#b45309" />
          <KpiCard label="Completed" value={completed} sublabel="fully onboarded" icon={<CheckCircle2 size={15} />} accent="#16a34a" />
        </div>

        <ReviewQueueSection />
        <OfficeTasksSection />
        <OnboardingPipelineSection />
      </div>

      <OnboardingTemplateEditor open={editorOpen} onOpenChange={setEditorOpen} />
    </div>
  )
}
