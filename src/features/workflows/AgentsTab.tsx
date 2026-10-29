/**
 * The AI Agents tab — what the agents actually did, newest first.
 *
 * Status and outcome are two different questions and are shown as two columns on
 * purpose: COMPLETED says the pipeline finished, and says nothing at all about whether
 * a person wanted the result. Only APPLIED means somebody acted on it.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TmsBadge, TmsListPage, statusTone } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { useWorkflowRuns } from '@/hooks/useWorkflowRuns'
import { formatDateTime } from '@/lib/date'
import { AGENTS, AGENT_KEYS } from '@/lib/workflows/agents'
import type { TmsTone } from '@/features/tms/kit'
import type { WorkflowAgentKey, WorkflowOutcome, WorkflowRunRecord, WorkflowRunStatus } from '@/types/tms'

/** The server caps `LIST_RUNS` at 200; the page says the same number out loud. */
const MAX_ROWS = 200

const STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
}

const OUTCOME_LABELS: Record<WorkflowOutcome, string> = {
  PROPOSED: 'Proposed',
  APPLIED: 'Applied',
  DISMISSED: 'Dismissed',
  NOTED: 'Noted',
  UNKNOWN_PARTY: 'Unknown party',
  IGNORED: 'Ignored',
  NO_ACTION: 'No action',
}

const OUTCOME_TONES: Record<WorkflowOutcome, TmsTone> = {
  PROPOSED: 'purple',
  APPLIED: 'green',
  DISMISSED: 'gray',
  NOTED: 'turquoise',
  UNKNOWN_PARTY: 'orange',
  IGNORED: 'gray',
  NO_ACTION: 'gray',
}

/**
 * PENDING grey, IN_PROGRESS blue, COMPLETED green, FAILED red — the two that share a
 * word with the shipment vocabulary come from `statusTone`, because two colour tables
 * for the same words is how a FAILED badge ends up green on one page.
 */
const STATUS_TONES: Record<WorkflowRunStatus, TmsTone> = {
  PENDING: 'gray',
  IN_PROGRESS: 'blue',
  COMPLETED: statusTone('DELIVERED'),
  FAILED: statusTone('CANCELED'),
}

export function AgentsTab() {
  const navigate = useNavigate()
  const [agent, setAgent] = useState<WorkflowAgentKey | null>(null)
  const { runs, loading, error, refresh } = useWorkflowRuns(agent ?? undefined)

  const rows = runs.slice(0, MAX_ROWS)

  const columns: ColumnDef<WorkflowRunRecord>[] = [
    {
      key: 'agent',
      header: 'AGENT',
      width: 110,
      render: (run) => <TmsBadge tone="purple">{AGENTS[run.agent]?.label ?? run.agent}</TmsBadge>,
    },
    {
      key: 'status',
      header: 'STATUS',
      width: 130,
      render: (run) => (
        <TmsBadge
          tone={STATUS_TONES[run.status]}
          className={run.status === 'IN_PROGRESS' ? 'animate-pulse' : undefined}
        >
          {STATUS_LABELS[run.status]}
        </TmsBadge>
      ),
    },
    {
      key: 'outcome',
      header: 'OUTCOME',
      width: 130,
      render: (run) => (run.outcome
        ? <TmsBadge tone={OUTCOME_TONES[run.outcome]}>{OUTCOME_LABELS[run.outcome]}</TmsBadge>
        : <span className="tms-muted">—</span>),
    },
    {
      key: 'party',
      header: 'PARTY',
      width: 220,
      // A run with candidates and no match is the UNKNOWN_PARTY exception: the count is
      // the only honest thing to print, because none of the candidates is the answer.
      render: (run) => run.partyName
        ?? (run.partyCandidates?.length
          ? `Unknown — ${run.partyCandidates.length} candidate${run.partyCandidates.length === 1 ? '' : 's'}`
          : run.fromEmail ?? '—'),
    },
    {
      key: 'step',
      header: 'STEP/ERROR',
      render: (run) => run.error ?? run.currentStep ?? '—',
    },
    {
      key: 'updated',
      header: 'UPDATED',
      width: 170,
      render: (run) => formatDateTime(run.updatedAt),
    },
  ]

  return (
    <>
      {error ? <p className="tms-field-error">{error}</p> : null}
      <TmsListPage<WorkflowRunRecord>
        embedded
        title="AI Agents"
        columns={columns}
        rows={rows}
        rowKey={(run) => run.id}
        onRowClick={(run) => navigate(`/tms/workflows/runs/${run.id}`)}
        onRefresh={() => void refresh()}
        filterChips={AGENT_KEYS.map((key) => ({
          key,
          label: AGENTS[key].label,
          value: agent === key ? 'only' : null,
          onClick: () => setAgent((prev) => (prev === key ? null : key)),
        }))}
        onClearFilters={agent ? () => setAgent(null) : undefined}
        emptyText={loading
          ? 'Loading…'
          : agent
            ? `The ${AGENTS[agent].label} agent has not run yet. Mail arriving on ${AGENTS[agent].defaultInbox || 'its webhook'} starts one.`
            : 'No agent has run yet. A run starts when mail reaches an agent inbox — nothing here is scheduled.'}
        page={{ from: rows.length ? 1 : 0, to: rows.length, total: rows.length, pageSize: MAX_ROWS }}
      />
    </>
  )
}

export default AgentsTab
