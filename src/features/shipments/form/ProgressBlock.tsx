/**
 * The summary rail's Progress block: every step a shipment goes through, from Created to Paid. A finished step shows a check, the carrier
 * it concerned and who did it and when; the one step to do now is highlighted with what to do; the rest wait. The steps and the next
 * step come from `buildShipmentSteps` (one place, so this, the header chip and the stage chip agree).
 */
import { Check, Circle, ArrowRight } from 'lucide-react'
import { memo, useMemo } from 'react'
import { buildShipmentSteps, nextStepOf, type AuditStepRow } from '@/lib/shipmentSteps'
import { formatDateTime } from '@/lib/date'
import type { ShipmentBundle, UserProfileRecord } from '@/types/tms'
import { useShipmentActivity } from './useShipmentActivity'
import { useAssetStepInputs } from './useAssetStepInputs'
import type { ProgressStepsConfig } from '@/lib/progressSteps'

export interface ProgressBlockProps {
  bundle: ShipmentBundle | null
  staff: readonly UserProfileRecord[]
  /** `TmsSettings.progressSteps`; absent = the built-in steps. */
  config?: ProgressStepsConfig | null
  /** Takes the carrier or own-fleet leg off (shown on the Covered step). */
  onUncover?: () => void
  disabled?: boolean
}

function ProgressBlockImpl({ bundle, staff, config, onUncover, disabled }: ProgressBlockProps) {
  const data = useShipmentActivity(bundle)
  const asset = useAssetStepInputs(bundle, true)
  const steps = useMemo(
    () => buildShipmentSteps(bundle, (data?.entries ?? []) as unknown as AuditStepRow[], staff, { ...asset, config }),
    [bundle, data, staff, asset, config],
  )
  if (!bundle || steps.length === 0) return null
  const next = nextStepOf(steps)
  return (
    <section className="tms-rail-block tms-rail-progress" data-testid="rail-progress" aria-label="Progress">
      <h2 className="tms-rail-h">Progress</h2>
      {next ? (
        <p className="tms-rail-next" data-testid="rail-next-step">
          <ArrowRight size={12} aria-hidden="true" />
          <span><strong>Next:</strong> {next.action}{next.waiting ? <em> ({next.waiting})</em> : null}</span>
        </p>
      ) : (
        <p className="tms-rail-next" data-done="true" data-testid="rail-next-step">Every step is done.</p>
      )}
      <ol className="tms-rail-prog">
        {steps.map((s) => (
          <li key={s.key} className="tms-rail-prog-row" data-state={s.state} data-testid={`rail-prog-${s.key}`}>
            <span className="tms-rail-prog-mark" aria-hidden="true">
              {s.state === 'done' ? <Check size={12} /> : <Circle size={12} />}
            </span>
            <span className="tms-rail-prog-body">
              <span className="tms-rail-prog-label">{s.label}</span>
              {s.state === 'done' && (s.carrier || s.by || s.at) ? (
                <span className="tms-rail-prog-meta">
                  {[s.carrier, s.by ? `by ${s.by}` : null, s.at ? formatDateTime(s.at) : null].filter(Boolean).join(' · ')}
                </span>
              ) : null}
              {s.key === 'covered' && s.state === 'done' && onUncover ? (
                <button type="button" className="tms-rail-more" data-testid="rail-uncover" disabled={disabled} onClick={onUncover}>Uncover</button>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export const ProgressBlock = memo(ProgressBlockImpl)
