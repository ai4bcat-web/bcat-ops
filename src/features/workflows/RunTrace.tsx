/**
 * One run, end to end: what arrived, what the agent did with it, what it proposed, and
 * what a person did about that.
 *
 * The rail is drawn from `stepsOf(run.agent)` rather than from the steps the row
 * happens to carry, so a run that died at step three still shows the three it never
 * reached — "it stopped here" is the whole point of the page. Everything shown is
 * already redacted on the row: `redactError` runs before a message is stored.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge,
  TmsButton,
  TmsCard,
  TmsDialog,
  TmsTextarea,
  statusTone,
} from '@/features/tms/kit'
import { useShipment } from '@/hooks/useShipment'
import { useWorkflowRun } from '@/hooks/useWorkflowRun'
import { dismissWorkflowRun, getIntakePdfUrl, saveWorkflowFeedback } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { AGENTS, stepsOf } from '@/lib/workflows/agents'
import type { TmsTone } from '@/features/tms/kit'
import type { WorkflowRunRecord, WorkflowStep } from '@/types/tms'
import { ProposalCard } from './proposalCards'

const STEP_TONES: Record<WorkflowStep['status'], TmsTone> = {
  DONE: statusTone('DELIVERED'),
  RUNNING: 'blue',
  FAILED: statusTone('CANCELED'),
  SKIPPED: 'gray',
}

const STEP_LABELS: Record<WorkflowStep['status'], string> = {
  DONE: 'done',
  RUNNING: 'running',
  FAILED: 'failed',
  SKIPPED: 'skipped',
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="tms-field-label">{label}</dt>
      <dd>{value && value.trim() ? value : '—'}</dd>
    </div>
  )
}

/** The rail. A step with no record yet is pending: never reached, not skipped. */
function StepsRail({ run }: { run: WorkflowRunRecord }) {
  const recorded = new Map((run.steps ?? []).map((step) => [step.key, step]))
  const failed = (run.steps ?? []).find((step) => step.status === 'FAILED') ?? null

  return (
    <TmsCard title="Steps">
      <ol className="flex flex-wrap items-start gap-4" data-testid="steps-rail">
        {stepsOf(run.agent).map((key) => {
          const step = recorded.get(key)
          return (
            <li key={key} className="min-w-[8rem]">
              <div className="text-xs font-medium">{key.replace(/_/g, ' ').toLowerCase()}</div>
              {step
                ? <TmsBadge tone={STEP_TONES[step.status]}>{STEP_LABELS[step.status]}</TmsBadge>
                : <TmsBadge tone="gray">pending</TmsBadge>}
              <div className="tms-muted text-xs">{step?.ms != null ? `${step.ms} ms` : '—'}</div>
            </li>
          )
        })}
      </ol>
      {failed ? (
        <p className="tms-field-error mt-3 text-sm" data-testid="failed-step-detail">
          {failed.key}: {failed.detail ?? failed.note ?? run.error ?? 'The step failed without a message.'}
        </p>
      ) : null}
    </TmsCard>
  )
}

/** The attachments the run read. The bytes stay in S3; this mints a signed GET. */
function DocumentsCard({ run }: { run: WorkflowRunRecord }) {
  const documents = run.documents ?? []
  if (documents.length === 0) return null
  return (
    <TmsCard title={`Documents (${documents.length})`}>
      <ul className="text-sm">
        {documents.map((doc) => (
          <li key={doc.s3Key} className="flex items-center gap-2 py-1">
            <span>{doc.name}</span>
            <span className="tms-muted text-xs">{doc.contentType} · {Math.round(doc.size / 1024)} KB</span>
            <TmsButton
              size="sm"
              onClick={async () => {
                try {
                  // `workflow-inbox/` is on `getIntakePdfUrl`'s prefix list; the URL is
                  // short-lived, so it is minted on the click rather than on render.
                  window.open(await getIntakePdfUrl(doc.s3Key), '_blank', 'noopener')
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Could not open that document')
                }
              }}
            >
              Open
            </TmsButton>
          </li>
        ))}
      </ul>
    </TmsCard>
  )
}

/**
 * Thumbs and a sentence. This is the only place a person's opinion of a run is
 * recorded; it changes nothing about the run and feeds the instructions a human later
 * writes on the AI Agents settings page.
 */
function FeedbackCard({ run, onChanged }: { run: WorkflowRunRecord; onChanged: () => Promise<void> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const entries = [...(run.feedback ?? [])].slice(-20).reverse()

  const save = async (rating: 'UP' | 'DOWN') => {
    setBusy(true)
    try {
      await saveWorkflowFeedback(run.id, rating, text.trim() || undefined)
      setText('')
      toast.success('Feedback saved')
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save that feedback')
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsCard title="Feedback">
      <TmsTextarea
        aria-label="Feedback"
        rows={2}
        placeholder="What was right or wrong about this run?"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <TmsButton size="sm" disabled={busy} aria-label="Good run" onClick={() => void save('UP')}>
          <ThumbsUp size={14} aria-hidden="true" /> Good
        </TmsButton>
        <TmsButton size="sm" disabled={busy} aria-label="Bad run" onClick={() => void save('DOWN')}>
          <ThumbsDown size={14} aria-hidden="true" /> Bad
        </TmsButton>
      </div>
      <ul className="mt-3 text-sm">
        {entries.map((entry) => (
          <li key={`${entry.at}-${entry.by}`}>
            <strong>{entry.rating === 'UP' ? 'Good' : 'Bad'}</strong> — {entry.by}, {formatDateTime(entry.at)}
            {entry.text ? `: ${entry.text}` : ''}
          </li>
        ))}
        {entries.length === 0 ? <li className="tms-muted">Nobody has graded this run.</li> : null}
      </ul>
    </TmsCard>
  )
}

/**
 * The shipment a person created from this run, read-only.
 *
 * `ShipmentDrawer` is an editor — it owns dialogs, saves and a void button — so it is
 * not forked into a viewer here. The facts a reader needs to recognise the shipment are
 * a card, and the link goes to the real detail for everything else.
 */
function LinkedShipmentCard({ shipmentId }: { shipmentId: string }) {
  const { bundle, loading } = useShipment(shipmentId)
  const shipment = bundle?.shipment
  return (
    <TmsCard
      title="Linked shipment"
      actions={<Link className="tms-btn tms-btn-secondary tms-btn-sm" to={`/tms/shipments/${shipmentId}`}>Open shipment</Link>}
    >
      {loading && !shipment ? <p className="tms-muted">Loading…</p> : (
        <dl className="tms-grid tms-grid-4">
          <Fact label="Number" value={shipment?.number} />
          <Fact label="Status" value={shipment?.status} />
          <Fact label="Customer" value={shipment?.customerName} />
          <Fact label="Created" value={shipment?.createdAt ? formatDateTime(shipment.createdAt) : null} />
        </dl>
      )}
    </TmsCard>
  )
}

export function RunTrace({ runId }: { runId: string }) {
  const { run, loading, error, refresh } = useWorkflowRun(runId)
  const [dismissing, setDismissing] = useState<string | null>(null)

  if (error) return <p className="tms-field-error">{error}</p>
  if (!run) return <p className="tms-muted">{loading ? 'Loading…' : 'That run is not on file.'}</p>

  const descriptor = AGENTS[run.agent]
  const from = [run.fromName, run.fromEmail ? `<${run.fromEmail}>` : null].filter(Boolean).join(' ')
  const duration = run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)} s` : null
  const cost = run.model
    ? `${run.model} · ${run.modelCalls ?? 0} call${run.modelCalls === 1 ? '' : 's'} · ${run.inputTokens ?? 0} in / ${run.outputTokens ?? 0} out`
    : null
  const settled = run.outcome === 'APPLIED' || run.outcome === 'DISMISSED'

  return (
    <div className="flex flex-col gap-4">
      <TmsCard
        title={
          <span className="flex items-center gap-2">
            {descriptor?.label ?? run.agent} run
            {run.status === 'IN_PROGRESS' ? (
              <TmsBadge tone="blue" className="animate-pulse">Live</TmsBadge>
            ) : null}
            {run.outcome ? <TmsBadge tone="purple">{run.outcome.replace(/_/g, ' ').toLowerCase()}</TmsBadge> : null}
          </span>
        }
        actions={settled ? null : (
          <TmsButton size="sm" onClick={() => setDismissing('')}>Dismiss</TmsButton>
        )}
      >
        <dl className="tms-grid tms-grid-4">
          <Fact label="Agent" value={descriptor?.label ?? run.agent} />
          <Fact label="Inbox role" value={run.inboxRole} />
          <Fact label="From" value={from} />
          <Fact label="Subject" value={run.subject} />
          <Fact label="Received" value={run.receivedAt ? formatDateTime(run.receivedAt) : null} />
          <Fact label="Attempts" value={String(run.attempts ?? 0)} />
          <Fact label="Duration" value={duration} />
          <Fact label="Status" value={run.status} />
        </dl>
        {cost ? <p className="tms-muted mt-3 text-xs" data-testid="model-cost">{cost}</p> : null}
        {run.bodyPreview ? <p className="mt-3 text-sm">{run.bodyPreview}</p> : null}
        {run.dismissReason ? (
          <p className="tms-muted mt-3 text-sm">Dismissed by {run.dismissedBy}: {run.dismissReason}</p>
        ) : null}
      </TmsCard>

      <StepsRail run={run} />
      <DocumentsCard run={run} />
      <ProposalCard run={run} onChanged={refresh} />
      {run.shipmentId ? <LinkedShipmentCard shipmentId={run.shipmentId} /> : null}
      <FeedbackCard run={run} onChanged={refresh} />

      <TmsDialog
        open={dismissing !== null}
        onOpenChange={(open) => { if (!open) setDismissing(null) }}
        title="Dismiss this proposal"
        description="The run and its trace stay on file. Dismissing is a decision, not a delete."
        footer={
          <>
            <TmsButton onClick={() => setDismissing(null)}>Cancel</TmsButton>
            <TmsButton
              variant="primary"
              disabled={!dismissing?.trim()}
              onClick={async () => {
                const reason = (dismissing ?? '').trim()
                if (!reason) return
                setDismissing(null)
                try {
                  await dismissWorkflowRun(run.id, reason, run.version ?? 0)
                  toast.success('Proposal dismissed')
                  await refresh()
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Could not dismiss that run')
                }
              }}
            >
              Dismiss
            </TmsButton>
          </>
        }
      >
        <TmsTextarea
          aria-label="Dismissal reason"
          rows={3}
          placeholder="Why is this proposal not wanted?"
          value={dismissing ?? ''}
          onChange={(e) => setDismissing(e.target.value)}
        />
      </TmsDialog>
    </div>
  )
}

export default RunTrace
