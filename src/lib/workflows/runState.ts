/**
 * Step K — the run state machine.
 *
 * Pure by construction: every function takes a row and returns a new row. No clock, no
 * client, no I/O. The caller supplies `nowIso`, which is what makes a run's trace
 * reproducible and this file testable without mocking time.
 *
 * Two invariants live here and nowhere else:
 *   - steps only ever move forward through the agent's own vocabulary, so a trace can
 *     be read top to bottom and believed;
 *   - COMPLETED is machine progress and `outcome` is human disposition, so finishing a
 *     run never implies anybody approved it.
 */
import { stepsOf } from './agents'
import { redactForPrompt } from './memory'
import type { WorkflowAgentKey, WorkflowOutcome, WorkflowRunStatus, WorkflowStep } from '../../types/tms'

export const MAX_STEPS = 12
export const MAX_ATTEMPTS = 5

/** The slice of a run row the state machine touches. A `WorkflowRunRecord` satisfies it. */
export interface RunStateRow {
  agent: WorkflowAgentKey
  status: WorkflowRunStatus
  outcome?: WorkflowOutcome | null
  steps?: WorkflowStep[] | null
  attempts?: number | null
  currentStep?: string | null
  exceptionOpen?: string | null
  errorCode?: string | null
  error?: string | null
  startedAt?: string | null
  endedAt?: string | null
  durationMs?: number | null
  shipmentId?: string | null
  quoteId?: string | null
  // Who disposed of the run. Written here so apply / dismiss / resolve leave a trail
  // without the caller having to remember to stamp one.
  appliedAt?: string | null
  appliedBy?: string | null
  dismissedAt?: string | null
  dismissedBy?: string | null
  dismissReason?: string | null
  resolvedAt?: string | null
  resolvedBy?: string | null
}

/**
 * The single place a generic row is rebuilt. Spreading `T` yields an anonymous type;
 * the patch only ever sets fields declared on `RunStateRow`, so the result is still a T.
 */
function patched<T extends RunStateRow>(run: T, patch: Partial<RunStateRow>): T {
  return { ...run, ...patch } as T
}

/** Strips credential-shaped tokens and caps at 1 KB — error strings are stored verbatim. */
export function redactError(message: string): string {
  return redactForPrompt(message).slice(0, 1000)
}

function elapsed(from: string | null | undefined, to: string): number | null {
  if (!from) return null
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, end - start)
}

export function beginStep<T extends RunStateRow>(run: T, key: string, nowIso: string): T {
  const vocabulary = stepsOf(run.agent)
  const at = vocabulary.indexOf(key)
  if (at < 0) throw new Error(`${key} is not a step of the ${run.agent} agent`)

  const steps = run.steps ?? []
  if (steps.length >= MAX_STEPS) throw new Error(`A run records at most ${MAX_STEPS} steps`)

  const last = steps.length > 0 ? steps[steps.length - 1] : null
  if (last && vocabulary.indexOf(last.key) >= at) {
    throw new Error(`${key} cannot follow ${last.key}: steps only move forward`)
  }

  const step: WorkflowStep = { key, status: 'RUNNING', startedAt: nowIso }
  return patched(run, {
    steps: [...steps, step],
    currentStep: key,
    status: 'IN_PROGRESS',
    startedAt: run.startedAt ?? nowIso,
  })
}

export function nextStep<T extends RunStateRow>(
  run: T,
  key: string,
  patch: { note?: string; detail?: string; status?: 'DONE' | 'SKIPPED' },
  nowIso: string,
): T {
  const steps = run.steps ?? []
  const at = steps.findIndex((s) => s.key === key && s.status === 'RUNNING')
  if (at < 0) throw new Error(`${key} is not running on this run`)

  const current = steps[at]
  const closed: WorkflowStep = {
    ...current,
    status: patch.status ?? 'DONE',
    endedAt: nowIso,
    ms: elapsed(current.startedAt, nowIso),
    // Notes and details are written from source material, so they go through the same
    // credential filter as everything else that leaves the run.
    note: patch.note === undefined ? (current.note ?? null) : redactError(patch.note),
    detail: patch.detail === undefined ? (current.detail ?? null) : redactError(patch.detail),
  }
  return patched(run, { steps: steps.map((s, i) => (i === at ? closed : s)) })
}

export function finishRun<T extends RunStateRow>(run: T, outcome: WorkflowOutcome, nowIso: string): T {
  return patched(run, {
    status: 'COMPLETED',
    outcome,
    endedAt: nowIso,
    durationMs: elapsed(run.startedAt, nowIso),
    // An unidentified party is the one completed outcome a person still has to clear.
    exceptionOpen: outcome === 'UNKNOWN_PARTY' ? 'OPEN' : null,
  })
}

export function failRun<T extends RunStateRow>(run: T, code: string, message: string, nowIso: string): T {
  const redacted = redactError(message)
  const steps = (run.steps ?? []).map((s) =>
    s.status === 'RUNNING'
      ? { ...s, status: 'FAILED' as const, endedAt: nowIso, ms: elapsed(s.startedAt, nowIso), detail: redacted }
      : s,
  )
  return patched(run, {
    status: 'FAILED',
    steps,
    errorCode: code,
    error: redacted,
    exceptionOpen: 'OPEN',
    endedAt: nowIso,
    durationMs: elapsed(run.startedAt, nowIso),
  })
}

export function retryable(run: RunStateRow): boolean {
  const failed = run.status === 'FAILED' || run.outcome === 'UNKNOWN_PARTY'
  return failed && run.outcome !== 'APPLIED' && (run.attempts ?? 0) < MAX_ATTEMPTS
}

export function applyLink<T extends RunStateRow>(
  run: T,
  link: { shipmentId?: string; quoteId?: string },
  by: string,
  nowIso: string,
): T {
  if (run.outcome === 'APPLIED') throw new Error('This run was already applied')
  if (run.outcome === 'DISMISSED') throw new Error('This run was dismissed')
  return patched(run, {
    outcome: 'APPLIED',
    appliedAt: nowIso,
    appliedBy: by,
    exceptionOpen: null,
    shipmentId: link.shipmentId ?? run.shipmentId ?? null,
    quoteId: link.quoteId ?? run.quoteId ?? null,
  })
}

export function dismiss<T extends RunStateRow>(run: T, reason: string, by: string, nowIso: string): T {
  const text = reason.trim()
  if (!text) throw new Error('A dismiss reason is required')
  // An applied run is settled and a Shipment or Quote points back at it; flipping
  // its outcome would make the two disagree for ever.
  if (run.outcome === 'APPLIED') throw new Error('This run was already applied')
  if (run.outcome === 'DISMISSED') throw new Error('This run was already dismissed')
  // A run still in flight would have its outcome overwritten by the pipeline's
  // next step, leaving the dismissal stamps on a run nobody dismissed.
  if (run.status === 'PENDING' || run.status === 'IN_PROGRESS') {
    throw new Error('This run is still going; wait for it to finish or let the sweep fail it')
  }
  return patched(run, {
    outcome: 'DISMISSED',
    dismissedAt: nowIso,
    dismissedBy: by,
    dismissReason: redactError(text),
    exceptionOpen: null,
  })
}

/** Clears the exception and nothing else: status and outcome record what happened. */
export function resolveException<T extends RunStateRow>(run: T, by: string, nowIso: string): T {
  return patched(run, { exceptionOpen: null, resolvedAt: nowIso, resolvedBy: by })
}

export function durationOf(run: RunStateRow): number | null {
  if (run.startedAt && run.endedAt) return elapsed(run.startedAt, run.endedAt)
  return typeof run.durationMs === 'number' ? run.durationMs : null
}
