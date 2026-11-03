/** One row per ownership division; "edit" opens the policy editor plus an optional plan. */
import { useState } from 'react'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import { SEED_DIVISIONS } from '@/lib/ownership'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import type { CheckCallPlan } from '@/lib/checkCallPlan'
import type { AutomationPolicy, DivisionAutomation } from '@/lib/trackingAutomation'
import { CheckRow, Hint, Loading, Panel } from '../settingsKit'
import { CheckCallPlanFields } from './CheckCallPlanFields'
import { overrideCount } from './policyPatch'
import { TrackingAutomationEditor } from './TrackingAutomationEditor'

export interface DivisionsPanelProps {
  divisions: Record<string, DivisionAutomation>
  onChange: (next: Record<string, DivisionAutomation>) => void
  /** Policy a division inherits (defaults + global). */
  inherited: AutomationPolicy
  /** The org default plan, offered as the starting point of a division plan. */
  globalPlan: CheckCallPlan
  disabled?: boolean
}

export function DivisionsPanel({ divisions, onChange, inherited, globalPlan, disabled }: DivisionsPanelProps) {
  const { divisions: loaded, loading } = useOwnershipDivisions()
  const [editing, setEditing] = useState<string | null>(null)
  const rows = [...(loaded ?? SEED_DIVISIONS)].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))

  if (loading && !loaded) return <Loading />

  const update = (code: string, next: DivisionAutomation) => {
    const out = { ...divisions }
    if (overrideCount(next.policy) === 0 && !next.plan) delete out[code]
    else out[code] = next
    onChange(out)
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Hint>A shipment uses its sub-division's override first, then its division's, then the defaults. Saved with the Save button on the Defaults tab.</Hint>
      {rows.map((division) => {
        const entry = divisions[division.code] ?? {}
        const n = overrideCount(entry.policy) + (entry.plan ? 1 : 0)
        const open = editing === division.code
        return (
          <Panel key={division.code}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }} data-testid={`division-row-${division.code}`}>
              <strong style={{ flex: 1 }}>{division.name}</strong>
              <TmsBadge tone={n ? 'blue' : 'gray'}>{n ? `Overridden · ${n} ${n === 1 ? 'field' : 'fields'}` : 'Inherits defaults'}</TmsBadge>
              <TmsButton size="sm" onClick={() => setEditing(open ? null : division.code)}>
                {open ? 'Done' : 'Edit'}
              </TmsButton>
            </div>
            {open && (
              <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
                <TrackingAutomationEditor
                  scope="DIVISION"
                  value={entry.policy ?? {}}
                  inherited={inherited}
                  disabled={disabled}
                  onChange={(policy) => update(division.code, { ...entry, policy })}
                />
                <Panel>
                  <CheckRow
                    checked={!!entry.plan}
                    disabled={disabled}
                    ariaLabel="Override the check-call plan for this division"
                    label="Override the check-call plan for this division"
                    onChange={(on) => update(division.code, { ...entry, plan: on ? globalPlan : null })}
                  />
                  {entry.plan && (
                    <CheckCallPlanFields
                      value={entry.plan}
                      disabled={disabled}
                      onChange={(patch) => update(division.code, { ...entry, plan: { ...(entry.plan as CheckCallPlan), ...patch } })}
                    />
                  )}
                </Panel>
              </div>
            )}
          </Panel>
        )
      })}
    </div>
  )
}
