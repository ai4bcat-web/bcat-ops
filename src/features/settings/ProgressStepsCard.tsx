/**
 * Settings > Progress steps: which steps the shipment form's Progress panel and "Next" chip show, per revenue division and per kind of
 * assignment (outside carrier, local driver on the driver app, owner operator on Motive). Steps come from a fixed catalog (src/lib/progressSteps.ts);
 * here a step is turned on or off, moved, or renamed. Nothing saved means the built-in steps. "Reset to default" removes the saved list.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, RotateCcw, Save, ListChecks } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { getTmsSettings, listOwnershipDivisions, saveTmsSettings } from '@/lib/apiClient'
import {
  STEP_VARIANTS, VARIANT_LABEL, catalogStep, resolveSteps, validateStepList, withMissingSteps,
  type ProgressStepsConfig, type StepSetting, type StepSource, type StepVariant,
} from '@/lib/progressSteps'
import type { OwnershipDivisionRecord, TmsSettings } from '@/types/tms'
import { CheckRow, ErrorText, Hint, Loading, SettingsCard, Stack } from './settingsKit'

const SOURCE_TEXT: Record<StepSource, string> = {
  WORKFLOW: 'Shipment workflow',
  DRIVER_APP: 'Driver app update',
  MOTIVE: 'Motive location',
  STOP_CLOCK: 'Stop arrival / departure (driver app or Motive)',
}

/** The three variants a division's steps are defined for; a division only uses the ones its loads can have. */
const configOf = (s: TmsSettings | null): ProgressStepsConfig => ((s?.progressSteps ?? {}) as ProgressStepsConfig)

export function ProgressStepsCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [divisions, setDivisions] = useState<OwnershipDivisionRecord[]>([])
  const [division, setDivision] = useState('')
  const [variant, setVariant] = useState<StepVariant>('CARRIER')
  const [rows, setRows] = useState<StepSetting[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    Promise.all([getTmsSettings(), listOwnershipDivisions()])
      .then(([s, d]) => {
        setSettings(s)
        const top = d.filter((x) => x.active && !x.parentId).sort((a, b) => a.sortOrder - b.sortOrder)
        setDivisions(top)
        const first = top[0]?.code ?? ''
        setDivision(first)
        setRows(withMissingSteps(resolveSteps(configOf(s), first, 'CARRIER'), 'CARRIER'))
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const saved = useMemo(() => Boolean(division && configOf(settings)[division]?.[variant]), [settings, division, variant])

  const load = (nextDivision: string, nextVariant: StepVariant, from: TmsSettings | null = settings) => {
    setDivision(nextDivision)
    setVariant(nextVariant)
    setRows(withMissingSteps(resolveSteps(configOf(from), nextDivision, nextVariant), nextVariant))
    setError(null)
  }

  const move = (i: number, by: -1 | 1) => setRows((prev) => {
    const j = i + by
    if (j < 0 || j >= prev.length) return prev
    const next = [...prev]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    return next
  })
  const patch = (i: number, p: Partial<StepSetting>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...p } : r)))

  const persist = async (next: ProgressStepsConfig, done: string) => {
    setSaving(true)
    try {
      const updated = await saveTmsSettings({ progressSteps: Object.keys(next).length > 0 ? next : null } as never, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success(done)
      return updated
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
      return null
    } finally { setSaving(false) }
  }

  const save = async () => {
    setError(null)
    let list: StepSetting[]
    try {
      list = validateStepList(rows, 'Progress steps', variant)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'These steps are not valid')
      return
    }
    const config = configOf(settings)
    const updated = await persist({ ...config, [division]: { ...config[division], [variant]: list } }, 'Progress steps saved')
    if (updated) load(division, variant, updated)
  }

  const reset = async () => {
    setError(null)
    const config = { ...configOf(settings) }
    const entry = { ...config[division] }
    delete entry[variant]
    if (Object.keys(entry).length > 0) config[division] = entry
    else delete config[division]
    const updated = await persist(config, 'Progress steps reset to the default')
    if (updated) load(division, variant, updated)
  }

  return (
    <SettingsCard
      icon={ListChecks}
      title="Progress steps"
      description="The steps the shipment's Progress panel and Next chip show, for each revenue division and kind of assignment. Turn steps on or off, reorder them or rename them."
    >
      {loading ? <Loading /> : (
        <Stack>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <TmsSelect aria-label="Revenue division" value={division} onChange={(e) => load(e.target.value, variant)}>
              {divisions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </TmsSelect>
            <TmsSelect aria-label="Kind of assignment" value={variant} onChange={(e) => load(division, e.target.value as StepVariant)}>
              {STEP_VARIANTS.map((v) => <option key={v} value={v}>{VARIANT_LABEL[v]}</option>)}
            </TmsSelect>
            <span className="tms-muted" style={{ alignSelf: 'center', fontSize: 12 }}>{saved ? 'Custom steps saved' : 'Using the default steps'}</span>
          </div>

          {rows.map((row, i) => (
            <div key={row.key} className="tms-grid" style={{ gridTemplateColumns: '5rem minmax(0, 1fr) minmax(0, 1fr) 4.5rem', gap: 8, alignItems: 'center' }} data-testid={`progress-step-${row.key}`}>
              <CheckRow label="On" checked={row.enabled} ariaLabel={`${catalogStep(row.key)?.label ?? row.key} on`} onChange={(enabled) => patch(i, { enabled })} />
              <TmsInput aria-label={`${catalogStep(row.key)?.label ?? row.key} name`} value={row.label} onChange={(e) => patch(i, { label: e.target.value })} />
              <span className="tms-muted" style={{ fontSize: 12 }}>{SOURCE_TEXT[catalogStep(row.key)?.source ?? 'WORKFLOW']}</span>
              <span style={{ display: 'flex', gap: 2 }}>
                <TmsIconButton shape="plain" aria-label={`Move ${catalogStep(row.key)?.label ?? row.key} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></TmsIconButton>
                <TmsIconButton shape="plain" aria-label={`Move ${catalogStep(row.key)?.label ?? row.key} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></TmsIconButton>
              </span>
            </div>
          ))}
          <Hint>A step that is off never shows. A delivered shipment shows every step before Delivered as done.</Hint>

          {error && <ErrorText>{error}</ErrorText>}
          <div style={{ display: 'flex', gap: 8 }}>
            <TmsButton variant="primary" size="sm" onClick={() => void save()} disabled={saving || !division}><Save size={14} /> Save steps</TmsButton>
            <TmsButton size="sm" onClick={() => void reset()} disabled={saving || !saved}><RotateCcw size={14} /> Reset to default</TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
