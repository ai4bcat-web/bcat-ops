/**
 * TMS defaults: margin floor, payment terms, accessorial codes, invoice format,
 * and Step P3 — the org-level flow defaults that every customer inherits.
 *
 * `saveTmsSettings` uses "keep" semantics: undefined leaves a field alone, null
 * clears it, and a value replaces it. This card sends every field it owns on every
 * save, so edits never erase fields in other tabs.
 */
import { useEffect, useMemo, useState } from 'react'
import { Save, Cog } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import type { TmsSettings } from '@/types/tms'
import {
  type CheckCallPlan,
  CHANNEL_DISABLED_REASON,
  CHECK_CALL_CHANNELS,
  CHECK_CALL_MILESTONES,
  DEFAULT_CHECK_CALL_PLAN,
  isChannelEnabled,
  MILESTONE_LABELS,
} from '@/lib/checkCallPlan'
import { REQUIRED_FIELD_CATALOG } from '@/lib/flowDefaults'
import { CheckRow, ErrorText, GroupLabel, Loading, Panel, SettingsCard, Stack } from './settingsKit'

function percentOfBps(bps: number | null | undefined): string {
  if (bps == null) return ''
  return (bps / 100).toFixed(2)
}

function bpsOfPercent(text: string): number | null {
  const n = Number(text)
  if (text === '' || Number.isNaN(n)) return null
  return Math.round(n * 100)
}

const REQUIRED_GROUPS = [...new Set(REQUIRED_FIELD_CATALOG.map((f) => f.group))]

export function TmsSettingsCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [marginFloorBps, setMarginFloorBps] = useState('')
  const [defaultPaymentTermsDays, setDefaultPaymentTermsDays] = useState('')
  const [accessorialCodes, setAccessorialCodes] = useState('')
  const [invoiceNumberFormat, setInvoiceNumberFormat] = useState('')

  // Step P3 org defaults.
  const [marginTargetBps, setMarginTargetBps] = useState('')
  const [marginTargetBpsByMode, setMarginTargetBpsByMode] = useState({ FTL: '', LTL: '' })
  const [quoteAutoReplyDefault, setQuoteAutoReplyDefault] = useState<boolean | null>(null)
  const [defaultRequiredLoadFields, setDefaultRequiredLoadFields] = useState<string[]>([])
  const [defaultCheckCallPlan, setDefaultCheckCallPlan] = useState<CheckCallPlan>(DEFAULT_CHECK_CALL_PLAN)

  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s) => {
        setSettings(s)
        setMarginFloorBps(s?.marginFloorBps != null ? String(s.marginFloorBps) : '')
        setDefaultPaymentTermsDays(s?.defaultPaymentTermsDays != null ? String(s.defaultPaymentTermsDays) : '')
        setAccessorialCodes(Array.isArray(s?.accessorialCodes) ? s.accessorialCodes.map(String).join('\n') : '')
        setInvoiceNumberFormat(s?.invoiceNumberFormat ?? '')

        setMarginTargetBps(s?.marginTargetBps != null ? String(s.marginTargetBps) : '')
        const byMode = s?.marginTargetBpsByMode && typeof s.marginTargetBpsByMode === 'object'
          ? s.marginTargetBpsByMode as Record<string, number>
          : {}
        setMarginTargetBpsByMode({ FTL: String(byMode.FTL ?? ''), LTL: String(byMode.LTL ?? '') })
        setQuoteAutoReplyDefault(s?.quoteAutoReplyDefault ?? null)
        setDefaultRequiredLoadFields(Array.isArray(s?.defaultRequiredLoadFields) ? s.defaultRequiredLoadFields as string[] : [])
        setDefaultCheckCallPlan(s?.defaultCheckCallPlan ?? DEFAULT_CHECK_CALL_PLAN)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const typedMarginTarget = useMemo(() => bpsOfPercent(marginTargetBps), [marginTargetBps])
  const typedMarginFloor = useMemo(() => bpsOfPercent(marginFloorBps), [marginFloorBps])
  const typedByMode = useMemo(
    () => ({
      FTL: bpsOfPercent(marginTargetBpsByMode.FTL),
      LTL: bpsOfPercent(marginTargetBpsByMode.LTL),
    }),
    [marginTargetBpsByMode],
  )

  const save = async () => {
    setError(null)

    const parsedAccessorialCodes = accessorialCodes.trim()
      ? accessorialCodes.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : null

    if (marginFloorBps.trim()) {
      if (typedMarginFloor == null) { setError('Margin floor must be a non-negative number'); return }
    }
    if (defaultPaymentTermsDays.trim()) {
      const terms = Number(defaultPaymentTermsDays)
      if (Number.isNaN(terms) || terms < 0) { setError('Default payment terms must be a non-negative number'); return }
    }
    if (marginTargetBps.trim() && typedMarginTarget == null) {
      setError('Margin target must be a non-negative number')
      return
    }
    if (typedMarginTarget != null && typedMarginFloor != null && typedMarginFloor > typedMarginTarget) {
      setError('Margin floor cannot be above the margin target')
      return
    }
    for (const mode of ['FTL', 'LTL'] as const) {
      const v = marginTargetBpsByMode[mode]
      if (v.trim() && bpsOfPercent(v) == null) {
        setError(`Margin target for ${mode} must be a non-negative number`)
        return
      }
    }

    const marginTargetBpsByModeOut: Record<string, number> | null = {}
    if (marginTargetBpsByMode.FTL.trim() && typedByMode.FTL != null) marginTargetBpsByModeOut.FTL = typedByMode.FTL
    if (marginTargetBpsByMode.LTL.trim() && typedByMode.LTL != null) marginTargetBpsByModeOut.LTL = typedByMode.LTL
    const finalByMode = Object.keys(marginTargetBpsByModeOut).length ? marginTargetBpsByModeOut : null

    const patch: Parameters<typeof saveTmsSettings>[0] = {
      marginFloorBps: marginFloorBps.trim() ? typedMarginFloor : null,
      defaultPaymentTermsDays: defaultPaymentTermsDays.trim() ? Number(defaultPaymentTermsDays) : null,
      accessorialCodes: parsedAccessorialCodes,
      invoiceNumberFormat: invoiceNumberFormat.trim() || null,
      // Step P3 org defaults.
      marginTargetBps: marginTargetBps.trim() && typedMarginTarget != null ? typedMarginTarget : null,
      marginTargetBpsByMode: finalByMode,
      quoteAutoReplyDefault,
      defaultRequiredLoadFields: defaultRequiredLoadFields.length ? defaultRequiredLoadFields : null,
      defaultCheckCallPlan: defaultCheckCallPlan,
    }

    setSaving(true)
    try {
      const updated = await saveTmsSettings(patch, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('TMS settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  const plan = defaultCheckCallPlan
  const setPlan = (patch: Partial<CheckCallPlan>) => {
    setDefaultCheckCallPlan({ ...plan, ...patch })
  }

  return (
    <SettingsCard
      icon={Cog}
      title="TMS defaults"
      description="Margin floor, payment terms, accessorial codes, invoice format and the flow defaults every customer inherits."
    >
      {loading ? <Loading /> : (
        <Stack>
          <Panel>
            <GroupLabel>General</GroupLabel>
            <div className="tms-grid tms-grid-2">
              <TmsField label="Margin floor (basis points)">
                <TmsInput value={marginFloorBps} onChange={(e) => setMarginFloorBps(e.target.value)} placeholder="e.g. 1500 for 15%" />
              </TmsField>
              <TmsField label="Default payment terms (days)">
                <TmsInput value={defaultPaymentTermsDays} onChange={(e) => setDefaultPaymentTermsDays(e.target.value)} placeholder="e.g. 30" />
              </TmsField>
            </div>
            <TmsField label="Accessorial codes (one per line)">
              <TmsTextarea value={accessorialCodes} onChange={(e) => setAccessorialCodes(e.target.value)} placeholder="LINEHAUL&#10;FSC&#10;DETENTION" rows={4} />
            </TmsField>
            <TmsField label="Invoice number format">
              <TmsInput value={invoiceNumberFormat} onChange={(e) => setInvoiceNumberFormat(e.target.value)} placeholder="e.g. BL{YYYY}-{SEQ:0000}" />
            </TmsField>
          </Panel>

          <Panel>
            <GroupLabel>Default margin</GroupLabel>
            <div className="tms-grid tms-grid-3">
              <TmsField label="Target margin %" hint="Used when there is no per-mode override.">
                <TmsInput
                  type="number"
                  step="0.01"
                  min={0}
                  max={99.99}
                  value={percentOfBps(typedMarginTarget)}
                  onChange={(e) => setMarginTargetBps(e.target.value)}
                />
              </TmsField>
              <TmsField label="FTL target %" hint="Overrides the general target for FTL.">
                <TmsInput
                  type="number"
                  step="0.01"
                  min={0}
                  max={99.99}
                  value={marginTargetBpsByMode.FTL}
                  onChange={(e) => setMarginTargetBpsByMode((p) => ({ ...p, FTL: e.target.value }))}
                />
              </TmsField>
              <TmsField label="LTL target %" hint="Overrides the general target for LTL.">
                <TmsInput
                  type="number"
                  step="0.01"
                  min={0}
                  max={99.99}
                  value={marginTargetBpsByMode.LTL}
                  onChange={(e) => setMarginTargetBpsByMode((p) => ({ ...p, LTL: e.target.value }))}
                />
              </TmsField>
            </div>
            <TmsField label="Quote reply">
              <TmsSelect
                value={quoteAutoReplyDefault === true ? 'auto' : quoteAutoReplyDefault === false ? 'manual' : ''}
                onChange={(e) => {
                  const v = e.target.value
                  setQuoteAutoReplyDefault(v === 'auto' ? true : v === 'manual' ? false : null)
                }}
                options={[
                  { value: '', label: '— unset —' },
                  { value: 'auto', label: 'Auto-send suggested rate' },
                  { value: 'manual', label: 'Manual — queue for review' },
                ]}
              />
            </TmsField>
          </Panel>

          <Panel>
            <GroupLabel>Required fields for a fully built load</GroupLabel>
            {REQUIRED_GROUPS.map((group) => (
              <div key={group}>
                <p className="tms-field-label" style={{ margin: '8px 0 6px', fontSize: 12 }}>{group}</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {REQUIRED_FIELD_CATALOG.filter((f) => f.group === group).map((field) => (
                    <CheckRow
                      key={field.key}
                      checked={defaultRequiredLoadFields.includes(field.key)}
                      onChange={() => {
                        setDefaultRequiredLoadFields((prev) =>
                          prev.includes(field.key)
                            ? prev.filter((k) => k !== field.key)
                            : [...prev, field.key],
                        )
                      }}
                      label={field.label}
                    />
                  ))}
                </div>
              </div>
            ))}
          </Panel>

          <Panel>
            <GroupLabel>Default check-call plan</GroupLabel>
            <div className="tms-grid tms-grid-2">
              <TmsField label="Interval (hours)" hint="How often a moving load is pinged.">
                <TmsInput
                  type="number"
                  min={1}
                  max={24}
                  step={1}
                  value={plan.intervalHours}
                  onChange={(e) => setPlan({ intervalHours: Number(e.target.value) })}
                />
              </TmsField>
              <TmsField label="Escalate after (minutes)" hint="Silence before the ladder repeats.">
                <TmsInput
                  type="number"
                  min={5}
                  max={1440}
                  step={1}
                  value={plan.escalateAfterMinutes}
                  onChange={(e) => setPlan({ escalateAfterMinutes: Number(e.target.value) })}
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

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save settings
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
