/**
 * Intake actions against an in-memory store. The fake `transact` honours the one
 * thing these actions depend on — the updatedAt compare-and-set — so a lost race
 * and a half-finished move behave as they do on DynamoDB.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

import { INTAKE_CONFLICT_MESSAGE, PROMOTING_STALE_MS, runIntakeAction, type IntakeDeps } from './intake'
import { emptyIntakeFields } from '../../../src/lib/intakeLoad'
import type { Caller } from '../_shared/actionInputs'

type Row = Record<string, unknown>

const T = { intakeLoad: 'Intake', shipment: 'Shipment', order: 'Order', load: 'Load' }
const REVIEWED = { reviewedBy: 'reviewer@bcatcorp.com', reviewedAt: '2026-11-03T11:30:00.000Z' }
const caller: Caller = { email: 'rev@bcatcorp.com', sub: 'sub-rev', groups: ['page-intakeReview'], isAdmin: false }

let store: Map<string, Map<string, Row>>
let clock: number
let audits: Array<{ type: string; id: string; action: string; changes: Row }>
let createShipment: Mock
let setRevTag: Mock
let setSalesRep: Mock
let customer: Row | null
let divisionActive: boolean

const rows = (t: string) => {
  if (!store.has(t)) store.set(t, new Map())
  return store.get(t)!
}

function applyItem(item: TransactWriteItem): void {
  const u = item.Update
  if (!u) throw new Error('unsupported item')
  const key = unmarshall(u.Key as never).id as string
  const row = rows(u.TableName!).get(key)
  if (!row) throw new Error('TransactionCanceled: missing row')
  const values = unmarshall((u.ExpressionAttributeValues ?? {}) as never)
  if (u.ConditionExpression && values[':casExpectedUpdatedAt'] !== row.updatedAt) {
    throw new Error('TransactionCanceled: ConditionalCheckFailed')
  }
  const next = { ...row }
  const set = /SET (.+?)(?: REMOVE |$)/.exec(u.UpdateExpression ?? '')?.[1] ?? ''
  for (const part of set.split(', ')) {
    const name = /#(\w+) = :/.exec(part)?.[1]
    if (name) next[name] = values[`:${name}`]
  }
  rows(u.TableName!).set(key, next)
}

function seedIntake(over: Row = {}): void {
  const fields = emptyIntakeFields()
  fields.customerId = 'cus-1'
  fields.customerName = 'Acme'
  fields.divisionCode = 'BROKERAGE'
  fields.reference = 'PO-77'
  fields.pickupNumber = 'PU-9'
  fields.equipmentType = 'Dry van'
  fields.commodity = 'Paper'
  fields.weightLb = 20000
  fields.customerRateCents = 150000
  fields.salesRepId = 'rep-1'
  fields.billToId = 'bill-1'
  fields.stops = [
    { type: 'pickup', name: 'Mill', street: null, city: 'Chicago', state: 'IL', zip: '60601', date: '2026-11-10', time: '08:00', instructions: null },
    { type: 'delivery', name: 'DC', street: null, city: 'Dallas', state: 'TX', zip: '75201', date: '2026-11-11', time: '09:00', instructions: null },
  ]
  rows(T.intakeLoad).set('il:r1', {
    id: 'il:r1',
    status: 'OPEN',
    runId: 'run-1',
    fields: JSON.stringify(fields),
    autoFields: JSON.stringify({ ...fields, commodity: null }),
    meta: '{}',
    confirmed: [],
    missingFields: [],
    version: 3,
    updatedAt: '2026-11-03T10:00:00.000Z',
    ...over,
  })
}

const deps = (): IntakeDeps => ({
  tables: T,
  getById: async (t, id) => rows(t).get(id) ?? null,
  queryIndex: async (t, _i, _k, v) => [...rows(t).values()].filter((r) => r.shipmentId === v),
  transact: async (items, label) => {
    // All-or-nothing: check every CAS before writing any.
    const snapshot = new Map([...store].map(([k, v]) => [k, new Map(v)]))
    try {
      items.forEach(applyItem)
    } catch (err) {
      store = snapshot
      const msg = err instanceof Error ? err.message : String(err)
      throw Object.assign(new Error(msg.includes('Conditional') ? `This ${label} was changed by someone else. ConditionalCheckFailed` : msg), { cause: err })
    }
  },
  getSettings: async () => null,
  getCustomer: async () => customer,
  isDivisionActive: async () => divisionActive,
  writeAudit: async (type, id, action, _c, changes) => {
    audits.push({ type, id, action, changes })
  },
  actions: { createShipment: createShipment as never, setRevTag: setRevTag as never, setSalesRep: setSalesRep as never },
  now: () => new Date(clock).toISOString(),
})

const run = (action: Parameters<typeof runIntakeAction>[1], input: Row) => runIntakeAction(deps(), action, input, caller)
const intake = () => rows(T.intakeLoad).get('il:r1')!

beforeEach(() => {
  store = new Map()
  clock = Date.parse('2026-11-03T12:00:00.000Z')
  audits = []
  customer = { id: 'cus-1', name: 'Acme', status: 'ACTIVE' }
  divisionActive = true
  createShipment = vi.fn(async () => {
    rows(T.shipment).set('shp-1', { id: 'shp-1', number: 'S1', updatedAt: '2026-11-03T11:00:00.000Z', version: 1 })
    rows(T.order).set('ord-1', { id: 'ord-1', shipmentId: 'shp-1', references: [], updatedAt: '2026-11-03T11:00:00.000Z', version: 1 })
    return { shipment: { id: 'shp-1', number: 'S1' } }
  })
  setRevTag = vi.fn(async () => ({}))
  setSalesRep = vi.fn(async () => ({}))
  seedIntake()
})

describe('INTAKE_SAVE_DRAFT', () => {
  it('stores the edit as the reviewer’s, bumps the version and recomputes what is missing', async () => {
    const out = (await run('INTAKE_SAVE_DRAFT', {
      intakeId: 'il:r1',
      expectedVersion: 3,
      fields: { commodity: 'Steel' },
    })) as unknown as { fields: { commodity: string }; meta: Record<string, { source: string }>; version: number }
    expect(out.fields.commodity).toBe('Steel')
    expect(out.meta.commodity.source).toBe('REVIEWER')
    expect(out.version).toBe(4)
    expect(intake().lastEditedBy).toBe(caller.email)
  })

  it('refuses a stale version and writes nothing', async () => {
    const before = { ...intake() }
    await expect(
      run('INTAKE_SAVE_DRAFT', { intakeId: 'il:r1', expectedVersion: 2, fields: { commodity: 'Steel' } }),
    ).rejects.toThrow(INTAKE_CONFLICT_MESSAGE)
    expect(intake()).toEqual(before)
  })

  it('refuses to edit a row that is no longer open', async () => {
    seedIntake({ status: 'DISMISSED' })
    await expect(
      run('INTAKE_SAVE_DRAFT', { intakeId: 'il:r1', expectedVersion: 3, fields: {} }),
    ).rejects.toThrow(/open/)
  })

  it('refuses to route a load to an archived division', async () => {
    divisionActive = false
    await expect(
      run('INTAKE_SAVE_DRAFT', { intakeId: 'il:r1', expectedVersion: 3, fields: { divisionCode: 'OLD' } }),
    ).rejects.toThrow(/archived division/)
  })
})

describe('review invalidation on save', () => {
  it('an edit clears the review; a no-op save keeps it', async () => {
    seedIntake(REVIEWED)
    await run('INTAKE_SAVE_DRAFT', { intakeId: 'il:r1', expectedVersion: 3, fields: { commodity: 'Paper' } })
    expect(intake()).toMatchObject(REVIEWED)

    await run('INTAKE_SAVE_DRAFT', { intakeId: 'il:r1', expectedVersion: 4, fields: { commodity: 'Steel' } })
    expect(intake()).toMatchObject({ reviewedBy: null, reviewedAt: null })
    expect(audits.at(-1)!.changes).toMatchObject({ reviewCleared: true })
  })

  it('ticking a confirmation is an edit too', async () => {
    seedIntake(REVIEWED)
    await run('INTAKE_SAVE_DRAFT', { intakeId: 'il:r1', expectedVersion: 3, confirm: { add: ['commodity'] } })
    expect(intake().reviewedAt).toBeNull()
  })
})

describe('INTAKE_DISMISS', () => {
  it('needs a reason', async () => {
    await expect(run('INTAKE_DISMISS', { intakeId: 'il:r1', expectedVersion: 3 })).rejects.toThrow(/reason/)
    expect(intake().status).toBe('OPEN')
  })

  it('dismisses an open row with who and why', async () => {
    await run('INTAKE_DISMISS', { intakeId: 'il:r1', expectedVersion: 3, reason: 'spam' })
    expect(intake()).toMatchObject({ status: 'DISMISSED', dismissedBy: caller.email, dismissReason: 'spam' })
    expect(audits.map((a) => a.action)).toEqual(['INTAKE_DISMISS'])
  })
})

describe('INTAKE_MARK_REVIEWED', () => {
  it('records who reviewed and when, bumps the version and audits it', async () => {
    const out = (await run('INTAKE_MARK_REVIEWED', { intakeId: 'il:r1', expectedVersion: 3 })) as unknown as {
      reviewedBy: string
      reviewedAt: string
      version: number
    }
    expect(out).toMatchObject({ reviewedBy: caller.email, reviewedAt: new Date(clock).toISOString(), version: 4 })
    expect(intake()).toMatchObject({ reviewedBy: caller.email, status: 'OPEN' })
    expect(audits.map((a) => a.action)).toEqual(['INTAKE_MARK_REVIEWED'])
  })

  it('refuses an incomplete load and writes nothing', async () => {
    const fields = JSON.parse(String(intake().fields))
    fields.stops = []
    seedIntake({ fields: JSON.stringify(fields) })
    const before = { ...intake() }
    await expect(run('INTAKE_MARK_REVIEWED', { intakeId: 'il:r1', expectedVersion: 3 })).rejects.toThrow(
      /^Cannot mark reviewed — still needs:/,
    )
    expect(intake()).toEqual(before)
  })

  it('is idempotent once reviewed, even with a stale version', async () => {
    seedIntake(REVIEWED)
    await run('INTAKE_MARK_REVIEWED', { intakeId: 'il:r1', expectedVersion: 3 })
    expect(intake()).toMatchObject(REVIEWED)
    expect(audits).toEqual([])
  })

  it('refuses a stale version and a row that is no longer open', async () => {
    await expect(run('INTAKE_MARK_REVIEWED', { intakeId: 'il:r1', expectedVersion: 2 })).rejects.toThrow(INTAKE_CONFLICT_MESSAGE)
    seedIntake({ status: 'DISMISSED' })
    await expect(run('INTAKE_MARK_REVIEWED', { intakeId: 'il:r1', expectedVersion: 3 })).rejects.toThrow(/open/)
  })
})

describe('INTAKE_MOVE_TO_ACTIVE', () => {
  beforeEach(() => seedIntake(REVIEWED))

  it('refuses a complete, fully auto-filled load that nobody has marked reviewed', async () => {
    seedIntake()
    const before = { ...intake() }
    await expect(run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 3 })).rejects.toThrow(
      /^Not ready to move to active — still needs: review/,
    )
    expect(intake()).toEqual(before)
    expect(createShipment).not.toHaveBeenCalled()
  })

  it('refuses a load that is not ready and writes no state', async () => {
    const fields = JSON.parse(String(intake().fields))
    fields.stops = []
    seedIntake({ ...REVIEWED, fields: JSON.stringify(fields) })
    const before = { ...intake() }
    await expect(run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 3 })).rejects.toThrow(
      /^Not ready to move to active — still needs:/,
    )
    expect(intake()).toEqual(before)
    expect(createShipment).not.toHaveBeenCalled()
  })

  it('refuses a customer that is not an active record', async () => {
    customer = { id: 'cus-1', name: 'Acme', status: 'ARCHIVED' }
    await expect(run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 3 })).rejects.toThrow(/Not ready/)
    expect(createShipment).not.toHaveBeenCalled()
  })

  it('creates one tender shipment, finishes it and marks the row MOVED', async () => {
    const out = (await run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 3 })) as unknown as {
      shipmentId: string
      shipmentNumber: string
      intake: { status: string }
    }
    expect(out).toMatchObject({ shipmentId: 'shp-1', shipmentNumber: 'S1', intake: { status: 'MOVED' } })
    expect(createShipment).toHaveBeenCalledTimes(1)
    expect(createShipment.mock.calls[0][0]).toMatchObject({ source: 'TENDER', workflowRunId: 'run-1', customerId: 'cus-1' })
    expect(setRevTag).toHaveBeenCalledWith({ shipmentId: 'shp-1', divisionCode: 'BROKERAGE' }, caller)
    expect(setSalesRep).toHaveBeenCalledWith({ shipmentId: 'shp-1', repId: 'rep-1' }, caller)
    expect(rows(T.shipment).get('shp-1')).toMatchObject({ intakeLoadId: 'il:r1', intakeReviewedBy: 'reviewer@bcatcorp.com', intakeReviewedAt: REVIEWED.reviewedAt })
    const refs = rows(T.order).get('ord-1')!.references as Row[]
    expect(refs.map((r) => [r.code, r.value])).toEqual([['po', 'PO-77'], ['pickup', 'PU-9']])
    expect(intake()).toMatchObject({ status: 'MOVED', shipmentId: 'shp-1', reviewedBy: 'reviewer@bcatcorp.com', reviewedAt: REVIEWED.reviewedAt })
    expect(audits.find((a) => a.type === 'INTAKE_LOAD')!.changes).toMatchObject({ movedBy: caller.email, reviewedBy: 'reviewer@bcatcorp.com' })
    expect(audits.map((a) => `${a.type}:${a.action}`).sort()).toEqual([
      'INTAKE_LOAD:INTAKE_MOVE_TO_ACTIVE',
      'SHIPMENT:INTAKE_MOVE_TO_ACTIVE',
    ])
    expect(audits[0].changes.corrected).toEqual(['commodity'])
  })

  it('restores OPEN when the shipment cannot be created', async () => {
    createShipment.mockRejectedValueOnce(new Error('credit limit'))
    await expect(run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 3 })).rejects.toThrow('credit limit')
    expect(intake().status).toBe('OPEN')
    expect(intake().shipmentId).toBeUndefined()
  })

  it('resumes after a failure past shipment creation without a second shipment', async () => {
    setRevTag.mockRejectedValueOnce(new Error('boom'))
    await expect(run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 3 })).rejects.toThrow('boom')
    expect(intake()).toMatchObject({ status: 'PROMOTING', shipmentId: 'shp-1', shipmentNumber: 'S1' })

    // The page still holds the old version; resume does not need it.
    const out = (await run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 3 })) as unknown as {
      shipmentId: string
    }
    expect(out.shipmentId).toBe('shp-1')
    expect(createShipment).toHaveBeenCalledTimes(1)
    expect(intake().status).toBe('MOVED')
    const refs = rows(T.order).get('ord-1')!.references as Row[]
    expect(refs).toHaveLength(2)
  })

  it('answers a stale version with the reload message', async () => {
    await expect(run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 1 })).rejects.toThrow(
      INTAKE_CONFLICT_MESSAGE,
    )
    expect(createShipment).not.toHaveBeenCalled()
  })

  it('does not start a second move while one is in flight, but retakes an abandoned one', async () => {
    seedIntake({ ...REVIEWED, status: 'PROMOTING', updatedAt: new Date(clock - 1000).toISOString() })
    await expect(run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 3 })).rejects.toThrow(/already being moved/)
    expect(createShipment).not.toHaveBeenCalled()

    seedIntake({ ...REVIEWED, status: 'PROMOTING', updatedAt: new Date(clock - PROMOTING_STALE_MS - 1000).toISOString() })
    await run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 3 })
    expect(createShipment).toHaveBeenCalledTimes(1)
    expect(intake().status).toBe('MOVED')
  })

  it('refuses a dismissed row', async () => {
    seedIntake({ status: 'DISMISSED' })
    await expect(run('INTAKE_MOVE_TO_ACTIVE', { intakeId: 'il:r1', expectedVersion: 3 })).rejects.toThrow(/dismissed/)
  })
})
