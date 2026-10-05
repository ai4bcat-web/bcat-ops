// @vitest-environment node
/**
 * A rate confirmation reaches BCAT Ops two ways, and the factoring queue saw only one.
 *
 * Staff attaching one to the load writes `Load.rateConfirmKey`. A driver — or staff on
 * their behalf — sending one through the driver app writes a DriverSubmission instead,
 * exactly as a POD does; the app offers RATECON alongside POD. The queue read only the key
 * on the Load, so a rate con that arrived the second way was reported missing, the row
 * stayed blocked, and submitting failed over a document already in the building.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'

const POD_TABLE = 'PodDocument-test'
const SUB_TABLE = 'DriverSubmission-test'
const DOC_TABLE = 'DriverSubmissionDoc-test'

let tables: Record<string, Record<string, unknown>[]>

async function loadFindRatecon() {
  process.env.POD_DOCUMENT_TABLE_NAME = POD_TABLE
  process.env.DRIVER_SUBMISSION_TABLE_NAME = SUB_TABLE
  process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME = DOC_TABLE
  process.env.FACTORING_ITEM_TABLE_NAME = 'FactoringItem-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.CUSTOMER_TABLE_NAME = 'Customer-test'
  process.env.OTR_BASE_URL = 'https://example.invalid'
  vi.resetModules()
  const mod = await import('./handler')
  return (mod as unknown as {
    __testFindRatecon: (load: Record<string, unknown>, pro?: string) => Promise<Record<string, unknown> | null>
  }).__testFindRatecon
}

beforeEach(() => {
  tables = { [POD_TABLE]: [], [SUB_TABLE]: [], [DOC_TABLE]: [] }
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof ScanCommand)) return {}
    return { Items: tables[cmd.input.TableName as string] ?? [] }
  })
})
afterEach(() => vi.restoreAllMocks())

describe('finding a rate confirmation already in BCAT Ops', () => {
  it('prefers the key attached to the load', async () => {
    // What staff attached to the load itself, and what the load drawer shows.
    const find = await loadFindRatecon()
    const r = await find({ id: 'l1', rateConfirmKey: 'rate-confirms/l1/rate-confirm.pdf' }, '14538')
    expect(r?.originalKey).toBe('rate-confirms/l1/rate-confirm.pdf')
    expect(r?.fileName).toBe('RateCon-14538.pdf')
  })

  it('falls back to a merged rate con sent through the driver app', async () => {
    tables[SUB_TABLE] = [{ id: 's1', loadId: 'l1', combinedRateconKey: 'driver-docs/d/s1/RATECON/combined.pdf', combinedAt: '2026-10-05T10:00:00Z' }]
    const find = await loadFindRatecon()
    const r = await find({ id: 'l1' }, '14538')
    expect(r?.originalKey).toBe('driver-docs/d/s1/RATECON/combined.pdf')
    expect(r?.contentType).toBe('application/pdf')
  })

  it('falls back to a single RATECON page when nothing was merged', async () => {
    tables[SUB_TABLE] = [{ id: 's1', loadId: 'l1' }]
    tables[DOC_TABLE] = [{ id: 'd1', submissionId: 's1', kind: 'RATECON', s3Key: 'driver-docs/d/s1/RATECON/1.pdf', uploadedAt: '2026-10-05T10:00:00Z' }]
    const find = await loadFindRatecon()
    expect((await find({ id: 'l1' }, '14538'))?.originalKey).toBe('driver-docs/d/s1/RATECON/1.pdf')
  })

  it('matches a submission by PRO when it was never linked to the load', async () => {
    // The live table stores PROs padded; normalizePro is what makes this match.
    tables[SUB_TABLE] = [{ id: 's1', referenceNumber: 'PRO 14538', combinedRateconKey: 'k.pdf', combinedAt: '2026-10-05T10:00:00Z' }]
    const find = await loadFindRatecon()
    expect((await find({ id: 'l1' }, '14538  '))?.originalKey).toBe('k.pdf')
  })

  it('never returns a POD as a rate confirmation', async () => {
    /*
     * The two share the submission and the lookup. Returning the wrong kind would attach a
     * proof of delivery to OTR's rate-confirmation slot, which is worse than sending none.
     */
    tables[SUB_TABLE] = [{ id: 's1', loadId: 'l1', combinedPodKey: 'pod.pdf', combinedAt: '2026-10-05T10:00:00Z' }]
    tables[DOC_TABLE] = [{ id: 'd1', submissionId: 's1', kind: 'POD', s3Key: 'pod-page.pdf', uploadedAt: '2026-10-05T10:00:00Z' }]
    const find = await loadFindRatecon()
    expect(await find({ id: 'l1' }, '14538')).toBeNull()
  })

  it('returns null when there is genuinely nothing', async () => {
    const find = await loadFindRatecon()
    expect(await find({ id: 'l1' }, '14538')).toBeNull()
  })
})
