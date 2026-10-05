// @vitest-environment node
/**
 * OTR should receive the cleaned POD, not the dock photo.
 *
 * Every POD is deskewed, cropped and contrast-corrected by pod-actions after upload, and a
 * cleaned copy is written beside the original. Two separate faults meant OTR almost never
 * saw it: the submission lookup did not return `enhancedKey` at all, so the send always
 * fell through to the raw page; and even once it did, a submit pressed while the scan was
 * still PENDING had nothing to fall back to but that same raw page.
 *
 * These drive the handler's real DynamoDB and Lambda calls through stubs, because what is
 * worth pinning is which copy it picks and when it is willing to wait for a better one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { LambdaClient } from '@aws-sdk/client-lambda'

const POD_TABLE = 'PodDocument-test'
const SUB_TABLE = 'DriverSubmission-test'
const DOC_TABLE = 'DriverSubmissionDoc-test'
const POD_FN = 'pod-actions-test'

let tables: Record<string, Record<string, unknown>[]>
let invokes: Record<string, unknown>[]

async function loadHandler() {
  process.env.POD_DOCUMENT_TABLE_NAME = POD_TABLE
  process.env.DRIVER_SUBMISSION_TABLE_NAME = SUB_TABLE
  process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME = DOC_TABLE
  process.env.FACTORING_ITEM_TABLE_NAME = 'FactoringItem-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.CUSTOMER_TABLE_NAME = 'Customer-test'
  process.env.OTR_BASE_URL = 'https://example.invalid'
  process.env.POD_FUNCTION_NAME = POD_FN
  vi.resetModules()
  const mod = await import('./handler')
  return mod as unknown as {
    __testFindPod: (loadId: string, pro?: string) => Promise<Record<string, unknown> | null>
    __testEnhancedPodForSend: (
      pod: Record<string, unknown> | null,
      loadId: string,
      pro: string,
    ) => Promise<Record<string, unknown> | null>
  }
}

/** The POD as it reaches the send: whatever findPod resolves, then the enhance step. */
async function podForSend(loadId = 'load-1', pro = '14547') {
  const h = await loadHandler()
  return h.__testEnhancedPodForSend(await h.__testFindPod(loadId, pro), loadId, pro)
}

beforeEach(() => {
  vi.useFakeTimers()
  tables = { [POD_TABLE]: [], [SUB_TABLE]: [], [DOC_TABLE]: [] }
  invokes = []
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof ScanCommand)) return {}
    const rows = tables[cmd.input.TableName as string] ?? []
    const wanted = cmd.input.ExpressionAttributeValues?.[':l']
    const items =
      cmd.input.FilterExpression === 'loadId = :l' ? rows.filter((r) => r.loadId === wanted) : rows
    return { Items: items }
  })
  vi.spyOn(LambdaClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
    const input = (cmd as { input: Record<string, unknown> }).input
    invokes.push(JSON.parse(String(input.Payload)))
    return {}
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A driver submission carrying one POD page in the given scan state. */
function submitPod(scanStatus: string | undefined, enhancedKey: string | null) {
  tables[SUB_TABLE].push({ id: 'sub-1', loadId: 'load-1', referenceNumber: '14547' })
  tables[DOC_TABLE].push({
    id: 'doc-1',
    submissionId: 'sub-1',
    kind: 'POD',
    s3Key: 'driver-docs/sub-1/page-1.jpg',
    contentType: 'image/jpeg',
    uploadedAt: '2026-10-01T10:00:00Z',
    ...(scanStatus ? { scanStatus } : {}),
    ...(enhancedKey ? { enhancedKey } : {}),
  })
}

describe('the POD that reaches OTR', () => {
  it('is exported for testing', async () => {
    // Guards the seam; a rename would otherwise silently skip every test below.
    const h = await loadHandler()
    expect(typeof h.__testEnhancedPodForSend).toBe('function')
  })

  it('is the cleaned copy when the scan has finished', async () => {
    // The original bug: enhancedKey was never returned, so this sent page-1.jpg.
    submitPod('READY', 'driver-docs/sub-1/page-1-enhanced.jpg')
    const pod = await podForSend()
    expect(pod?.enhancedKey).toBe('driver-docs/sub-1/page-1-enhanced.jpg')
    expect(invokes).toEqual([])
  })

  it('is not the cleaned copy while the scan is still running', async () => {
    // READY is the only state in which enhancedKey describes a finished page.
    submitPod('PENDING', 'driver-docs/sub-1/half-written.jpg')
    const h = await loadHandler()
    expect((await h.__testFindPod('load-1', '14547'))?.enhancedKey).toBeNull()
  })

  it('asks for the scan, then sends the cleaned copy it produces', async () => {
    submitPod('PENDING', null)
    const pending = podForSend()

    // The scan lands while the submit is waiting on it.
    await vi.advanceTimersByTimeAsync(100)
    expect(invokes).toEqual([{ action: 'scanDriverDocs', submissionId: 'sub-1', kind: 'POD' }])
    tables[DOC_TABLE][0].scanStatus = 'READY'
    tables[DOC_TABLE][0].enhancedKey = 'driver-docs/sub-1/page-1-enhanced.jpg'

    await vi.advanceTimersByTimeAsync(2_000)
    expect((await pending)?.enhancedKey).toBe('driver-docs/sub-1/page-1-enhanced.jpg')
  })

  it('prefers the merged PDF when the scan combines several pages', async () => {
    submitPod('PENDING', null)
    const pending = podForSend()
    await vi.advanceTimersByTimeAsync(100)

    // A multi-page POD is cleaned and then merged onto the submission, not the page row.
    tables[SUB_TABLE][0].combinedPodKey = 'driver-docs/sub-1/pod.pdf'
    tables[SUB_TABLE][0].combinedAt = '2026-10-01T10:05:00Z'

    await vi.advanceTimersByTimeAsync(2_000)
    const pod = await pending
    expect(pod?.originalKey).toBe('driver-docs/sub-1/pod.pdf')
    expect(pod?.contentType).toBe('application/pdf')
  })

  it('sends the original when the scanner has already found nothing to extract', async () => {
    // ORIGINAL_ONLY is a finished verdict. Re-running the scan would spend the whole wait
    // to arrive at the same answer, and the submit would be that much slower for nothing.
    submitPod('ORIGINAL_ONLY', null)
    const pod = await podForSend()
    expect(pod?.originalKey).toBe('driver-docs/sub-1/page-1.jpg')
    expect(invokes).toEqual([])
  })

  it('sends the original rather than losing the submit when the scan never finishes', async () => {
    // By this point the invoice exists at OTR. Waiting past our own timeout would throw
    // away an invoice we just created, so a slow scan costs quality, not the submit.
    submitPod('PENDING', null)
    const pending = podForSend()
    await vi.advanceTimersByTimeAsync(60_000)
    const pod = await pending
    expect(pod?.originalKey).toBe('driver-docs/sub-1/page-1.jpg')
    expect(pod?.enhancedKey).toBeNull()
  })

  it('sends the original when pod-actions cannot be reached at all', async () => {
    submitPod('PENDING', null)
    vi.spyOn(LambdaClient.prototype, 'send').mockRejectedValue(new Error('AccessDeniedException'))
    const pod = await podForSend()
    expect(pod?.originalKey).toBe('driver-docs/sub-1/page-1.jpg')
  })

  it('leaves a JobsDone POD alone — there is no submission to re-scan', async () => {
    tables[POD_TABLE].push({
      id: 'pod-1', loadId: 'load-1', originalKey: 'pods/load-1/original.pdf',
      createdAt: '2026-10-01T10:00:00Z',
    })
    const pod = await podForSend()
    expect(pod?.originalKey).toBe('pods/load-1/original.pdf')
    expect(invokes).toEqual([])
  })
})
