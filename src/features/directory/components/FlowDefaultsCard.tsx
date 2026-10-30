/**
 * Step P3 — the customer defaults that drive the end-to-end flow.
 *
 * Every value here is an *override* of the org default in `TmsSettings`. An empty
 * field means "inherit", not zero, so the placeholder always shows the effective
 * value from `resolveMargin` / `resolveRequiredFields` / `resolveCheckCallPlan`.
 */
import { useMemo, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { RepPicker, TeamPicker } from '@/components/RepPicker'
import { TmsButton, TmsCard, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { CheckRow, GroupLabel, Hint, Panel, Stack } from '@/features/settings/settingsKit'
import {
  type CheckCallPlan,
  CHANNEL_DISABLED_REASON,
  CHECK_CALL_CHANNELS,
  CHECK_CALL_MILESTONES,
  isChannelEnabled,
  MILESTONE_LABELS,
} from '@/lib/checkCallPlan'
import {
  type CustomerFlowSource,
  DEFAULT_REQUIRED_LOAD_FIELDS,
  REQUIRED_FIELD_CATALOG,
  resolveCheckCallPlan,
  resolveMargin,
  resolveRequiredFields,
} from '@/lib/flowDefaults'
import type { TmsSettings } from '@/types/tms'

const AUTO_REPLY_OPTIONS = [
  { value: '', label: '— inherit from org —' },
  { value: 'auto', label: 'Auto-send suggested rate' },
  { value: 'manual', label: 'Manual — queue for review' },
]

const PREVIEW_MODES = ['FTL', 'LTL']

export interface FlowDefaultsValue {
  defaultCarrierTeamKey: string
  defaultCarrierRepId: string
  marginTargetBps: number | null
  marginFloorBps: number | null
  quoteAutoReply: boolean | null
  requiredLoadFields: string[]
  checkCallPlan: CheckCallPlan | null
}

export interface FlowDefaultsCardProps {
  value: FlowDefaultsValue
  settings: TmsSettings | null
  onChange: (patch: Partial<FlowDefaultsValue>) => void
}

function percentOfBps(bps: number | null | undefined): string {
  if (bps == null) return ''
  return (bps / 100).toFixed(2)
}

function bpsOfPercent(text: string): number | null {
  const n = Number(text)
  if (text === '' || Number.isNaN(n)) return null
  return Math.round(n * 100)
}

function flowSourceFromValue(value: FlowDefaultsValue): CustomerFlowSource {
  return {
    defaultCarrierTeamKey: value.defaultCarrierTeamKey || null,
    defaultCarrierRepId: value.defaultCarrierRepId || null,
    marginTargetBps: value.marginTargetBps ?? undefined,
    marginFloorBps: value.marginFloorBps ?? undefined,
    quoteAutoReply: value.quoteAutoReply ?? undefined,
    requiredLoadFields: value.requiredLoadFields.length ? value.requiredLoadFields : undefined,
    checkCallPlan: value.checkCallPlan ?? undefined,
  }
}

export function FlowDefaultsCard({ value, settings, onChange }: FlowDefaultsCardProps) {
  const [previewMode, setPreviewMode] = useState<string>('')

  const flowSource = useMemo(() => flowSourceFromValue(value), [value])
  const resolved = useMemo(
    () => resolveMargin(settings, flowSource, previewMode),
    [settings, flowSource, previewMode],
  )
  const resolvedFields = useMemo(
    () => resolveRequiredFields(settings, flowSource),
    [settings, flowSource],
  )
  const resolvedPlan = useMemo(
    () => resolveCheckCallPlan(settings, flowSource, null),
    [settings, flowSource],
  )

  const orgFields = useMemo(
    () => new Set(settings?.defaultRequiredLoadFields?.length ? settings.defaultRequiredLoadFields : DEFAULT_REQUIRED_LOAD_FIELDS),
    [settings],
  )
  const groups = useMemo(
    () => [...new Set(REQUIRED_FIELD_CATALOG.map((f) => f.group))],
    [],
  )

  const effectiveTarget = resolved.targetBps
  const effectiveFloor = resolved.floorBps
  const targetHint = resolved.targetSource === 'CUSTOMER'
    ? 'Customer override'
    : resolved.targetSource === 'ORG_MODE'
      ? `Org default for ${previewMode}`
      : resolved.targetSource === 'ORG'
        ? 'Org default'
        : 'Built-in default'

  const plan = value.checkCallPlan ?? resolvedPlan
  const hasOverride = value.checkCallPlan != null

  const setPlan = (patch: Partial<CheckCallPlan>) => {
    onChange({ checkCallPlan: { ...plan, ...patch } })
  }

  const toggleField = (key: string) => {
    if (orgFields.has(key)) return
    const has = value.requiredLoadFields.includes(key)
    onChange({
      requiredLoadFields: has
        ? value.requiredLoadFields.filter((k) => k !== key)
        : [...value.requiredLoadFields, key],
    })
  }

  return (
    <TmsCard title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Settings2 size={14} aria-hidden="true" />Flow defaults</span>}>
      <Stack>
        <Panel>
          <GroupLabel>Assignment</GroupLabel>
          <div className="tms-grid tms-grid-2">
            <TmsField label="Default carrier team">
              <TeamPicker
                value={value.defaultCarrierTeamKey}
                onChange={(v) => onChange({ defaultCarrierTeamKey: v })}
                teams={settings?.teams}
                allowEmpty
                placeholder="— inherit from org —"
              />
            </TmsField>
            <TmsField label="Default carrier rep">
              <RepPicker
                role="CARRIER_REP"
                allowUnknown
                value={value.defaultCarrierRepId}
                onChange={(v) => onChange({ defaultCarrierRepId: v })}
                placeholder="— inherit from org —"
              />
            </TmsField>
          </div>
        </Panel>

        <Panel>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <GroupLabel>Margin</GroupLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="tms-field-hint">Preview for</span>
              <TmsSelect
                data-testid="preview-mode"
                value={previewMode}
                onChange={(e) => setPreviewMode(e.target.value)}
                placeholder="Mode"
                options={PREVIEW_MODES.map((m) => ({ value: m, label: m }))}
              />
            </div>
          </div>
          <div className="tms-grid tms-grid-2">
            <TmsField label="Target margin %" hint={targetHint}>
              <TmsInput
                type="number"
                step="0.01"
                min={0}
                max={99.99}
                value={percentOfBps(value.marginTargetBps)}
                placeholder={percentOfBps(effectiveTarget)}
                onChange={(e) => onChange({ marginTargetBps: bpsOfPercent(e.target.value) })}
              />
            </TmsField>
            <TmsField label="Floor margin %" hint={value.marginFloorBps != null ? 'Customer override' : 'Org default'}>
              <TmsInput
                type="number"
                step="0.01"
                min={0}
                max={99.99}
                value={percentOfBps(value.marginFloorBps)}
                placeholder={percentOfBps(effectiveFloor)}
                onChange={(e) => onChange({ marginFloorBps: bpsOfPercent(e.target.value) })}
              />
            </TmsField>
          </div>
          <TmsField label="Quote reply" hint={value.quoteAutoReply != null ? 'Customer override' : 'Org default'}>
            <TmsSelect
              value={value.quoteAutoReply === true ? 'auto' : value.quoteAutoReply === false ? 'manual' : ''}
              onChange={(e) => {
                const v = e.target.value
                onChange({ quoteAutoReply: v === 'auto' ? true : v === 'manual' ? false : null })
              }}
              options={AUTO_REPLY_OPTIONS}
            />
          </TmsField>
        </Panel>

        <Panel>
          <GroupLabel>Required fields for a fully built load</GroupLabel>
          <Hint>The org requires these five on every load; they cannot be removed here.</Hint>
          {groups.map((group) => (
            <div key={group}>
              <p className="tms-field-label" style={{ margin: '8px 0 6px', fontSize: 12 }}>{group}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {REQUIRED_FIELD_CATALOG.filter((f) => f.group === group).map((field) => {
                  const checked = resolvedFields.includes(field.key)
                  const disabled = orgFields.has(field.key)
                  return (
                    <CheckRow
                      key={field.key}
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleField(field.key)}
                      label={
                        <span>
                          {field.label}
                          {disabled && <span className="tms-field-hint" style={{ marginLeft: 6 }}>(org default)</span>}
                        </span>
                      }
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </Panel>

        <Panel>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <GroupLabel>Check-call plan</GroupLabel>
            <span className="tms-field-hint" data-testid="check-call-source">{hasOverride ? 'Customer override' : (settings?.defaultCheckCallPlan != null ? 'Org default' : 'Built-in default')}</span>
          </div>
          {hasOverride && (
            <div style={{ margin: '4px 0 10px' }}>
              <TmsButton variant="ghost" size="sm" onClick={() => onChange({ checkCallPlan: null })} data-testid="clear-check-call">
                Clear override
              </TmsButton>
            </div>
          )}
          <div className="tms-grid tms-grid-2">
            <TmsField label="Interval (hours)" hint="How often a moving load is pinged.">
              <TmsInput
                type="number"
                min={1}
                max={24}
                step={1}
                value={hasOverride ? String(plan.intervalHours) : ''}
                placeholder={String(resolvedPlan.intervalHours)}
                onChange={(e) => {
                  const text = e.target.value
                  if (text === '') {
                    if (hasOverride) setPlan({ intervalHours: resolvedPlan.intervalHours })
                    return
                  }
                  const n = Number(text)
                  if (Number.isNaN(n)) return
                  setPlan({ intervalHours: Math.max(1, Math.min(24, n)) })
                }}
              />
            </TmsField>
            <TmsField label="Escalate after (minutes)" hint="Silence before the ladder repeats.">
              <TmsInput
                type="number"
                min={5}
                max={1440}
                step={1}
                value={hasOverride ? String(plan.escalateAfterMinutes) : ''}
                placeholder={String(resolvedPlan.escalateAfterMinutes)}
                onChange={(e) => {
                  const text = e.target.value
                  if (text === '') {
                    if (hasOverride) setPlan({ escalateAfterMinutes: resolvedPlan.escalateAfterMinutes })
                    return
                  }
                  const n = Number(text)
                  if (Number.isNaN(n)) return
                  setPlan({ escalateAfterMinutes: Math.max(5, Math.min(1440, n)) })
                }}
              />
            </TmsField>
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 6 }}>
            <p className="tms-field-label" style={{ margin: 0, fontSize: 13 }}>Channels</p>
            {CHECK_CALL_CHANNELS.map((channel) => {
              const disabled = !isChannelEnabled(channel)
              const checked = plan.channels.includes(channel)
              return (
                <CheckRow
                  key={channel}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    if (disabled) return
                    setPlan({
                      channels: checked
                        ? plan.channels.filter((c) => c !== channel)
                        : [...plan.channels, channel],
                    })
                  }}
                  label={
                    <span>
                      {channel}
                      {disabled && (
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
                  onChange={() => {
                    setPlan({
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
              onChange={() => setPlan({ emailDispatcher: !plan.emailDispatcher })}
              label="E-mail the dispatcher on the shipment thread"
            />
            <CheckRow
              checked={plan.requestPodOnDelivery}
              onChange={() => setPlan({ requestPodOnDelivery: !plan.requestPodOnDelivery })}
              label="Ask for the POD on delivery confirmation"
            />
          </div>
        </Panel>
      </Stack>
    </TmsCard>
  )
}
