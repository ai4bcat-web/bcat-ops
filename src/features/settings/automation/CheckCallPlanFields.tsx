/**
 * The check-call plan form: cadence, channels, milestones, escalation. One copy, used by
 * the org default (Tracking automation card), a division override and the customer's
 * flow defaults. Whether a plan runs on its own is a policy switch
 * (`TrackingAutomationEditor`), not a plan field.
 */
import { TmsField, TmsInput } from '@/features/tms/kit'
import {
  type CheckCallPlan,
  CHANNEL_DISABLED_REASON,
  CHECK_CALL_CHANNELS,
  CHECK_CALL_MILESTONES,
  isChannelEnabled,
  MILESTONE_LABELS,
} from '@/lib/checkCallPlan'
import { CheckRow } from '../settingsKit'

export interface CheckCallPlanFieldsProps {
  value: CheckCallPlan
  onChange: (patch: Partial<CheckCallPlan>) => void
  disabled?: boolean
}

export function CheckCallPlanFields({ value: plan, onChange, disabled }: CheckCallPlanFieldsProps) {
  return (
    <div data-testid="check-call-plan-fields">
      <div className="tms-grid tms-grid-2">
        <TmsField label="Interval (hours)" hint="How often a moving load is pinged.">
          <TmsInput
            type="number"
            min={1}
            max={24}
            step={1}
            disabled={disabled}
            value={plan.intervalHours}
            onChange={(e) => onChange({ intervalHours: Number(e.target.value) })}
          />
        </TmsField>
        <TmsField label="Escalate after (minutes)" hint="Silence before the ladder repeats.">
          <TmsInput
            type="number"
            min={5}
            max={1440}
            step={1}
            disabled={disabled}
            value={plan.escalateAfterMinutes}
            onChange={(e) => onChange({ escalateAfterMinutes: Number(e.target.value) })}
          />
        </TmsField>
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 6 }}>
        <p className="tms-field-label" style={{ margin: 0, fontSize: 13 }}>Channels</p>
        {CHECK_CALL_CHANNELS.map((channel) => {
          const unavailable = !isChannelEnabled(channel)
          const checked = plan.channels.includes(channel)
          return (
            <CheckRow
              key={channel}
              checked={checked}
              disabled={disabled || unavailable}
              onChange={() => {
                if (unavailable) return
                onChange({
                  channels: checked
                    ? plan.channels.filter((c) => c !== channel)
                    : [...plan.channels, channel],
                })
              }}
              label={
                <span>
                  {channel}
                  {unavailable && (
                    <span className="tms-field-hint" style={{ marginLeft: 6 }}>
                      — {CHANNEL_DISABLED_REASON[channel]}
                    </span>
                  )}
                </span>
              }
            />
          )
        })}
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
        <p className="tms-field-label" style={{ margin: 0, fontSize: 13 }}>Milestones</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {CHECK_CALL_MILESTONES.map((milestone) => (
            <CheckRow
              key={milestone}
              checked={plan.milestones.includes(milestone)}
              disabled={disabled}
              onChange={() => {
                onChange({
                  milestones: plan.milestones.includes(milestone)
                    ? plan.milestones.filter((m) => m !== milestone)
                    : [...plan.milestones, milestone],
                })
              }}
              label={MILESTONE_LABELS[milestone]}
            />
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
        <CheckRow
          checked={plan.emailDispatcher}
          disabled={disabled}
          onChange={() => onChange({ emailDispatcher: !plan.emailDispatcher })}
          label="E-mail the dispatcher on the shipment thread"
        />
      </div>
    </div>
  )
}
