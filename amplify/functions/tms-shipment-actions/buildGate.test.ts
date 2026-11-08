// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  assertBuilt,
  checkBuildGate,
  completeBuild,
  evaluateBuild,
  type BuildGateDeps,
} from './buildGate'
import type { Bundle, Row } from '../_shared/shipmentStore'
import type { Caller } from '../_shared/actionInputs'

const fixedNow = '2026-10-29T12:00:00.000Z'

interface FixtureOptions {
  shipment?: Row
  orders?: Row[]
  loads?: Row[]
  customer?: Row | null
  settings?: Row
}

function makeFixture({
  shipment,
  orders = [],
  loads = [],
  customer = null,
  settings = {},
}: FixtureOptions = {}) {
  const rowsByTable = new Map<string, Map<string, Row>>()
  const transactCalls: TransactWriteItem[][] = []
  const auditCalls: Parameters<BuildGateDeps['writeAudit']>[] = []
  let failCas = false

  function seed(table: string, id: string, row: Row) {
    if (!rowsByTable.has(table)) rowsByTable.set(table, new Map())
    rowsByTable.get(table)!.set(id, row)
  }

  const shipmentRow: Row = {
    id: 'shp:test',
    number: 'S000001',
    salesRepId: 'sales-rep',
    revDivision: 'MIDWEST',
    carrierRepId: 'carrier-rep',
    carrierTeamKey: null,
    customerId: 'cus:test',
    updatedAt: '2026-10-29T10:00:00.000Z',
    ...shipment,
  }

  const orderRows: Row[] = orders.length
    ? orders
    : [
        {
          id: 'ord:test',
          shipmentId: shipmentRow.id,
          customerId: 'cus:test',
          billToId: 'cus:test',
          customerRateCents: 1_200_00,
          equipmentType: 'VAN',
          references: [],
          freight: [],
        },
      ]

  const loadRows: Row[] = loads.length
    ? loads
    : [
        {
          id: 'lod:test',
          shipmentId: shipmentRow.id,
          orderId: orderRows[0]?.id,
          stops: [
            {
              id: 'stop-pu',
              type: 'pickup',
              sequence: 0,
              appt: '2026-10-30T09:00:00.000Z',
              address: { street: '1 Main St', city: 'Chicago', state: 'IL' },
            },
            {
              id: 'stop-del',
              type: 'delivery',
              sequence: 1,
              appt: '2026-10-30T17:00:00.000Z',
              address: { street: '2 Elm St', city: 'Detroit', state: 'MI' },
            },
          ],
        },
      ]

  seed('Shipment', String(shipmentRow.id), shipmentRow)
  for (const order of orderRows) seed('Order', String(order.id), order)
  for (const load of loadRows) seed('Load', String(load.id), load)
  if (customer) seed('Customer', String(customer.id), customer)
  seed('Settings', 'default', settings)

  const deps: BuildGateDeps = {
    tables: {
      shipment: 'Shipment',
      order: 'Order',
      load: 'Load',
      customer: 'Customer',
      settings: 'Settings',
    },

    getById: async (table, id) => rowsByTable.get(table)?.get(id) ?? null,

    queryIndex: async () => [],

    transact: async (items) => {
      transactCalls.push(items)
      if (failCas) {
        const err = new Error('Transaction canceled') as Error & { CancellationReasons?: { Code?: string }[] }
        err.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }]
        throw err
      }
      for (const item of items) {
        if (!item.Update) continue
        const table = String(item.Update.TableName)
        const id = String(unmarshall(item.Update.Key as Record<string, AttributeValue>).id)
        const stored = rowsByTable.get(table)?.get(id)
        if (!stored || !item.Update.ExpressionAttributeValues) continue
        const values = unmarshall(item.Update.ExpressionAttributeValues as Record<string, AttributeValue>) as Row
        const expected = values[':casExpectedUpdatedAt']
        if (expected != null && expected !== '' && expected !== stored.updatedAt) {
          const err = new Error('Conditional check failed') as Error & { CancellationReasons?: { Code?: string }[] }
          err.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }]
          throw err
        }
        const patch: Row = {}
        for (const [k, v] of Object.entries(values)) {
          if (k.startsWith(':') && k !== ':casExpectedUpdatedAt' && k !== ':casEmpty') {
            patch[k.slice(1)] = v
          }
        }
        Object.assign(stored, patch)
      }
    },

    readBundle: async (shipmentId) => {
      const s = rowsByTable.get('Shipment')?.get(shipmentId)
      if (!s) throw new Error(`Shipment not found: ${shipmentId}`)
      return {
        shipment: s,
        orders: [...(rowsByTable.get('Order')?.values() ?? [])].filter((o) => o.shipmentId === shipmentId),
        loads: [...(rowsByTable.get('Load')?.values() ?? [])].filter((l) => l.shipmentId === shipmentId),
        loadCarriers: [],
        charges: [],
        financials: [],
        documents: [],
      } as unknown as Bundle as unknown as Row
    },

    getSettings: async () => settings,

    writeAudit: async (...args) => {
      auditCalls.push(args)
    },

    now: () => fixedNow,
  }

  const caller: Caller = { email: 'test@example.com', sub: 'sub-123', groups: [], isAdmin: false }

  return {
    deps,
    caller,
    shipment: shipmentRow,
    auditCalls,
    transactCalls,
    rowsByTable,
    setFailCas: (value: boolean) => {
      failCas = value
    },
  }
}

describe('evaluateBuild', () => {
  it('applies the org default required fields when the customer has none', async () => {
    const { deps } = makeFixture()
    const result = await evaluateBuild(deps, 'shp:test')
    expect(result.requiredFields).toEqual([
      'pickupAddress',
      'deliveryAddress',
      'billTo',
      'salesRep',
      'revenueDivision',
    ])
  })

  it('adds the customer required fields to the org list', async () => {
    const { deps } = makeFixture({
      customer: { id: 'cus:test', requiredLoadFields: ['equipmentType', 'poNumber'] },
    })
    const result = await evaluateBuild(deps, 'shp:test')
    expect(result.requiredFields).toContain('equipmentType')
    expect(result.requiredFields).toContain('poNumber')
    expect(result.requiredFields).toContain('pickupAddress')
  })

  it('cannot subtract one of the org five fields', async () => {
    const { deps } = makeFixture({
      customer: { id: 'cus:test', requiredLoadFields: ['salesRep'] },
      // settings has no explicit list, so the built-in org five are used.
    })
    const result = await evaluateBuild(deps, 'shp:test')
    expect(result.requiredFields).toEqual(
      expect.arrayContaining([
        'pickupAddress',
        'deliveryAddress',
        'billTo',
        'salesRep',
        'revenueDivision',
      ]),
    )
  })

  it('detects a missing pickup address', async () => {
    const { deps } = makeFixture({
      loads: [
        {
          id: 'lod:test',
          shipmentId: 'shp:test',
          stops: [
            { id: 'stop-pu', type: 'pickup', sequence: 0, appt: '2026-10-30T09:00:00.000Z' },
            { id: 'stop-del', type: 'delivery', sequence: 1, appt: '2026-10-30T17:00:00.000Z', address: { city: 'Detroit', state: 'MI' } },
          ],
        },
      ],
    })
    const result = await evaluateBuild(deps, 'shp:test')
    expect(result.missingFields).toContain('pickupAddress')
    expect(result.missingFields).not.toContain('deliveryAddress')
  })

  it('detects a missing delivery address', async () => {
    const { deps } = makeFixture({
      loads: [
        {
          id: 'lod:test',
          shipmentId: 'shp:test',
          stops: [
            { id: 'stop-pu', type: 'pickup', sequence: 0, appt: '2026-10-30T09:00:00.000Z', address: { city: 'Chicago', state: 'IL' } },
            { id: 'stop-del', type: 'delivery', sequence: 1, appt: '2026-10-30T17:00:00.000Z' },
          ],
        },
      ],
    })
    const result = await evaluateBuild(deps, 'shp:test')
    expect(result.missingFields).toContain('deliveryAddress')
    expect(result.missingFields).not.toContain('pickupAddress')
  })

  it('detects a missing bill-to', async () => {
    const { deps } = makeFixture({
      orders: [{ id: 'ord:test', shipmentId: 'shp:test', customerId: 'cus:test', billToId: null, customerRateCents: 100_00, equipmentType: 'VAN', references: [], freight: [] }],
    })
    const result = await evaluateBuild(deps, 'shp:test')
    expect(result.missingFields).toContain('billTo')
  })

  it('detects a missing sales rep', async () => {
    const { deps } = makeFixture({ shipment: { salesRepId: null } })
    const result = await evaluateBuild(deps, 'shp:test')
    expect(result.missingFields).toContain('salesRep')
  })

  it('detects a missing revenue division', async () => {
    const { deps } = makeFixture({ shipment: { revDivision: null } })
    const result = await evaluateBuild(deps, 'shp:test')
    expect(result.missingFields).toContain('revenueDivision')
  })

  it('reflects a customer-required field that is missing', async () => {
    const { deps } = makeFixture({
      customer: { id: 'cus:test', requiredLoadFields: ['equipmentType'] },
      orders: [
        { id: 'ord:test', shipmentId: 'shp:test', customerId: 'cus:test', billToId: 'cus:test', customerRateCents: 100_00, equipmentType: null, references: [], freight: [] },
      ],
    })
    const result = await evaluateBuild(deps, 'shp:test')
    expect(result.missingFields).toContain('equipmentType')
  })
})

describe('checkBuildGate', () => {
  it('reports BUILDING when fields are missing', async () => {
    const { deps } = makeFixture({ shipment: { buildState: 'BUILDING', salesRepId: null } })
    const result = await checkBuildGate(deps, { shipmentId: 'shp:test' })
    expect(result.buildState).toBe('BUILDING')
    expect(result.missingFields).toContain('salesRep')
  })

  it('reports BUILT when all required fields are present', async () => {
    const { deps } = makeFixture()
    const result = await checkBuildGate(deps, { shipmentId: 'shp:test' })
    expect(result.buildState).toBe('BUILT')
    expect(result.missingFields).toEqual([])
  })

  it('treats a shipment with no buildState as BUILT even when fields are missing', async () => {
    const { deps } = makeFixture({ shipment: { buildState: undefined, salesRepId: null } })
    const result = await checkBuildGate(deps, { shipmentId: 'shp:test' })
    expect(result.buildState).toBe('BUILT')
    expect(result.missingFields).toContain('salesRep')
  })
})

describe('completeBuild', () => {
  it('flips BUILDING to BUILT when all required fields are present', async () => {
    const { deps, caller, shipment } = makeFixture({ shipment: { buildState: 'BUILDING' } })
    const result = await completeBuild(deps, { shipmentId: 'shp:test', expectedUpdatedAt: shipment.updatedAt as string }, caller)
    expect(result.buildState).toBe('BUILT')
    expect(result.missingFields).toEqual([])
    expect((result.shipment as Row).buildState).toBe('BUILT')
  })

  it('refuses to flip BUILDING to BUILT while fields are missing', async () => {
    const { deps, caller, shipment } = makeFixture({ shipment: { buildState: 'BUILDING', salesRepId: null } })
    await expect(
      completeBuild(deps, { shipmentId: 'shp:test', expectedUpdatedAt: shipment.updatedAt as string }, caller),
    ).rejects.toThrow(/Finish building this shipment first — it still needs:/)
  })

  it('uses the exact Needs: labels in the refusal', async () => {
    const { deps, caller, shipment } = makeFixture({
      shipment: { buildState: 'BUILDING', salesRepId: null },
    })
    await expect(
      completeBuild(deps, { shipmentId: 'shp:test', expectedUpdatedAt: shipment.updatedAt as string }, caller),
    ).rejects.toThrow('Sales rep')
  })

  it('is idempotent on an already-BUILT shipment', async () => {
    const { deps, caller, shipment } = makeFixture({ shipment: { buildState: 'BUILT' } })
    const first = await completeBuild(deps, { shipmentId: 'shp:test', expectedUpdatedAt: shipment.updatedAt as string }, caller)
    const second = await completeBuild(deps, { shipmentId: 'shp:test', expectedUpdatedAt: (first.shipment as Row).updatedAt as string }, caller)
    expect(second.buildState).toBe('BUILT')
    expect(second.missingFields).toEqual(first.missingFields)
  })

  it('does not turn a pre-Step-P shipment (no buildState) into BUILDING when missing fields', async () => {
    const { deps, caller, shipment, rowsByTable } = makeFixture({
      shipment: { salesRepId: null },
    })
    const result = await completeBuild(deps, { shipmentId: 'shp:test', expectedUpdatedAt: shipment.updatedAt as string }, caller)
    expect(result.buildState).toBe('BUILT')
    expect((rowsByTable.get('Shipment')?.get('shp:test') as Row).buildState).toBe('BUILT')
  })

  it('requires expectedUpdatedAt', async () => {
    const { deps, caller } = makeFixture()
    await expect(completeBuild(deps, { shipmentId: 'shp:test' }, caller)).rejects.toThrow('expectedUpdatedAt')
  })

  it('refuses a stale expectedUpdatedAt (CAS)', async () => {
    const { deps, caller, shipment, setFailCas, rowsByTable } = makeFixture({ shipment: { buildState: 'BUILDING' } })
    setFailCas(true)
    try {
      await expect(
        completeBuild(deps, { shipmentId: 'shp:test', expectedUpdatedAt: 'stale' }, caller),
      ).rejects.toThrow(/Transaction canceled|ConditionalCheckFailed/)
    } finally {
      setFailCas(false)
    }
    // The stored shipment still has its original updatedAt because the write was rejected.
    expect((rowsByTable.get('Shipment')?.get('shp:test') as Row).updatedAt).toBe(shipment.updatedAt)
  })

  it('writes buildState and missingFields to the shipment on success', async () => {
    const { deps, caller, shipment, rowsByTable } = makeFixture({
      shipment: { buildState: 'BUILDING' },
    })
    await completeBuild(deps, { shipmentId: 'shp:test', expectedUpdatedAt: shipment.updatedAt as string }, caller)
    const stored = rowsByTable.get('Shipment')?.get('shp:test') as Row
    expect(stored.buildState).toBe('BUILT')
    expect(Array.isArray(stored.missingFields)).toBe(true)
    expect((stored.missingFields as string[])).toEqual([])
  })

  it('audits a successful transition', async () => {
    const { deps, caller, shipment, auditCalls } = makeFixture({ shipment: { buildState: 'BUILDING' } })
    await completeBuild(deps, { shipmentId: 'shp:test', expectedUpdatedAt: shipment.updatedAt as string }, caller)
    const buildAudits = auditCalls.filter((call) => call[2] === 'COMPLETE_BUILD')
    expect(buildAudits.length).toBeGreaterThan(0)
    expect(buildAudits[0]?.[4]).toMatchObject({ buildState: 'BUILT' })
  })
})

describe('assertBuilt', () => {
  it('passes for BUILT shipments', () => {
    expect(() => assertBuilt({ buildState: 'BUILT', missingFields: [] })).not.toThrow()
  })

  it('passes for shipments that predate the gate (no buildState)', () => {
    expect(() => assertBuilt({ missingFields: ['salesRep'] })).not.toThrow()
  })

  it('throws for BUILDING shipments with the Needs: sentence', () => {
    const shipment: Row = { buildState: 'BUILDING', missingFields: ['salesRep', 'revenueDivision'] }
    expect(() => assertBuilt(shipment)).toThrow(
      'Finish building this shipment first — it still needs: Sales rep, Revenue division',
    )
  })
})
