// @vitest-environment node
/**
 * A POD reaches us through three unrelated stores, and submit used to see only one.
 *
 * JobsDone PODs arrive by text and a human links them to a load. A driver scanning in the
 * PWA, and staff uploading on their behalf, write a DriverSubmissionDoc instead. Before
 * this, a load with a perfectly good signed POD sitting in the second store was refused
 * at submit as "missing POD" — the invoice could not be created over a document we
 * already had.
 *
 * The third store is the shipment's own typed documents (step F): a brokered load has no
 * driver submission and no JobsDone text, and its POD arrives through the carrier upload
 * portal or a staff upload. It is consulted LAST, so nothing about the own-fleet
 * precedence above moves.
 *
 * These tests drive the handler's real DynamoDB calls through a stubbed client, because
 * the thing worth pinning is which store it consults and how it matches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'

const POD_TABLE = 'PodDocument-test'
const SUB_TABLE = 'DriverSubmission-test'
const DOC_TABLE = 'DriverSubmissionDoc-test'
const SHIP_DOC_TABLE = 'ShipmentDocument-test'

interface Tables {
  [POD_TABLE]: Record<string, unknown>[]
  [SUB_TABLE]: Record<string, unknown>[]
  [DOC_TABLE]: Record<string, unknown>[]
  [SHIP_DOC_TABLE]: Record<string, unknown>[]
}

let tables: Tables

/** Load the handler after the env is set — the table names are read at module scope. */
async function loadFindPod() {
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
  return (mod as unknown as { __testFindPod?: unknown }).__testFindPod
}

beforeEach(() => {
  tables = { [POD_TABLE]: [], [SUB_TABLE]: [], [DOC_TABLE]: [], [SHIP_DOC_TABLE]: [] }
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof QueryCommand) {
      // The shipment-document index: partition shipmentId, sorted by uploadedAt.
      const rows = tables[cmd.input.TableName as keyof Tables] ?? []
      const wanted = cmd.input.ExpressionAttributeValues?.[':s']
      const items = rows
        .filter((r) => r.shipmentId === wanted)
        .sort((a, b) => String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')))
      return { Items: cmd.input.ScanIndexForward === false ? items.reverse() : items }
    }
    if (!(cmd instanceof ScanCommand)) return {}
    const name = cmd.input.TableName as keyof Tables
    const rows = tables[name] ?? []
    // The POD scan filters on loadId server-side; emulate just that one expression.
    const filter = cmd.input.FilterExpression
    const wanted = cmd.input.ExpressionAttributeValues?.[':l']
    const items = filter === 'loadId = :l' ? rows.filter((r) => r.loadId === wanted) : rows
    return { Items: items }
  })
})
afterEach(() => vi.restoreAllMocks())

describe('the POD submit uploads', () => {
  it('is exported for testing', async () => {
    // Guards the seam these tests depend on; a rename would otherwise silently skip them.
    expect(typeof (await loadFindPod())).toBe('function')
  })

  it('prefers a JobsDone POD that a human linked to the load', async () => {
    tables[POD_TABLE].push({
      id: 'pod-1', loadId: 'load-1', fileName: 'POD.pdf',
      originalKey: 'pods/load-1/original.pdf', createdAt: '2026-10-01T10:00:00Z',
    })
    tables[SUB_TABLE].push({ id: 'sub-1', loadId: 'load-1' })
    tables[DOC_TABLE].push({
      id: 'doc-1', submissionId: 'sub-1', kind: 'POD',
      s3Key: 'driver-docs/d/sub-1/POD/1.jpg', uploadedAt: '2026-10-01T12:00:00Z',
    })

    const findPod = (await loadFindPod()) as (l: string, p?: string) => Promise<Record<string, unknown> | null>
    const pod = await findPod('load-1', '14538')
    expect(pod?.originalKey).toBe('pods/load-1/original.pdf')
  })

  it('finds a POD a driver scanned, matched by the load it was attached to', async () => {
    tables[SUB_TABLE].push({ id: 'sub-1', loadId: 'load-1' })
    tables[DOC_TABLE].push({
      id: 'doc-1', submissionId: 'sub-1', kind: 'POD', fileName: 'POD-14538.pdf',
      contentType: 'application/pdf',
      s3Key: 'driver-docs/d/sub-1/POD/1.pdf', uploadedAt: '2026-10-01T12:00:00Z',
    })

    const findPod = (await loadFindPod()) as (l: string, p?: string) => Promise<Record<string, unknown> | null>
    const pod = await findPod('load-1', '14538')
    expect(pod).toMatchObject({
      loadId: 'load-1',
      originalKey: 'driver-docs/d/sub-1/POD/1.pdf',
      fileName: 'POD-14538.pdf',
      contentType: 'application/pdf',
    })
  })

  it('matches on the PRO the driver typed when no load was attached', async () => {
    tables[SUB_TABLE].push({ id: 'sub-1', loadId: null, referenceNumber: 'PRO 14538' })
    tables[DOC_TABLE].push({
      id: 'doc-1', submissionId: 'sub-1', kind: 'POD',
      s3Key: 'driver-docs/d/sub-1/POD/1.pdf', uploadedAt: '2026-10-01T12:00:00Z',
    })

    const findPod = (await loadFindPod()) as (l: string, p?: string) => Promise<Record<string, unknown> | null>
    expect((await findPod('load-1', '14538  '))?.originalKey).toBe('driver-docs/d/sub-1/POD/1.pdf')
  })

  it('takes the newest page when several were sent', async () => {
    tables[SUB_TABLE].push({ id: 'sub-1', loadId: 'load-1' })
    tables[DOC_TABLE].push(
      { id: 'old', submissionId: 'sub-1', kind: 'POD', s3Key: 'a.pdf', uploadedAt: '2026-09-01T00:00:00Z' },
      { id: 'new', submissionId: 'sub-1', kind: 'POD', s3Key: 'b.pdf', uploadedAt: '2026-10-01T00:00:00Z' },
    )

    const findPod = (await loadFindPod()) as (l: string, p?: string) => Promise<Record<string, unknown> | null>
    expect((await findPod('load-1', '14538'))?.originalKey).toBe('b.pdf')
  })

  it('ignores a rate confirmation sitting in the same store', async () => {
    tables[SUB_TABLE].push({ id: 'sub-1', loadId: 'load-1' })
    tables[DOC_TABLE].push({
      id: 'doc-1', submissionId: 'sub-1', kind: 'RATECON',
      s3Key: 'driver-docs/d/sub-1/RATECON/1.pdf', uploadedAt: '2026-10-01T12:00:00Z',
    })

    const findPod = (await loadFindPod()) as (l: string, p?: string) => Promise<Record<string, unknown> | null>
    expect(await findPod('load-1', '14538')).toBeNull()
  })

  it('never takes another load’s POD', async () => {
    tables[SUB_TABLE].push({ id: 'sub-1', loadId: 'load-OTHER', referenceNumber: '99999' })
    tables[DOC_TABLE].push({
      id: 'doc-1', submissionId: 'sub-1', kind: 'POD', s3Key: 'x.pdf', uploadedAt: '2026-10-01T12:00:00Z',
    })

    const findPod = (await loadFindPod()) as (l: string, p?: string) => Promise<Record<string, unknown> | null>
    expect(await findPod('load-1', '14538')).toBeNull()
  })

  it('returns null when neither store holds one', async () => {
    const findPod = (await loadFindPod()) as (l: string, p?: string) => Promise<Record<string, unknown> | null>
    expect(await findPod('load-1', '14538')).toBeNull()
  })
})

/**
 * The shipment's own documents (step F).
 *
 * A load booked in the TMS for an outside carrier has nothing in either own-fleet store:
 * its POD comes back through the carrier upload portal, or staff attach it, and either
 * way it is a ShipmentDocument row. Reading it is what lets such a load be factored at
 * all — but it must never jump the queue ahead of the stores that were already there,
 * and it must never send a document nobody has accepted.
 */
describe('a POD on the shipment itself', () => {
  type Find = (l: string, p?: string, s?: string) => Promise<Record<string, unknown> | null>

  /** An accepted, active POD on shp-1, attached to no particular load. */
  function shipmentPod(over: Record<string, unknown> = {}) {
    return {
      id: 'sd-1', shipmentId: 'shp-1', type: 'POD', status: 'ACTIVE',
      name: 'POD-signed.pdf', contentType: 'application/pdf',
      s3Key: 'shipment-docs/shp-1/pod.pdf', uploadedAt: '2026-10-05T10:00:00Z',
      ...over,
    }
  }

  it('is read when neither own-fleet store has one', async () => {
    tables[SHIP_DOC_TABLE].push(shipmentPod())
    const findPod = (await loadFindPod()) as Find
    expect(await findPod('load-1', '14538', 'shp-1')).toMatchObject({
      id: 'sd-1',
      loadId: 'load-1',
      fileName: 'POD-signed.pdf',
      contentType: 'application/pdf',
      originalKey: 'shipment-docs/shp-1/pod.pdf',
      createdAt: '2026-10-05T10:00:00Z',
    })
  })

  it('never outranks a JobsDone POD or a driver submission', async () => {
    tables[SHIP_DOC_TABLE].push(shipmentPod())
    tables[SUB_TABLE].push({ id: 'sub-1', loadId: 'load-1' })
    tables[DOC_TABLE].push({
      id: 'doc-1', submissionId: 'sub-1', kind: 'POD',
      s3Key: 'driver-docs/d/sub-1/POD/1.pdf', uploadedAt: '2026-10-06T12:00:00Z',
    })

    const findPod = (await loadFindPod()) as Find
    expect((await findPod('load-1', '14538', 'shp-1'))?.originalKey)
      .toBe('driver-docs/d/sub-1/POD/1.pdf')

    tables[POD_TABLE].push({
      id: 'pod-1', loadId: 'load-1', fileName: 'POD.pdf',
      originalKey: 'pods/load-1/original.pdf', createdAt: '2026-10-01T10:00:00Z',
    })
    expect((await findPod('load-1', '14538', 'shp-1'))?.originalKey)
      .toBe('pods/load-1/original.pdf')
  })

  it('does nothing for a load that belongs to no shipment', async () => {
    // Every own-fleet load predating the shipment layer takes this path: unchanged.
    tables[SHIP_DOC_TABLE].push(shipmentPod())
    const findPod = (await loadFindPod()) as Find
    expect(await findPod('load-1', '14538')).toBeNull()
  })

  it('refuses an upload nobody has reviewed, and one that was refused', async () => {
    /*
     * A carrier-portal upload is PENDING until a person looks at it, and REJECTED is that
     * person saying it is not the POD. Either one reaching OTR is a document the office
     * never accepted being used to buy an invoice.
     */
    tables[SHIP_DOC_TABLE].push(shipmentPod({ id: 'sd-pending', reviewStatus: 'PENDING' }))
    const findPod = (await loadFindPod()) as Find
    expect(await findPod('load-1', '14538', 'shp-1')).toBeNull()

    tables[SHIP_DOC_TABLE] = [shipmentPod({ id: 'sd-rejected', reviewStatus: 'REJECTED' })]
    expect(await findPod('load-1', '14538', 'shp-1')).toBeNull()

    tables[SHIP_DOC_TABLE] = [shipmentPod({ id: 'sd-ok', reviewStatus: 'ACCEPTED' })]
    expect((await findPod('load-1', '14538', 'shp-1'))?.id).toBe('sd-ok')
  })

  it('refuses a superseded or voided row', async () => {
    tables[SHIP_DOC_TABLE].push(shipmentPod({ status: 'SUPERSEDED' }))
    const findPod = (await loadFindPod()) as Find
    expect(await findPod('load-1', '14538', 'shp-1')).toBeNull()

    tables[SHIP_DOC_TABLE] = [shipmentPod({ status: 'VOID' })]
    expect(await findPod('load-1', '14538', 'shp-1')).toBeNull()
  })

  it('never takes another load’s POD from the same shipment', async () => {
    // A multi-leg shipment delivers more than once; leg 2's POD does not prove leg 1.
    tables[SHIP_DOC_TABLE].push(shipmentPod({ id: 'sd-other', loadId: 'load-OTHER' }))
    const findPod = (await loadFindPod()) as Find
    expect(await findPod('load-1', '14538', 'shp-1')).toBeNull()

    tables[SHIP_DOC_TABLE].push(shipmentPod({ id: 'sd-mine', loadId: 'load-1' }))
    expect((await findPod('load-1', '14538', 'shp-1'))?.id).toBe('sd-mine')
  })

  it('takes the newest POD and ignores every other document type', async () => {
    tables[SHIP_DOC_TABLE].push(
      shipmentPod({ id: 'sd-bol', type: 'BOL', uploadedAt: '2026-10-09T10:00:00Z' }),
      shipmentPod({ id: 'sd-old', uploadedAt: '2026-10-01T10:00:00Z' }),
      shipmentPod({ id: 'sd-new', uploadedAt: '2026-10-07T10:00:00Z' }),
    )
    const findPod = (await loadFindPod()) as Find
    expect((await findPod('load-1', '14538', 'shp-1'))?.id).toBe('sd-new')
  })

  it('ignores a document on a different shipment', async () => {
    tables[SHIP_DOC_TABLE].push(shipmentPod({ shipmentId: 'shp-OTHER' }))
    const findPod = (await loadFindPod()) as Find
    expect(await findPod('load-1', '14538', 'shp-1')).toBeNull()
  })
})
