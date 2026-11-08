// @vitest-environment node
/**
 * A rate confirmation reaches BCAT Ops two ways, and the factoring queue saw only one.
 *
 * Staff attaching one to the load writes `Load.rateConfirmKey`. A driver — or staff on
 * their behalf — sending one through the driver app writes a DriverSubmission instead,
 * exactly as a POD does; the app offers RATECON alongside POD. The queue read only the key
 * on the Load, so a rate con that arrived the second way was reported missing, the row
 * stayed blocked, and submitting failed over a document already in the building.
 *
 * Step F adds a third place it can be: the shipment's own typed documents, which is the
 * ONLY place a load booked in the TMS keeps the customer's tender. It is consulted last,
 * so neither of the two above moves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'

const POD_TABLE = 'PodDocument-test'
const SUB_TABLE = 'DriverSubmission-test'
const DOC_TABLE = 'DriverSubmissionDoc-test'
const SHIP_DOC_TABLE = 'ShipmentDocument-test'

let tables: Record<string, Record<string, unknown>[]>

async function loadFindRatecon() {
  process.env.POD_DOCUMENT_TABLE_NAME = POD_TABLE
  process.env.DRIVER_SUBMISSION_TABLE_NAME = SUB_TABLE
  process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME = DOC_TABLE
  process.env.SHIPMENT_DOCUMENT_TABLE_NAME = SHIP_DOC_TABLE
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
  tables = { [POD_TABLE]: [], [SUB_TABLE]: [], [DOC_TABLE]: [], [SHIP_DOC_TABLE]: [] }
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof QueryCommand) {
      // The shipment-document index: partition shipmentId, sorted by uploadedAt.
      const rows = tables[cmd.input.TableName as string] ?? []
      const wanted = cmd.input.ExpressionAttributeValues?.[':s']
      const items = rows
        .filter((r) => r.shipmentId === wanted)
        .sort((a, b) => String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')))
      return { Items: cmd.input.ScanIndexForward === false ? items.reverse() : items }
    }
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

/**
 * The customer's tender on the shipment itself (step F).
 *
 * What OTR buys is the broker's rate confirmation. In the TMS that is the order's
 * CUSTOMER_RATE_CON; the plain RATE_CON in the Carrier section is what WE send a carrier,
 * and it states our cost — uploading it would show the factor the margin on the load it
 * is buying.
 */
describe('a rate confirmation on the shipment itself', () => {
  function doc(over: Record<string, unknown> = {}) {
    return {
      id: 'sd-1', shipmentId: 'shp-1', orderId: 'ord-1', type: 'CUSTOMER_RATE_CON',
      status: 'ACTIVE', name: 'Tender.pdf', contentType: 'application/pdf',
      s3Key: 'shipment-docs/shp-1/tender.pdf', uploadedAt: '2026-10-05T10:00:00Z',
      ...over,
    }
  }
  const LOAD = { id: 'l1', shipmentId: 'shp-1', orderId: 'ord-1' }

  it('is read when the load and the driver app have nothing', async () => {
    tables[SHIP_DOC_TABLE] = [doc()]
    const find = await loadFindRatecon()
    expect(await find(LOAD, '14538')).toMatchObject({
      id: 'sd-1',
      loadId: 'l1',
      fileName: 'Tender.pdf',
      contentType: 'application/pdf',
      originalKey: 'shipment-docs/shp-1/tender.pdf',
      createdAt: '2026-10-05T10:00:00Z',
    })
  })

  it('never outranks the key on the load or a driver submission', async () => {
    tables[SHIP_DOC_TABLE] = [doc()]
    const find = await loadFindRatecon()
    expect((await find({ ...LOAD, rateConfirmKey: 'rate-confirms/l1/rc.pdf' }, '14538'))?.originalKey)
      .toBe('rate-confirms/l1/rc.pdf')

    tables[SUB_TABLE] = [{ id: 's1', loadId: 'l1', combinedRateconKey: 'driver.pdf', combinedAt: '2026-10-06T10:00:00Z' }]
    expect((await find(LOAD, '14538'))?.originalKey).toBe('driver.pdf')
  })

  it('does nothing for a load that belongs to no shipment', async () => {
    tables[SHIP_DOC_TABLE] = [doc()]
    const find = await loadFindRatecon()
    expect(await find({ id: 'l1' }, '14538')).toBeNull()
  })

  it('prefers the order’s CUSTOMER_RATE_CON to a plain one', async () => {
    tables[SHIP_DOC_TABLE] = [
      doc({ id: 'sd-plain', type: 'RATE_CON', s3Key: 'plain.pdf', uploadedAt: '2026-10-09T10:00:00Z' }),
      doc({ id: 'sd-customer', s3Key: 'customer.pdf', uploadedAt: '2026-10-01T10:00:00Z' }),
    ]
    const find = await loadFindRatecon()
    // Newer, but the wrong type: the customer tender wins whatever the order of arrival.
    expect((await find(LOAD, '14538'))?.id).toBe('sd-customer')
  })

  it('falls back to a Customer-section RATE_CON', async () => {
    tables[SHIP_DOC_TABLE] = [doc({ id: 'sd-plain', type: 'RATE_CON' })]
    const find = await loadFindRatecon()
    expect((await find(LOAD, '14538'))?.id).toBe('sd-plain')
  })

  it('never takes the Carrier-section rate con, which states our cost', async () => {
    tables[SHIP_DOC_TABLE] = [
      doc({ id: 'sd-carrier', type: 'RATE_CON', orderId: null, loadCarrierId: 'lc-1' }),
    ]
    const find = await loadFindRatecon()
    expect(await find(LOAD, '14538')).toBeNull()
  })

  it('never takes another order’s tender from the same shipment', async () => {
    tables[SHIP_DOC_TABLE] = [doc({ id: 'sd-other', orderId: 'ord-OTHER' })]
    const find = await loadFindRatecon()
    expect(await find(LOAD, '14538')).toBeNull()
  })

  it('refuses a pending, refused, superseded or voided row', async () => {
    const find = await loadFindRatecon()
    for (const over of [
      { reviewStatus: 'PENDING' }, { reviewStatus: 'REJECTED' },
      { status: 'SUPERSEDED' }, { status: 'VOID' },
    ]) {
      tables[SHIP_DOC_TABLE] = [doc(over)]
      expect(await find(LOAD, '14538')).toBeNull()
    }
  })
})
