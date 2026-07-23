import { ReviewQueueSection } from '@/features/compliance-review/ReviewQueuePage'
import { OnboardingPipelineSection } from './OnboardingPipelinePage'
import { OnboardingTemplateEditor } from './OnboardingTemplateEditor'

/**
 * Merged onboarding hub: the approvals worklist ("Needs review") on top of the driver
 * pipeline roster ("In progress"). Replaces the separate Review Queue + Onboarding pages —
 * one surface for processing new hires. The sidebar's review badge points here.
 */
export function OnboardingPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>Onboarding</h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
            Approve portal submissions and track drivers moving through onboarding.
          </p>
        </div>

        <OnboardingTemplateEditor />
        <ReviewQueueSection />
        <OnboardingPipelineSection />
      </div>
    </div>
  )
}
