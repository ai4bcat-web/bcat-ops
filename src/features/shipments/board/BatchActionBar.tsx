/**
 * Step AP — the bar that appears over a grid or list while rows are selected: one batch
 * action (Push to Load Review on the Shipments board and Intake, Release on Load Review),
 * the nine-row cap message, and every row's outcome (partial success is reported row by
 * row, never summarised away).
 */
import { TmsAlert, TmsButton } from '@/features/tms/kit'
import { MAX_REVIEW_BATCH, type BatchOutcome } from '../batchReview'

export interface BatchActionBarProps {
  actionLabel: string
  selectedCount: number
  running: boolean
  /** Shown when the last toggle was refused (the 10th row). */
  refusal: string | null
  outcomes: BatchOutcome[] | undefined
  onRun: () => void
  onClear: () => void
}

export function BatchActionBar({ actionLabel, selectedCount, running, refusal, outcomes, onRun, onClear }: BatchActionBarProps) {
  if (selectedCount === 0 && !outcomes?.length && !refusal) return null
  const failed = outcomes?.filter((o) => !o.ok) ?? []
  const done = (outcomes?.length ?? 0) - failed.length
  return (
    <div className="tms-batch-bar" data-testid="batch-action-bar">
      <div className="tms-batch-bar-row">
        <span className="tms-batch-bar-count" aria-live="polite">
          {selectedCount} selected (max {MAX_REVIEW_BATCH})
        </span>
        <TmsButton size="sm" disabled={running || selectedCount === 0} onClick={onRun}>
          {actionLabel}
        </TmsButton>
        <TmsButton size="sm" variant="ghost" disabled={running} onClick={onClear}>
          Clear
        </TmsButton>
      </div>
      {refusal ? (
        <div data-testid="batch-cap-message">
          <TmsAlert tone="orange" title="Selection limit" role="status">{refusal}</TmsAlert>
        </div>
      ) : null}
      {outcomes && outcomes.length > 0 ? (
        <div className="tms-batch-bar-results" data-testid="batch-results">
          <div>
            {done} of {outcomes.length} done{failed.length > 0 ? `, ${failed.length} not done` : ''}.
          </div>
          <ul>
            {outcomes.map((o) => (
              <li key={o.rowId} data-testid={`batch-result-${o.rowId}`} data-ok={o.ok ? 'true' : 'false'}>
                <strong>{o.rowLabel}</strong>
                {o.ok ? <> — {o.note ?? 'Done'}</> : <> — {o.reasons.join('; ')}</>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
