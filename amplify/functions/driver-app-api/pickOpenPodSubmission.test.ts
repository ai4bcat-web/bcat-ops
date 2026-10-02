/**
 * More pages for a shipment a driver has already sent a POD for.
 *
 * A driver photographs a bill of lading at the dock, then finds a second page in the cab or
 * a signature they missed. Every send used to create a NEW submission, so the office saw two
 * half-PODs for one shipment and the app showed whichever it found first — and the merged
 * PDF, which is what actually goes to the broker, only ever held half the document.
 */
import { describe, it, expect, vi } from 'vitest'

/*
 * The handler builds a Cognito verifier at import time, so the pool has to exist before the
 * module is loaded. None of it is exercised here — this is a pure rule.
 */
vi.hoisted(() => {
  process.env.DRIVER_USER_POOL_ID = 'us-east-1_testpool'
  process.env.DRIVER_USER_POOL_CLIENT_ID = 'test-client-id'
  process.env.DRIVER_SUBMISSION_TABLE_NAME = 'DriverSubmission-test'
  process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME = 'DriverSubmissionDoc-test'
  process.env.BUCKET_NAME = 'bcat-docs-test'
})

// Static import: vitest hoists the env block above it, which is the whole reason it is a
// vi.hoisted call rather than an ordinary statement.
import { pickOpenPodSubmission } from './handler'

const sub = (referenceNumber: string | null, createdAt = '2026-10-01T10:00:00Z') => ({
  referenceNumber,
  createdAt,
})

describe('pickOpenPodSubmission', () => {
  it('finds the submission for the same shipment', () => {
    expect(pickOpenPodSubmission([sub('14559')], '14559')).toEqual(sub('14559'))
  })

  it('matches however the driver typed the PRO', () => {
    // The same rule the office matches on, so a page added from the phone lands on the
    // submission staff are already looking at.
    expect(pickOpenPodSubmission([sub('PRO #14559')], ' 14559 ')).not.toBeNull()
  })

  it('never puts pages on another shipment', () => {
    expect(pickOpenPodSubmission([sub('14560'), sub('99999')], '14559')).toBeNull()
  })

  it('starts a new one when the driver gave no load number', () => {
    /*
     * A loose POD belongs to whatever load staff assign it to, not to the last shipment
     * this driver happened to send. Guessing would attach a document to the wrong load.
     */
    expect(pickOpenPodSubmission([sub('14559')], null)).toBeNull()
    expect(pickOpenPodSubmission([sub('14559')], '  ')).toBeNull()
  })

  it('ignores a submission that itself has no reference', () => {
    expect(pickOpenPodSubmission([sub(null), sub('')], '14559')).toBeNull()
  })

  it('takes the newest when a driver somehow has two for one PRO', () => {
    // Pages go on the one they are actually working; staff can merge the older.
    const older = sub('14559', '2026-09-30T08:00:00Z')
    const newer = sub('14559', '2026-10-02T16:00:00Z')
    expect(pickOpenPodSubmission([older, newer], '14559')).toEqual(newer)
  })

  it('handles an empty history', () => {
    expect(pickOpenPodSubmission([], '14559')).toBeNull()
  })
})
