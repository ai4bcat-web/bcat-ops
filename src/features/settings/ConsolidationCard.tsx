/**
 * Consolidation rules: which differences between shipments are allowed to be
 * grouped together, and how strongly the rule is enforced.
 *
 * This card owns `consolidationRules` on `TmsSettings` and sends the whole object
 * on every save.
 */
import { useEffect, useState } from 'react'
import { Combine, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import type { ConsolidationCategory, ConsolidationHazmatMode, ConsolidationOnHold, ConsolidationRule, ConsolidationRules, TmsSettings } from '@/types/tms'
import { ErrorText, GroupLabel, Hint, Loading, Panel, SettingsCard, Stack } from './settingsKit'

const CATEGORIES: readonly ConsolidationCategory[] = [
  'CUSTOMER_MISMATCH',
  'TEMPERATURE',
  'WEIGHT_TOTAL',
  'STOP_COUNT',
  'PICKUP_WINDOW_DAYS',
  'EQUIPMENT_MISMATCH',
  'HAZMAT',
  'ON_HOLD',
]

const CATEGORY_LABELS: Record<ConsolidationCategory, string> = {
  CUSTOMER_MISMATCH: 'Customer mismatch',
  TEMPERATURE: 'Temperature requirement',
  WEIGHT_TOTAL: 'Total weight',
  STOP_COUNT: 'Stop count',
  PICKUP_WINDOW_DAYS: 'Pickup window days',
  EQUIPMENT_MISMATCH: 'Equipment mismatch',
  HAZMAT: 'Hazmat',
  ON_HOLD: 'On-hold shipment',
}

const CATEGORY_UNITS: Record<ConsolidationCategory, string | null> = {
  CUSTOMER_MISMATCH: null,
  TEMPERATURE: null,
  WEIGHT_TOTAL: 'lb',
  STOP_COUNT: 'stops',
  PICKUP_WINDOW_DAYS: 'days',
  EQUIPMENT_MISMATCH: null,
  HAZMAT: null,
  ON_HOLD: null,
}

const DEFAULT_THRESHOLDS: Record<ConsolidationCategory, number | null> = {
  CUSTOMER_MISMATCH: null,
  TEMPERATURE: null,
  WEIGHT_TOTAL: 45000,
  STOP_COUNT: 6,
  PICKUP_WINDOW_DAYS: 1,
  EQUIPMENT_MISMATCH: null,
  HAZMAT: null,
  ON_HOLD: null,
}

const SEVERITIES: { value: ConsolidationRule['severity']; label: string }[] = [
  { value: 'BLOCK', label: 'Block' },
  { value: 'WARN', label: 'Warn' },
  { value: 'OFF', label: 'Off' },
]

const HAZMODES: { value: ConsolidationHazmatMode; label: string }[] = [
  { value: 'NEVER', label: 'Never consolidate hazmat' },
  { value: 'SAME_CLASS', label: 'Only with matching hazmat class' },
  { value: 'ALLOW', label: 'Allow' },
]

const ONHOLD_OPTIONS: { value: ConsolidationOnHold; label: string }[] = [
  { value: 'BLOCK', label: 'Block' },
  { value: 'WARN', label: 'Warn' },
]

function defaultRules(): ConsolidationRule[] {
  return CATEGORIES.map((category) => ({
    category,
    severity: 'OFF',
    threshold: DEFAULT_THRESHOLDS[category],
    unit: CATEGORY_UNITS[category],
  }))
}

function normalizeRules(stored: ConsolidationRule[] | null | undefined): ConsolidationRule[] {
  const base = defaultRules()
  const byCategory = new Map((stored ?? []).map((r) => [r.category, r]))
  return base.map((rule) => {
    const saved = byCategory.get(rule.category)
    if (!saved) return rule
    return {
      ...rule,
      severity: SEVERITIES.some((s) => s.value === saved.severity) ? saved.severity : 'OFF',
      threshold: saved.threshold ?? rule.threshold,
      unit: saved.unit ?? rule.unit,
    }
  })
}

export function ConsolidationCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [rules, setRules] = useState<ConsolidationRule[]>(defaultRules())
  const [hazmatMode, setHazmatMode] = useState<ConsolidationHazmatMode>('NEVER')
  const [onHold, setOnHold] = useState<ConsolidationOnHold>('BLOCK')

  useEffect(() => {
    getTmsSettings()
      .then((s) => {
        setSettings(s)
        const stored = s?.consolidationRules
        setRules(normalizeRules(stored?.rules))
        setHazmatMode(stored?.hazmatMode ?? 'NEVER')
        setOnHold(stored?.onHold ?? 'BLOCK')
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const updateRule = (category: ConsolidationCategory, patch: Partial<ConsolidationRule>) => {
    setRules((prev) => prev.map((r) => (r.category === category ? { ...r, ...patch } : r)))
  }

  const save = async () => {
    setError(null)

    for (const rule of rules) {
      if (rule.severity !== 'OFF' && rule.threshold != null && CATEGORY_UNITS[rule.category] != null) {
        if (!Number.isInteger(rule.threshold) || rule.threshold < 0) {
          setError(`${CATEGORY_LABELS[rule.category]} threshold must be a non-negative whole number`)
          return
        }
      }
    }

    const out: ConsolidationRules = {
      rules: rules.map((r) => ({
        category: r.category,
        severity: r.severity,
        threshold: r.severity !== 'OFF' ? (r.threshold ?? null) : null,
        unit: r.severity !== 'OFF' ? (r.unit ?? null) : null,
      })),
      hazmatMode,
      onHold,
    }

    setSaving(true)
    try {
      const updated = await saveTmsSettings({ consolidationRules: out }, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('Consolidation rules saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={Combine}
      title="Consolidation"
      description="Rules for grouping shipments together: severity by category, hazmat handling and on-hold behaviour."
    >
      {loading ? <Loading /> : (
        <Stack>
          <Panel>
            <GroupLabel>Rules</GroupLabel>
            <div
              className="tms-field-label"
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 7rem 7rem 6rem',
                gap: 8,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '.04em',
              }}
            >
              <div>Category</div>
              <div>Severity</div>
              <div>Threshold</div>
              <div>Unit</div>
            </div>
            {rules.map((rule) => {
              const numeric = CATEGORY_UNITS[rule.category] != null
              return (
                <div key={rule.category} style={{ display: 'grid', gridTemplateColumns: '1fr 7rem 7rem 6rem', gap: 8, alignItems: 'center' }}>
                  <div style={{ fontSize: 14 }}>{CATEGORY_LABELS[rule.category]}</div>
                  <TmsSelect
                    aria-label={`${CATEGORY_LABELS[rule.category]} severity`}
                    value={rule.severity}
                    onChange={(e) => updateRule(rule.category, { severity: e.target.value as ConsolidationRule['severity'] })}
                    options={SEVERITIES}
                  />
                  {numeric ? (
                    <TmsInput
                      aria-label={`${CATEGORY_LABELS[rule.category]} threshold`}
                      type="number"
                      min={0}
                      step={1}
                      value={rule.threshold ?? ''}
                      onChange={(e) => updateRule(rule.category, { threshold: e.target.value === '' ? null : Number(e.target.value) })}
                      disabled={rule.severity === 'OFF'}
                    />
                  ) : (
                    <span className="tms-muted">—</span>
                  )}
                  <span className="tms-field-hint" style={{ fontSize: 13 }}>{CATEGORY_UNITS[rule.category] ?? '—'}</span>
                </div>
              )
            })}
            <Hint>Thresholds are ignored when severity is Off.</Hint>
          </Panel>

          <div className="tms-grid tms-grid-2">
            <TmsField label="Hazmat handling">
              <TmsSelect
                value={hazmatMode}
                onChange={(e) => setHazmatMode(e.target.value as ConsolidationHazmatMode)}
                options={HAZMODES}
              />
            </TmsField>
            <TmsField label="On-hold shipment handling">
              <TmsSelect
                value={onHold}
                onChange={(e) => setOnHold(e.target.value as ConsolidationOnHold)}
                options={ONHOLD_OPTIONS}
              />
            </TmsField>
          </div>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save consolidation rules
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
