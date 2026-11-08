/**
 * My Brokerage → AI Agents.
 *
 * The agents read what a person wrote here and write nothing back: the org-wide memory,
 * an instructions block and a memory block per agent, the switch that turns an agent off
 * and the cap that bounds a day's model spend. `BrokeragePage` owns the h1, so this is a
 * body with its own inner tab strip and no title row.
 *
 * `MemoryCard` and `PartyAiMemoryTab` are exported from here rather than from a file of
 * their own because the customer and carrier profiles render exactly the same editor:
 * one definition is the only way the revision line on a party card can never disagree
 * with the one on an org card.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  TmsBadge,
  TmsButton,
  TmsCard,
  TmsField,
  TmsInput,
  TmsTable,
  TmsTabs,
  TmsTextarea,
} from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { getTmsSettings, listWorkflowRuns, runWorkflowSample, saveTmsSettings } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { AGENTS } from '@/lib/workflows/agents'
import { DEFAULT_DAILY_RUN_CAP, MEMORY_MAX } from '@/lib/workflows/memory'
import type {
  AgentMemory,
  AgentSettings,
  AiAgentKey,
  AiAgentsSettings,
  PartyAiMemory,
  TmsSettings,
  WorkflowRunRecord,
} from '@/types/tms'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The agents a person configures. WEBHOOK has no inbox and no instructions. */
const AGENT_TABS: readonly AiAgentKey[] = ['QUOTE', 'TENDER', 'AP', 'CAPACITY']

/** The standing fact every card repeats: this text is an input to the model, never an output. */
const READ_ONLY_TO_THE_AGENT = 'The agent reads this and never writes it.'

/**
 * The block sent back to the server on save.
 *
 * `revision` is carried forward untouched on purpose. `validateAiAgents` and
 * `validatePartyMemory` call `bumpMemory`, which raises it only when the markdown
 * actually changed; a number a browser made up would disagree with the one the agent
 * recorded against the run that read the text.
 */
function memoryPatch(prev: AgentMemory | null | undefined, markdown: string): AgentMemory {
  return {
    markdown,
    revision: prev?.revision ?? 0,
    updatedAt: prev?.updatedAt ?? '',
    updatedBy: prev?.updatedBy ?? '',
  }
}

function revisionLine(stored: AgentMemory | null | undefined): string {
  if (!stored || stored.revision < 1) return 'No revision yet — nothing has been saved here.'
  return `Revision ${stored.revision} · edited by ${stored.updatedBy || 'unknown'} · ${formatDateTime(stored.updatedAt)}`
}

export interface MemoryCardProps {
  title: string
  /** Why this block exists, in one line. */
  description: string
  value: string
  /** The saved block, for the revision line. Null before the first save. */
  stored: AgentMemory | null | undefined
  disabled?: boolean
  onChange: (next: string) => void
}

/**
 * One Markdown memory block: what the agent will read, which revision of it is stored
 * and how much of the budget the text uses. Text longer than `MEMORY_MAX` is refused
 * here rather than at the server, because the server's answer would be a lost paste.
 */
export function MemoryCard({ title, description, value, stored, disabled, onChange }: MemoryCardProps) {
  const [refused, setRefused] = useState(false)

  return (
    <TmsCard title={title}>
      <div style={{ display: 'grid', gap: 8 }}>
        <p className="tms-muted" style={{ margin: 0, fontSize: 12 }}>
          {description} {READ_ONLY_TO_THE_AGENT}
        </p>
        <p className="tms-muted" style={{ margin: 0, fontSize: 12 }}>{revisionLine(stored)}</p>
        <TmsTextarea
          aria-label={title}
          rows={10}
          value={value}
          maxLength={MEMORY_MAX}
          disabled={disabled}
          placeholder="Markdown. Headings, bullets and plain sentences all reach the model as written."
          onChange={(e) => {
            const next = e.target.value
            if (next.length > MEMORY_MAX) {
              setRefused(true)
              return
            }
            setRefused(false)
            onChange(next)
          }}
        />
        <p className="tms-muted" style={{ margin: 0, fontSize: 12 }}>
          {value.length.toLocaleString()} / {MEMORY_MAX.toLocaleString()} characters
        </p>
        {refused ? (
          <p className="tms-field-error">
            That text is longer than {MEMORY_MAX.toLocaleString()} characters and was not applied.
          </p>
        ) : null}
      </div>
    </TmsCard>
  )
}

const RUN_COLUMNS: Array<ColumnDef<WorkflowRunRecord>> = [
  {
    key: 'updatedAt',
    header: 'When',
    width: 160,
    render: (run) => <Link to={`/tms/workflows/runs/${run.id}`}>{formatDateTime(run.updatedAt)}</Link>,
  },
  { key: 'agent', header: 'Agent', width: 90, render: (run) => AGENTS[run.agent].label },
  { key: 'status', header: 'Status', width: 110, render: (run) => run.status },
  { key: 'outcome', header: 'Outcome', width: 120, render: (run) => run.outcome ?? '—' },
  { key: 'subject', header: 'Subject', render: (run) => run.subject ?? run.sourceId },
]

export interface PartyAiMemoryTabProps {
  /** The party row's id; runs are matched against it. */
  partyId: string
  /** 'customer' or 'carrier', for the sentences on the cards. */
  partyWord: string
  /** The agents that ever read this party: Quote and Tender, or AP and Capacity. */
  agents: readonly AiAgentKey[]
  memory: PartyAiMemory | null | undefined
  disabled?: boolean
  /** The profile's own save path — `UPSERT_CUSTOMER` / `UPSERT_CARRIER`, nothing new. */
  onSave: (next: PartyAiMemory) => Promise<void>
}

/** The AI Agents tab of a customer or carrier profile: the party's memory and its runs. */
export function PartyAiMemoryTab({ partyId, partyWord, agents, memory, disabled, onSave }: PartyAiMemoryTabProps) {
  const [general, setGeneral] = useState(() => memory?.general?.markdown ?? '')
  const [perAgent, setPerAgent] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {}
    for (const key of agents) seed[key] = memory?.[key]?.markdown ?? ''
    return seed
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [runs, setRuns] = useState<WorkflowRunRecord[]>([])
  const [runsLoading, setRunsLoading] = useState(true)
  const [runsError, setRunsError] = useState<string | null>(null)

  // `WorkflowRun` is indexed by agent, shipment and open exception — there is no party
  // GSI — so the party's runs are picked out of the newest rows those queries return.
  useEffect(() => {
    listWorkflowRuns()
      .then((rows) => {
        setRuns(rows.filter((row) => row.partyId === partyId).slice(0, 50))
        setRunsError(null)
      })
      .catch((err: unknown) => setRunsError(messageOf(err)))
      .finally(() => setRunsLoading(false))
  }, [partyId])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const next: PartyAiMemory = { general: memoryPatch(memory?.general, general) }
      for (const key of agents) next[key] = memoryPatch(memory?.[key], perAgent[key] ?? '')
      await onSave(next)
    } catch (err) {
      setSaveError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <TmsCard
        title="Notes the agents read"
        actions={
          <TmsButton variant="primary" size="sm" onClick={() => void save()} disabled={saving || disabled}>
            {saving ? 'Saving…' : 'Save notes'}
          </TmsButton>
        }
      >
        <p className="tms-muted" style={{ margin: 0, fontSize: 12 }}>
          Everything below is handed to the model with the mail it is reading, so write what a new
          broker would need to be told about this {partyWord}. {READ_ONLY_TO_THE_AGENT}
        </p>
        {saveError ? <p className="tms-field-error">{saveError}</p> : null}
      </TmsCard>

      <MemoryCard
        title="General notes"
        description={`What every agent should know about this ${partyWord}.`}
        value={general}
        stored={memory?.general}
        disabled={disabled}
        onChange={setGeneral}
      />

      {agents.map((key) => (
        <MemoryCard
          key={key}
          title={`${AGENTS[key].label} notes`}
          description={`Read only by the ${AGENTS[key].label} agent.`}
          value={perAgent[key] ?? ''}
          stored={memory?.[key]}
          disabled={disabled}
          onChange={(next) => setPerAgent((current) => ({ ...current, [key]: next }))}
        />
      ))}

      <TmsCard title="Recent runs" flush>
        <TmsTable
          columns={RUN_COLUMNS}
          rows={runs}
          rowKey={(run) => run.id}
          empty={
            <span className="tms-muted">
              {runsError ?? (runsLoading ? 'Loading runs…' : `No agent has run against this ${partyWord} yet.`)}
            </span>
          }
        />
      </TmsCard>
    </div>
  )
}

interface AgentDraft {
  enabled: boolean
  instructions: string
  memory: string
}

type AgentDrafts = Record<AiAgentKey, AgentDraft>

function draftsFrom(stored: AiAgentsSettings | null): AgentDrafts {
  const out = {} as AgentDrafts
  for (const key of AGENT_TABS) {
    out[key] = {
      // Unset means on: an agent nobody configured still runs, exactly as `agentEnabled` reads it.
      enabled: stored?.[key]?.enabled !== false,
      instructions: stored?.[key]?.instructions?.markdown ?? '',
      memory: stored?.[key]?.memory?.markdown ?? '',
    }
  }
  return out
}

/** The one-line disposition of a sample run, for the card that started it. */
function outcomeLine(run: WorkflowRunRecord): string {
  const parts: string[] = [run.status]
  if (run.outcome) parts.push(run.outcome)
  if (run.errorCode) parts.push(run.errorCode)
  if (run.error) parts.push(run.error)
  else if (run.currentStep) parts.push(`last step ${run.currentStep}`)
  if (run.partyName) parts.push(run.partyName)
  return parts.join(' · ')
}

export function AiAgentsPage() {
  const { isOwner, isAdmin } = useAuth()
  const allowed = isOwner || isAdmin

  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [tab, setTab] = useState<string>('general')
  const [general, setGeneral] = useState('')
  const [dailyRunCap, setDailyRunCap] = useState('')
  const [drafts, setDrafts] = useState<AgentDrafts>(() => draftsFrom(null))

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [sampleFrom, setSampleFrom] = useState('')
  const [sampleSubject, setSampleSubject] = useState('')
  const [sampleBody, setSampleBody] = useState('')
  const [sampleBusy, setSampleBusy] = useState(false)
  const [sampleError, setSampleError] = useState<string | null>(null)
  const [sampleRun, setSampleRun] = useState<WorkflowRunRecord | null>(null)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain.
  const load = useCallback(
    () =>
      getTmsSettings()
        .then((next) => {
          setSettings(next)
          setGeneral(next?.aiAgents?.general?.markdown ?? '')
          setDailyRunCap(next?.aiAgents?.dailyRunCap != null ? String(next.aiAgents.dailyRunCap) : '')
          setDrafts(draftsFrom(next?.aiAgents ?? null))
          setLoadError(null)
        })
        .catch((err: unknown) => setLoadError(messageOf(err)))
        .finally(() => setLoading(false)),
    [],
  )

  useEffect(() => {
    if (allowed) void load()
  }, [allowed, load])

  if (!allowed) {
    return (
      <div className="tms-page">
        <TmsCard>
          <p className="tms-muted">
            The agents are configured by the owner and the ADMIN group. Ask one of them for a change.
          </p>
        </TmsCard>
      </div>
    )
  }

  const stored = settings?.aiAgents ?? null
  const patchAgent = (key: AiAgentKey, patch: Partial<AgentDraft>) => {
    setDrafts((current) => ({ ...current, [key]: { ...current[key], ...patch } }))
  }

  const save = async () => {
    setSaveError(null)
    setSaved(false)

    let cap: number | null
    const typed = dailyRunCap.trim()
    if (typed === '') cap = null
    else {
      const parsed = Number(typed)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
        setSaveError('The daily run cap must be a whole number between 1 and 10,000.')
        return
      }
      cap = parsed
    }

    const patch: AiAgentsSettings = {
      general: memoryPatch(stored?.general, general),
      dailyRunCap: cap,
    }
    for (const key of AGENT_TABS) {
      const next: AgentSettings = {
        enabled: drafts[key].enabled,
        // `inbox` is deliberately absent: the address is read-only on this page, and
        // leaving the key out is what makes the validator carry the stored one forward.
      }
      /*
       * The same rule applies to the two revisioned blocks, and here it is load-bearing:
       * the agent stamps each revision on the runs that read it, so a block this page
       * did not touch must not appear in the patch at all. Comparison is on the trimmed
       * text because that is the form `bumpMemory` stores.
       */
      if (drafts[key].instructions.trim() !== (stored?.[key]?.instructions?.markdown ?? '').trim()) {
        next.instructions = memoryPatch(stored?.[key]?.instructions, drafts[key].instructions)
      }
      if (drafts[key].memory.trim() !== (stored?.[key]?.memory?.markdown ?? '').trim()) {
        next.memory = memoryPatch(stored?.[key]?.memory, drafts[key].memory)
      }
      patch[key] = next
    }

    setSaving(true)
    try {
      await saveTmsSettings({ aiAgents: patch }, settings?.updatedAt ?? undefined)
      // Re-read rather than trust the echo: the revision on every card below is the one
      // `validateAiAgents` stamped, not one this page guessed.
      await load()
      setSaved(true)
    } catch (err) {
      setSaveError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  const runSample = async (agent: AiAgentKey) => {
    setSampleBusy(true)
    setSampleError(null)
    setSampleRun(null)
    try {
      setSampleRun(
        await runWorkflowSample({
          agent,
          subject: sampleSubject,
          body: sampleBody,
          fromEmail: sampleFrom,
        }),
      )
    } catch (err) {
      setSampleError(messageOf(err))
    } finally {
      setSampleBusy(false)
    }
  }

  const tabs = [
    { key: 'general', label: 'General' },
    ...AGENT_TABS.map((key) => ({ key: key.toLowerCase(), label: AGENTS[key].label })),
  ]
  const agentKey = AGENT_TABS.find((key) => key.toLowerCase() === tab) ?? null

  return (
    <div className="tms-page">
      {loadError ? <p className="tms-field-error">{loadError}</p> : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <TmsTabs tabs={tabs} active={tab} onSelect={setTab} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {saved ? <span className="tms-muted" style={{ fontSize: 12 }}>Saved</span> : null}
          <TmsButton variant="primary" onClick={() => void save()} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </TmsButton>
        </div>
      </div>

      {saveError ? <p className="tms-field-error">{saveError}</p> : null}

      {tab === 'general' ? (
        <div style={{ display: 'grid', gap: 16 }}>
          <MemoryCard
            title="Organization memory"
            description="House rules every agent reads, whatever the mail is about."
            value={general}
            stored={stored?.general}
            onChange={setGeneral}
          />

          <TmsCard title="Daily run cap">
            <div style={{ display: 'grid', gap: 8, maxWidth: 320 }}>
              <TmsField
                label="Runs per day"
                hint={`Blank uses the house default of ${DEFAULT_DAILY_RUN_CAP}. At the cap a run still records itself and stops before the model is called.`}
              >
                <TmsInput
                  aria-label="Daily run cap"
                  inputMode="numeric"
                  value={dailyRunCap}
                  placeholder={String(DEFAULT_DAILY_RUN_CAP)}
                  onChange={(e) => setDailyRunCap(e.target.value)}
                />
              </TmsField>
            </div>
          </TmsCard>
        </div>
      ) : null}

      {agentKey ? (
        <div style={{ display: 'grid', gap: 16 }}>
          <TmsCard
            title={`${AGENTS[agentKey].label} agent`}
            actions={
              <TmsBadge tone={drafts[agentKey].enabled ? 'green' : 'gray'}>
                {drafts[agentKey].enabled ? 'On' : 'Off'}
              </TmsBadge>
            }
          >
            <div style={{ display: 'grid', gap: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  className="tms-check"
                  aria-label={`${AGENTS[agentKey].label} agent enabled`}
                  checked={drafts[agentKey].enabled}
                  onChange={(e) => patchAgent(agentKey, { enabled: e.target.checked })}
                />
                <span>Read this inbox and propose</span>
              </label>
              <p className="tms-muted" style={{ margin: 0, fontSize: 12 }}>
                Off means a run still records itself and ends with no action and no model call, so
                the mail that arrived while the agent was off is still in the trace.
              </p>

              <TmsField
                label="Inbox address"
                hint="A Google Group the Apps Script bridge polls. Creating one, or pointing it somewhere else, is a human step in Google Workspace — this page only shows which address the bridge is expected to read."
              >
                <TmsInput
                  aria-label={`${AGENTS[agentKey].label} inbox address`}
                  readOnly
                  value={stored?.[agentKey]?.inbox || AGENTS[agentKey].defaultInbox}
                />
              </TmsField>
            </div>
          </TmsCard>

          {/* Two blocks, two revisions: the standing rules the agent is told to follow, and
              what the desk has learnt about this kind of mail. Each is an `AgentMemory` of
              its own, so an edit to one leaves the other's revision — and the runs that
              cite it — alone. */}
          <MemoryCard
            title={`${AGENTS[agentKey].label} instructions`}
            description="How this agent should read its mail: what to look for, what to ignore, what a confident answer looks like."
            value={drafts[agentKey].instructions}
            stored={stored?.[agentKey]?.instructions}
            onChange={(next) => patchAgent(agentKey, { instructions: next })}
          />

          <MemoryCard
            title={`${AGENTS[agentKey].label} memory`}
            description="What this desk has learnt about this kind of mail: the senders, the habits and the exceptions worth remembering."
            value={drafts[agentKey].memory}
            stored={stored?.[agentKey]?.memory}
            onChange={(next) => patchAgent(agentKey, { memory: next })}
          />

          <TmsCard title="Try it">
            <div style={{ display: 'grid', gap: 12 }}>
              <p className="tms-muted" style={{ margin: 0, fontSize: 12 }}>
                This is a real run of the {AGENTS[agentKey].label} agent against the real model. It
                reads the memory above, writes a run row, counts against the daily cap — and sends
                nothing to anybody.
              </p>
              <div className="tms-grid tms-grid-2">
                <TmsField label="From">
                  <TmsInput
                    aria-label="Sample from address"
                    value={sampleFrom}
                    placeholder="dispatch@customer.test"
                    onChange={(e) => setSampleFrom(e.target.value)}
                  />
                </TmsField>
                <TmsField label="Subject">
                  <TmsInput
                    aria-label="Sample subject"
                    value={sampleSubject}
                    onChange={(e) => setSampleSubject(e.target.value)}
                  />
                </TmsField>
              </div>
              <TmsField label="Body">
                <TmsTextarea
                  aria-label="Sample body"
                  rows={6}
                  value={sampleBody}
                  onChange={(e) => setSampleBody(e.target.value)}
                />
              </TmsField>
              <div>
                <TmsButton onClick={() => void runSample(agentKey)} disabled={sampleBusy}>
                  {sampleBusy ? 'Running…' : 'Run sample'}
                </TmsButton>
              </div>
              {sampleError ? <p className="tms-field-error">{sampleError}</p> : null}
              {sampleRun ? (
                <p style={{ margin: 0 }}>
                  <Link to={`/tms/workflows/runs/${sampleRun.id}`}>{sampleRun.id}</Link>
                  <span className="tms-muted"> — {outcomeLine(sampleRun)}</span>
                </p>
              ) : null}
            </div>
          </TmsCard>
        </div>
      ) : null}
    </div>
  )
}

export default AiAgentsPage
