/**
 * Handing the cleanup off instead of making an upload wait for it.
 *
 * Cleaning a page is OCR plus image work and the merge waits on all of them, so running it
 * inside the upload meant a driver stood at a dock watching a spinner for the length of the
 * whole pipeline, having already done their part. The upload now returns as soon as the
 * pages are stored and this runs on its own invocation.
 *
 * Two things have to survive the move. The clean-then-merge ORDER, which used to be the
 * browser's job and is now this module's — merging first hands the cleanup a PDF, which is
 * what left every upload reporting ORIGINAL_ONLY. And the rule that none of this can ever
 * surface as a failed upload: the pages are stored and the originals stand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = send },
  InvokeCommand: class { constructor(public input: unknown) {} },
}))

/*
 * The module reads its table names at import time, so this has to be set before the
 * dynamic import below — without it scanDriverDocsAction returns immediately, which is the
 * correct behaviour for an unconfigured stack and a silently passing test here.
 */
vi.hoisted(() => {
  process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME = 'DriverSubmissionDoc-test'
})

/*
 * The real cleanup drags tesseract and jimp in with it. These tests are about sequencing,
 * so the steps are injected (see scanDriverDocsAction) and the heavy module is stubbed.
 */
vi.mock('./scan', () => ({ enhancePodImage: vi.fn(), POD_SCAN_VERSION: 6 }))

describe('queueDriverDocScanAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    send.mockResolvedValue({})
  })

  it('queues one asynchronous invocation and returns straight away', async () => {
    const { queueDriverDocScanAction } = await import('./handler')
    const out = await queueDriverDocScanAction({ submissionId: 'sub-1', kind: 'POD' })

    expect(out).toMatchObject({ queued: true, submissionId: 'sub-1', kind: 'POD' })
    expect(send).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(
      Buffer.from((send.mock.calls[0][0] as { input: { Payload: Uint8Array } }).input.Payload).toString(),
    )
    expect(payload).toEqual({ action: 'scanDriverDocs', submissionId: 'sub-1', kind: 'POD' })
    // Event, not RequestResponse — the whole point is that nobody waits.
    expect((send.mock.calls[0][0] as { input: { InvocationType: string } }).input.InvocationType)
      .toBe('Event')
  })

  it('refuses a kind that is not one of the two documents', async () => {
    const { queueDriverDocScanAction } = await import('./handler')
    const out = await queueDriverDocScanAction({ submissionId: 'sub-1', kind: 'INVOICE' })
    expect(out.queued).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('reports a failure to queue rather than throwing it at the uploader', async () => {
    // A cleanup that could not be queued is a document that stays as it arrived — which is
    // exactly what used to happen to every PDF. It is never a failed upload.
    send.mockRejectedValue(new Error('throttled'))
    const { queueDriverDocScanAction } = await import('./handler')
    const out = await queueDriverDocScanAction({ submissionId: 'sub-1', kind: 'POD' })
    expect(out).toMatchObject({ queued: false, error: 'throttled' })
  })
})

describe('the queued scan itself', () => {
  const docs = [
    { id: 'p1', submissionId: 'sub-1', kind: 'POD' },
    { id: 'p2', submissionId: 'sub-1', kind: 'POD' },
    { id: 'r1', submissionId: 'sub-1', kind: 'RATECON' },
    { id: 'x9', submissionId: 'sub-2', kind: 'POD' },
  ]

  function steps() {
    const order: string[] = []
    return {
      order,
      listDocs: vi.fn(async () => docs),
      clean: vi.fn(async (i: Record<string, unknown>) => { order.push(`clean:${String(i.id)}`) }),
      merge: vi.fn(async () => { order.push('merge') }),
    }
  }

  beforeEach(() => vi.clearAllMocks())

  it('cleans every page before it merges them', async () => {
    // The order IS the contract. Merging first hands the cleanup a PDF, which it correctly
    // reports as having nothing to clean — that is what left every upload unenhanced.
    const { scanDriverDocsAction } = await import('./handler')
    const s = steps()
    await scanDriverDocsAction('sub-1', 'POD', s)
    expect(s.order).toEqual(['clean:p1', 'clean:p2', 'merge'])
  })

  it('touches only the pages of this submission and this kind', async () => {
    const { scanDriverDocsAction } = await import('./handler')
    const s = steps()
    await scanDriverDocsAction('sub-1', 'RATECON', s)
    expect(s.order).toEqual(['clean:r1', 'merge'])
  })

  it('does nothing at all when the submission has no pages of that kind', async () => {
    // Not an empty merge: a merge with nothing behind it would clear the combined pointer
    // and make a document that exists look like one that does not.
    const { scanDriverDocsAction } = await import('./handler')
    const s = steps()
    await scanDriverDocsAction('sub-404', 'POD', s)
    expect(s.merge).not.toHaveBeenCalled()
  })

  it('swallows a failure, because nobody is waiting and the originals stand', async () => {
    const { scanDriverDocsAction } = await import('./handler')
    const s = steps()
    s.clean.mockRejectedValue(new Error('tesseract fell over'))
    await expect(scanDriverDocsAction('sub-1', 'POD', s)).resolves.toBeUndefined()
    expect(s.merge).not.toHaveBeenCalled()
  })
})

/**
 * Not cleaning the same page twice.
 *
 * A driver adding a third page to a POD they started this morning re-queues the whole
 * submission, because the merge has to see every page. Without this the two already-clean
 * pages go through OCR again — seconds each, for a result byte-identical to the one in S3.
 */
describe('scanIsCurrent', () => {
  it('skips a page already cleaned under the current rules', async () => {
    const { scanIsCurrent } = await import('./handler')
    expect(scanIsCurrent({ scanStatus: 'READY', scanVersion: 6 })).toBe(true)
  })

  it('skips one there was nothing to clean on, which is also a settled answer', async () => {
    const { scanIsCurrent } = await import('./handler')
    expect(scanIsCurrent({ scanStatus: 'ORIGINAL_ONLY', scanVersion: 6 })).toBe(true)
  })

  it('redoes a page cleaned by older rules', async () => {
    // This is what the backfill relies on: bump the version, everything below it is
    // eligible again.
    const { scanIsCurrent } = await import('./handler')
    expect(scanIsCurrent({ scanStatus: 'READY', scanVersion: 5 })).toBe(false)
  })

  it('does not treat waiting or failing as done', async () => {
    const { scanIsCurrent } = await import('./handler')
    expect(scanIsCurrent({ scanStatus: 'PENDING', scanVersion: 6 })).toBe(false)
    expect(scanIsCurrent({ scanStatus: 'FAILED', scanVersion: 6 })).toBe(false)
  })

  it('does not treat a page with no record of a scan as done', async () => {
    const { scanIsCurrent } = await import('./handler')
    expect(scanIsCurrent({})).toBe(false)
    expect(scanIsCurrent({ scanStatus: 'READY' })).toBe(false)
  })
})
