/**
 * Removing and replacing a POD or rate confirmation.
 *
 * Two things here can go quietly wrong and both end with the wrong document counting as
 * the right one:
 *
 *  - The combined PDF pointer surviving a removal. Every readiness check in the system
 *    reads that pointer, so a submission with no pages and a live combinedPodKey still
 *    says "POD on file" and still lets an invoice go to OTR with nothing attached.
 *  - A replace that uploads before it removes, which merges the old pages and the new
 *    ones into one document — the exact opposite of replacing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const graphql = vi.hoisted(() => vi.fn())
const uploadData = vi.hoisted(() => vi.fn())
const enhanceDriverDoc = vi.hoisted(() => vi.fn())
const finalizeDriverDocs = vi.hoisted(() => vi.fn())
const queueDriverDocScan = vi.hoisted(() => vi.fn())

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql }) }))
vi.mock('aws-amplify/storage', () => ({
  uploadData: (...a: unknown[]) => { uploadData(...a); return { result: Promise.resolve() } },
  getUrl: vi.fn(),
}))
vi.mock('./podsClient', () => ({ enhanceDriverDoc, finalizeDriverDocs, queueDriverDocScan }))

const { removeDriverDocs, replaceDriverDocs } = await import('./driverSubmissionsClient')

/** Every call the component made, in order, as `operationName`. */
function opsInOrder(): string[] {
  return graphql.mock.calls.map(([arg]) => {
    const q = String((arg as { query: string }).query)
    return /mutation (\w+)|query (\w+)/.exec(q)?.slice(1).find(Boolean) ?? '?'
  })
}

function listReturns(docs: Array<{ id: string; kind: string }>) {
  graphql.mockImplementation(async (arg: unknown) => {
    const q = String((arg as { query: string }).query)
    if (q.includes('ListDriverSubmissions')) {
      return {
        data: {
          listDriverSubmissions: {
            items: [{ id: 'sub-1', driverId: 'drv-1', driverName: 'Lee Lara', createdAt: 'x' }],
            nextToken: null,
          },
        },
      }
    }
    if (q.includes('ListDriverSubmissionDocs')) {
      return {
        data: {
          listDriverSubmissionDocs: {
            items: docs.map((d) => ({ ...d, submissionId: 'sub-1', driverId: 'drv-1', s3Key: `k/${d.id}`, uploadedAt: 'x' })),
            nextToken: null,
          },
        },
      }
    }
    if (q.includes('CreateDriverSubmissionDoc')) {
      return { data: { createDriverSubmissionDoc: { id: 'new-doc', submissionId: 'sub-1' } } }
    }
    return { data: {} }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  enhanceDriverDoc.mockResolvedValue(undefined)
  finalizeDriverDocs.mockResolvedValue(undefined)
  queueDriverDocScan.mockResolvedValue(undefined)
})

describe('removeDriverDocs', () => {
  it('deletes only the pages of that kind, and clears the combined pointer', async () => {
    listReturns([{ id: 'p1', kind: 'POD' }, { id: 'p2', kind: 'POD' }, { id: 'r1', kind: 'RATECON' }])
    await removeDriverDocs('sub-1', 'POD')

    const deletes = graphql.mock.calls.filter(([a]) =>
      String((a as { query: string }).query).includes('DeleteDriverSubmissionDoc'),
    )
    expect(deletes).toHaveLength(2)
    expect(deletes.map(([a]) => (a as { variables: { input: { id: string } } }).variables.input.id))
      .toEqual(['p1', 'p2'])

    const update = graphql.mock.calls.find(([a]) =>
      String((a as { query: string }).query).includes('UpdateDriverSubmission'),
    )
    // null, not merely absent: the pointer has to be unset, or the POD still reads present.
    expect((update![0] as { variables: { input: Record<string, unknown> } }).variables.input)
      .toMatchObject({ id: 'sub-1', combinedPodKey: null })
  })

  it('leaves the other kind’s combined pointer alone', async () => {
    listReturns([{ id: 'r1', kind: 'RATECON' }])
    await removeDriverDocs('sub-1', 'RATECON')
    const update = graphql.mock.calls.find(([a]) =>
      String((a as { query: string }).query).includes('UpdateDriverSubmission'),
    )
    const input = (update![0] as { variables: { input: Record<string, unknown> } }).variables.input
    expect(input).toMatchObject({ combinedRateconKey: null })
    expect(input).not.toHaveProperty('combinedPodKey')
  })

  it('refuses a submission that is gone rather than silently doing nothing', async () => {
    graphql.mockResolvedValue({ data: { listDriverSubmissions: { items: [], nextToken: null } } })
    await expect(removeDriverDocs('sub-gone', 'POD')).rejects.toThrow(/no longer exists/)
  })
})

describe('replaceDriverDocs', () => {
  it('removes the old pages before the new ones are uploaded', async () => {
    listReturns([{ id: 'p1', kind: 'POD' }])
    await replaceDriverDocs({
      submissionId: 'sub-1',
      driver: { id: 'drv-1', name: 'Lee Lara', email: null },
      kind: 'POD',
      files: [new File(['x'], 'new.jpg', { type: 'image/jpeg' })],
      submittedByEmail: 'ryne@bcatcorp.com',
    })

    const ops = opsInOrder()
    const deleted = ops.indexOf('DeleteDriverSubmissionDoc')
    const created = ops.indexOf('CreateDriverSubmissionDoc')
    expect(deleted).toBeGreaterThanOrEqual(0)
    expect(created).toBeGreaterThan(deleted)
  })

  it('queues the cleanup for the new page rather than waiting on it', async () => {
    listReturns([{ id: 'p1', kind: 'POD' }])
    await replaceDriverDocs({
      submissionId: 'sub-1',
      driver: { id: 'drv-1', name: 'Lee Lara', email: null },
      kind: 'POD',
      files: [new File(['x'], 'new.jpg', { type: 'image/jpeg' })],
      submittedByEmail: 'ryne@bcatcorp.com',
    })
    expect(queueDriverDocScan).toHaveBeenCalledWith('sub-1', 'POD')
  })

  it('rejects a file type the pipeline cannot take, before anything is removed', async () => {
    listReturns([{ id: 'p1', kind: 'POD' }])
    await expect(
      replaceDriverDocs({
        submissionId: 'sub-1',
        driver: { id: 'drv-1', name: 'Lee Lara', email: null },
        kind: 'POD',
        files: [new File(['x'], 'notes.txt', { type: 'text/plain' })],
        submittedByEmail: 'ryne@bcatcorp.com',
      }),
    ).rejects.toThrow()
    expect(opsInOrder()).not.toContain('DeleteDriverSubmissionDoc')
  })
})
