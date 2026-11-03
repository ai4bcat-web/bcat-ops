import { useEffect, useMemo, useState } from 'react'
import { Bot, Play, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsButton, TmsSegmentedTabs } from '@/features/tms/kit'
import { getTmsSettings, runTrackingAutomation, saveTrackingAutomation, type AutomationRunResult } from '@/lib/apiClient'
import { BUILD } from '@/lib/buildInfo'
import { type CheckCallPlan, DEFAULT_CHECK_CALL_PLAN } from '@/lib/checkCallPlan'
import {
  DEFAULT_AUTOMATION_POLICY,
  normalizeTrackingAutomation,
  resolveAutomation,
  type AutomationPolicyPatch,
  type DivisionAutomation,
} from '@/lib/trackingAutomation'
import type { TmsSettings } from '@/types/tms'
import { CheckCallPlanFields } from './automation/CheckCallPlanFields'
import { CustomersPanel } from './automation/CustomersPanel'
import { DivisionsPanel } from './automation/DivisionsPanel'
import { patchProblems } from './automation/policyPatch'
import { TrackingAutomationEditor } from './automation/TrackingAutomationEditor'
import { ErrorText, GroupLabel, Hint, Loading, Panel, SettingsCard, Stack } from './settingsKit'

type Tab = 'defaults' | 'divisions' | 'customers'
const TABS = [
  { key: 'defaults', label: 'Defaults' },
  { key: 'divisions', label: 'Divisions' },
  { key: 'customers', label: 'Customers' },
]

export function TrackingAutomationCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState<Tab>('defaults')
  const [global, setGlobal] = useState<AutomationPolicyPatch>({})
  const [divisions, setDivisions] = useState<Record<string, DivisionAutomation>>({})
  const [plan, setPlan] = useState<CheckCallPlan>(DEFAULT_CHECK_CALL_PLAN)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AutomationRunResult | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s) => {
        setSettings(s)
        const stored = normalizeTrackingAutomation(s?.trackingAutomation)
        setGlobal(stored.global)
        setDivisions(stored.divisions)
        setPlan(s?.defaultCheckCallPlan ?? DEFAULT_CHECK_CALL_PLAN)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  // What a division or customer inherits: defaults plus the global layer as currently edited.
  const aboveDivision = useMemo(
    () => resolveAutomation({ settings: { trackingAutomation: { global, divisions: {} } }, customer: null, load: null }).policy,
    [global],
  )

  const problems = useMemo(() => {
    const out = [...patchProblems(global, DEFAULT_AUTOMATION_POLICY)]
    for (const [code, entry] of Object.entries(divisions)) {
      for (const p of patchProblems(entry.policy ?? {}, aboveDivision)) out.push(`${code}: ${p}`)
    }
    return out
  }, [global, divisions, aboveDivision])

  const save = async () => {
    setError(null)
    setSaving(true)
    try {
      const updated = await saveTrackingAutomation({
        expectedUpdatedAt: settings?.updatedAt ?? '',
        trackingAutomation: { global, divisions },
        defaultCheckCallPlan: plan,
      })
      setSettings(updated)
      toast.success('Tracking automation saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save tracking automation')
    } finally { setSaving(false) }
  }

  const runNow = async () => {
    setError(null)
    setRunning(true)
    try {
      setResult(await runTrackingAutomation({ mode: 'AUTO' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The automation run failed')
    } finally { setRunning(false) }
  }

  return (
    <SettingsCard
      icon={Bot}
      title="Tracking automation"
      description="When BCAT Tracking Assistant may check calls and ask for PODs on its own, who it writes to, when it stays quiet, and what it says."
    >
      {loading ? <Loading /> : (
        <Stack>
          <TmsSegmentedTabs aria-label="Tracking automation sections" tabs={TABS} active={tab} onSelect={(k) => setTab(k as Tab)} />

          {tab === 'defaults' && (
            <>
              <TrackingAutomationEditor scope="GLOBAL" value={global} inherited={DEFAULT_AUTOMATION_POLICY} onChange={setGlobal} />
              <Panel>
                <GroupLabel>Default check-call plan</GroupLabel>
                <CheckCallPlanFields value={plan} onChange={(patch) => setPlan({ ...plan, ...patch })} />
              </Panel>
            </>
          )}
          {tab === 'divisions' && (
            <DivisionsPanel divisions={divisions} onChange={setDivisions} inherited={aboveDivision} globalPlan={plan} />
          )}
          {tab === 'customers' && <CustomersPanel inherited={aboveDivision} />}

          {problems.map((p) => <ErrorText key={p}>{p}</ErrorText>)}
          {error && <ErrorText>{error}</ErrorText>}

          {tab !== 'customers' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <TmsButton variant="primary" size="sm" onClick={save} disabled={saving || problems.length > 0}>
                <Save size={14} /> Save automation
              </TmsButton>
              <TmsButton size="sm" onClick={runNow} disabled={running}>
                <Play size={14} /> Run automation now
              </TmsButton>
            </div>
          )}
          {tab !== 'customers' && (
            <Hint>Run now uses the saved settings, not unsaved edits.</Hint>
          )}
          {BUILD.isDev && (
            <TmsAlert tone="blue" title="Dev environment">
              Nothing is delivered from here. Each message is recorded as not sent in the shipment's thread.
            </TmsAlert>
          )}
          {result && (
            <TmsAlert tone="green" title="Automation run finished">
              <span data-testid="automation-run-result">
                Checked {result.checked}, acted {result.acted}, deferred {result.deferred}, escalated {result.escalated},
                skipped {result.skipped}, errors {result.errors}. POD: checked {result.pod.checked}, requested {result.pod.requested},
                skipped {result.pod.skipped}, deferred {result.pod.deferred}.
              </span>
            </TmsAlert>
          )}
        </Stack>
      )}
    </SettingsCard>
  )
}
