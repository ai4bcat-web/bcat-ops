/**
 * The state machine is what stands between "the agent read an e-mail" and "a person
 * created freight". The cases here are the refusals: a trace that goes backwards, a
 * run that retries forever, and a dismissed run that somebody still tries to apply.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_ATTEMPTS,
  MAX_STEPS,
  applyLink,
  beginStep,
  dismiss,
  durationOf,
  failRun,
  finishRun,
  nextStep,
  redactError,
  resolveException,
  retryable,
  type RunStateRow,
} from './runState'
import type { WorkflowStep } from '../../types/tms'

const T0 = '2026-10-29T14:00:00.000Z'
const T1 = '2026-10-29T14:00:02.000Z'
const T2 = '2026-10-29T14:00:05.000Z'

function row(over: Partial<RunStateRow> = {}): RunStateRow {
  return { agent: 'TENDER', status: 'PENDING', ...over }
}

describe('beginStep / nextStep', () => {
  it('advances through the agent vocabulary and times each step', () => {
    let run = beginStep(row(), 'RECEIVE_EMAIL', T0)
    expect(run.status).toBe('IN_PROGRESS')
    expect(run.currentStep).toBe('RECEIVE_EMAIL')
    expect(run.startedAt).toBe(T0)

    run = nextStep(run, 'RECEIVE_EMAIL', { note: 'read 1 attachment' }, T1)
    run = beginStep(run, 'PARSE_TENDER', T1)
    run = nextStep(run, 'PARSE_TENDER', { status: 'SKIPPED' }, T2)

    expect((run.steps ?? []).map((s) => [s.key, s.status])).toEqual([
      ['RECEIVE_EMAIL', 'DONE'],
      ['PARSE_TENDER', 'SKIPPED'],
    ])
    expect((run.steps ?? [])[0].ms).toBe(2000)
    expect((run.steps ?? [])[0].note).toBe('read 1 attachment')
  })

  it('refuses a step that is not the agent’s', () => {
    expect(() => beginStep(row(), 'PARSE_INVOICE', T0)).toThrow(/not a step/)
  })

  it('refuses a step that goes backwards or repeats', () => {
    const run = beginStep(row(), 'CLASSIFY_EMAIL', T0)
    expect(() => beginStep(run, 'RECEIVE_EMAIL', T1)).toThrow(/forward/)
    expect(() => beginStep(run, 'CLASSIFY_EMAIL', T1)).toThrow(/forward/)
  })

  it('refuses a thirteenth step', () => {
    const steps: WorkflowStep[] = Array.from({ length: MAX_STEPS }, () => ({
      key: 'RECEIVE_EMAIL',
      status: 'DONE',
    }))
    expect(() => beginStep(row({ steps }), 'PROPOSE_TENDER', T1)).toThrow(/12 steps/)
  })

  it('refuses to close a step that is not running', () => {
    expect(() => nextStep(row(), 'RECEIVE_EMAIL', {}, T1)).toThrow(/not running/)
  })
})

describe('failRun and applyLink', () => {
  it('opens the exception on failure and closes it when a person applies the run', () => {
    const started = beginStep(row(), 'RECEIVE_EMAIL', T0)
    const failed = failRun(started, 'MODEL_TIMEOUT', 'the model timed out', T1)

    expect(failed.status).toBe('FAILED')
    expect(failed.exceptionOpen).toBe('OPEN')
    expect((failed.steps ?? [])[0].status).toBe('FAILED')
    expect(failed.durationMs).toBe(2000)

    const applied = applyLink(failed, { shipmentId: 'shp-1' }, 'ryne@bcatcorp.com', T2)
    expect(applied.outcome).toBe('APPLIED')
    expect(applied.exceptionOpen).toBeNull()
    expect(applied.shipmentId).toBe('shp-1')
    expect(applied.appliedBy).toBe('ryne@bcatcorp.com')
  })

  it('refuses to apply a dismissed run', () => {
    const dismissed = dismiss(row({ status: 'COMPLETED', outcome: 'PROPOSED' }), 'duplicate tender', 'ryne@bcatcorp.com', T1)
    expect(dismissed.exceptionOpen).toBeNull()
    expect(() => applyLink(dismissed, { shipmentId: 'shp-1' }, 'ryne@bcatcorp.com', T2)).toThrow(/dismissed/)
  })

  it('refuses to apply the same run twice', () => {
    const applied = applyLink(row({ outcome: 'PROPOSED' }), { quoteId: 'q-1' }, 'ryne@bcatcorp.com', T1)
    expect(() => applyLink(applied, { quoteId: 'q-2' }, 'ryne@bcatcorp.com', T2)).toThrow(/already applied/)
  })

  it('requires a reason to dismiss', () => {
    expect(() => dismiss(row(), '   ', 'ryne@bcatcorp.com', T1)).toThrow(/reason/)
  })

  it('refuses to dismiss a run that is settled or still going', () => {
    // An applied run has a Shipment pointing back at it; dismissing it would make
    // the two disagree about what happened.
    expect(() => dismiss(row({ status: 'COMPLETED', outcome: 'APPLIED' }), 'spam', 'ryne@bcatcorp.com', T1))
      .toThrow(/already applied/)
    expect(() => dismiss(row({ status: 'COMPLETED', outcome: 'DISMISSED' }), 'spam', 'ryne@bcatcorp.com', T1))
      .toThrow(/already dismissed/)
    // A run still in flight would have its outcome written over by the next step.
    expect(() => dismiss(row({ status: 'PENDING' }), 'spam', 'ryne@bcatcorp.com', T1)).toThrow(/still going/)
    expect(() => dismiss(row({ status: 'IN_PROGRESS' }), 'spam', 'ryne@bcatcorp.com', T1)).toThrow(/still going/)
  })
})

describe('finishRun', () => {
  it('opens an exception only for an unidentified party', () => {
    expect(finishRun(row(), 'UNKNOWN_PARTY', T1).exceptionOpen).toBe('OPEN')
    expect(finishRun(row(), 'PROPOSED', T1).exceptionOpen).toBeNull()
    expect(finishRun(row(), 'NO_ACTION', T1).status).toBe('COMPLETED')
  })
})

describe('retryable', () => {
  it('is false once applied and once the attempts are spent', () => {
    expect(retryable(row({ status: 'FAILED', attempts: 1 }))).toBe(true)
    expect(retryable(row({ status: 'COMPLETED', outcome: 'UNKNOWN_PARTY' }))).toBe(true)
    expect(retryable(row({ status: 'FAILED', outcome: 'APPLIED', attempts: 1 }))).toBe(false)
    expect(retryable(row({ status: 'FAILED', attempts: MAX_ATTEMPTS }))).toBe(false)
    expect(retryable(row({ status: 'COMPLETED', outcome: 'PROPOSED' }))).toBe(false)
  })
})

describe('resolveException', () => {
  it('clears the exception and leaves the disposition alone', () => {
    const failed = failRun(row(), 'INTERNAL', 'boom', T1)
    const resolved = resolveException(failed, 'ryne@bcatcorp.com', T2)
    expect(resolved.exceptionOpen).toBeNull()
    expect(resolved.status).toBe('FAILED')
    expect(resolved.errorCode).toBe('INTERNAL')
    expect(resolved.resolvedBy).toBe('ryne@bcatcorp.com')
  })
})

describe('redactError and durationOf', () => {
  it('strips a credential out of an error before it is stored', () => {
    const message = 'POST failed: Authorization: Bearer abcdefghijklmnop1234'
    expect(redactError(message)).not.toContain('abcdefghijklmnop1234')
    expect(redactError(message)).toContain('[redacted]')
    // A long message is capped, not redacted: plain prose has no token-shaped runs.
    expect(redactError('timed out. '.repeat(300)).length).toBe(1000)
  })

  it('measures a run from its own stamps', () => {
    expect(durationOf(row({ startedAt: T0, endedAt: T2 }))).toBe(5000)
    expect(durationOf(row())).toBeNull()
  })
})
