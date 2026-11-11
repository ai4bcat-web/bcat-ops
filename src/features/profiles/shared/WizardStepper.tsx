import type { ReactNode } from 'react'
import { TmsButton } from '@/features/tms/kit'
import './profiles.css'

export interface WizardStep { key: string; label: string }

/**
 * The step header and the Back / Next footer every "new ..." wizard uses (drivers now, trucks and
 * trailers next). The wizard owns what each step shows and whether Next is allowed; this only
 * draws the progress and the buttons, so the three wizards look and behave alike.
 */
export function WizardStepper({
  steps, current, children, canNext, nextError, onBack, onNext, onFinish, finishLabel = 'Create', busy, onCancel,
}: {
  steps: WizardStep[]
  current: number
  children: ReactNode
  canNext: boolean
  /** Shown beside the buttons when Next is blocked and the person has tried. */
  nextError?: string | null
  onBack: () => void
  onNext: () => void
  onFinish: () => void
  finishLabel?: string
  busy?: boolean
  onCancel: () => void
}) {
  const last = current === steps.length - 1
  return (
    <div className="pf-wizard">
      <ol className="pf-steps" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s.key} className="pf-step" data-state={i < current ? 'done' : i === current ? 'current' : 'todo'} aria-current={i === current ? 'step' : undefined}>
            <span className="pf-step-label">{s.label}</span>
          </li>
        ))}
      </ol>
      <div className="tms-card"><div className="tms-card-body">{children}</div></div>
      {nextError ? <div role="alert" style={{ color: 'var(--tms-badge-red)', fontSize: 12.5 }}>{nextError}</div> : null}
      <div className="pf-wizard-foot">
        <TmsButton variant="ghost" onClick={current === 0 ? onCancel : onBack} disabled={busy}>{current === 0 ? 'Cancel' : 'Back'}</TmsButton>
        {last ? (
          <TmsButton variant="primary" onClick={onFinish} disabled={busy}>{busy ? 'Creating…' : finishLabel}</TmsButton>
        ) : (
          <TmsButton variant="primary" onClick={onNext} disabled={!canNext}>Next</TmsButton>
        )}
      </div>
    </div>
  )
}
