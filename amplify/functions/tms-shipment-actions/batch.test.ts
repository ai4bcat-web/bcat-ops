/** Batch outcomes must preserve input order and never hide a failed shipment. */
import { describe, expect, it, vi } from 'vitest'
import { batchShipmentTask, type BatchShipmentDeps } from './batch'
import type { Caller } from '../_shared/actionInputs'
import { releaseGateError } from '../../../src/lib/releaseGate'

const caller: Caller = { email: 'admin@test.com', sub: 'admin', groups: ['ADMIN'], isAdmin: true }
function dependencies(): BatchShipmentDeps {
  return {
    getShipment: async (id) => id === 'missing' ? null : { id, number: `S-${id}`, updatedAt: `upd-${id}` },
    getOrders: async (id) => [{ id: `order-${id}`, updatedAt: '2026-10-29T00:00:00Z' }],
    authorize: () => true,
    releaseToBilling: async (input) => {
      if (input.orderId === 'order-b') throw new Error('Not ready for accounting: Missing document: POD')
    },
    setSalesRep: vi.fn(), setRevTag: vi.fn(), assignCarrierRep: vi.fn(), setStatus: vi.fn(), writeAudit: vi.fn(),
    pushToReview: vi.fn(async () => ({ reasons: [], already: false })),
    getLoadsOf: vi.fn(async () => []),
    assignAsset: vi.fn(),
  }
}

describe('batchShipmentTask', () => {
  it('continues after a gate refusal and retains every input position, including duplicates and missing ids', async () => {
    const deps = dependencies()
    const result = await batchShipmentTask(deps, { task: 'RELEASE_TO_BILLING', shipmentIds: ['a', 'b', 'missing', 'a', 'c'], params: { review: { source: 'LOAD_REVIEW' } } }, caller)
    expect(result.results).toEqual([
      { shipmentId: 'a', number: 'S-a', ok: true, message: null },
      { shipmentId: 'b', number: 'S-b', ok: false, message: 'Not ready for accounting: Missing document: POD' },
      { shipmentId: 'missing', number: null, ok: false, message: 'Shipment not found: missing' },
      { shipmentId: 'a', number: 'S-a', ok: true, message: null },
      { shipmentId: 'c', number: 'S-c', ok: true, message: null },
    ])
    expect(deps.writeAudit).toHaveBeenCalledWith('SHIPMENT', 'BATCH', 'BATCH_SHIPMENT_TASK', caller, {
      task: 'RELEASE_TO_BILLING', count: 5, okCount: 3, failCount: 2, review: true,
    })
  })

  it('forwards the literal Load Review marker to each release and records it in the audit', async () => {
    const deps = dependencies()
    deps.releaseToBilling = vi.fn(async () => undefined)
    await batchShipmentTask(deps, { task: 'RELEASE_TO_BILLING', shipmentIds: ['a'], params: { review: { source: 'LOAD_REVIEW', extra: 1 } } }, caller)
    expect(deps.releaseToBilling).toHaveBeenCalledWith(
      { shipmentId: 'a', orderId: 'order-a', expectedUpdatedAt: '2026-10-29T00:00:00Z', review: { source: 'LOAD_REVIEW' } },
      caller,
    )
    expect(deps.writeAudit).toHaveBeenCalledWith('SHIPMENT', 'BATCH', 'BATCH_SHIPMENT_TASK', caller, {
      task: 'RELEASE_TO_BILLING', count: 1, okCount: 1, failCount: 0, review: true,
    })
  })

  it('refuses a release that does not carry the literal Load Review marker', async () => {
    for (const review of [undefined, true, 'LOAD_REVIEW', { source: 'OTHER' }]) {
      const deps = dependencies()
      deps.releaseToBilling = vi.fn(async () => undefined)
      await expect(
        batchShipmentTask(deps, { task: 'RELEASE_TO_BILLING', shipmentIds: ['a'], params: review === undefined ? {} : { review } }, caller),
      ).rejects.toThrow('Load Review only')
      expect(deps.releaseToBilling).not.toHaveBeenCalled()
    }
  })

  it('refuses unauthorized tasks before executing any row', async () => {
    const deps = dependencies()
    deps.authorize = () => false
    await expect(batchShipmentTask(deps, { task: 'SET_SALES_REP', shipmentIds: ['a'], params: { repId: 'rep' } }, caller)).rejects.toThrow('Forbidden')
    expect(deps.setSalesRep).not.toHaveBeenCalled()
  })

  it('rejects empty and oversized batches before writes', async () => {
    const deps = dependencies()
    for (const shipmentIds of [[], Array.from({ length: 101 }, (_, i) => String(i))]) {
      await expect(batchShipmentTask(deps, { task: 'SET_REV_DIVISION', shipmentIds }, caller)).rejects.toThrow(/at least one|at most 100/)
    }
    expect(deps.setRevTag).not.toHaveBeenCalled()
  })

  describe('Load Review batches (Step AP)', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

    it('accepts nine and refuses the tenth for a push and for a release, before any row runs', async () => {
      const deps = dependencies()
      deps.pushToReview = vi.fn(async () => ({ reasons: [], already: false }))
      deps.releaseToBilling = vi.fn(async () => undefined)
      const review = { review: { source: 'LOAD_REVIEW' } }
      expect((await batchShipmentTask(deps, { task: 'PUSH_TO_LOAD_REVIEW', shipmentIds: ids(9) }, caller)).results).toHaveLength(9)
      expect((await batchShipmentTask(deps, { task: 'RELEASE_TO_BILLING', shipmentIds: ids(9), params: review }, caller)).results).toHaveLength(9)
      vi.mocked(deps.pushToReview).mockClear()
      vi.mocked(deps.releaseToBilling).mockClear()
      await expect(batchShipmentTask(deps, { task: 'PUSH_TO_LOAD_REVIEW', shipmentIds: ids(10) }, caller)).rejects.toThrow('at most 9')
      await expect(batchShipmentTask(deps, { task: 'RELEASE_TO_BILLING', shipmentIds: ids(10), params: review }, caller)).rejects.toThrow('at most 9')
      expect(deps.pushToReview).not.toHaveBeenCalled()
      expect(deps.releaseToBilling).not.toHaveBeenCalled()
    })

    it('reports a refused push per row with its reasons and still pushes the clean rows', async () => {
      const deps = dependencies()
      deps.pushToReview = vi.fn(async (id) => (id === 'b'
        ? { reasons: ['Missing sales rep', 'POD not received'], already: false }
        : { reasons: [], already: id === 'c' }))
      const { results } = await batchShipmentTask(deps, { task: 'PUSH_TO_LOAD_REVIEW', shipmentIds: ['a', 'b', 'c'] }, caller)
      expect(results).toEqual([
        { shipmentId: 'a', number: 'S-a', ok: true, message: null },
        { shipmentId: 'b', number: 'S-b', ok: false, message: 'Missing sales rep; POD not received', reasons: ['Missing sales rep', 'POD not received'] },
        { shipmentId: 'c', number: 'S-c', ok: true, message: 'Already in Load Review' },
      ])
      expect(deps.writeAudit).toHaveBeenCalledWith('SHIPMENT', 'BATCH', 'BATCH_SHIPMENT_TASK', caller, {
        task: 'PUSH_TO_LOAD_REVIEW', count: 3, okCount: 2, failCount: 1,
      })
    })

    it('carries a release refusal as a per-row reason list', async () => {
      const deps = dependencies()
      deps.releaseToBilling = async () => {
        throw releaseGateError([
          { code: 'DOC_MISSING', detail: 'POD', message: 'Missing document: POD' },
          { code: 'DRIVER_MISSING', detail: null, message: 'No driver' },
        ])
      }
      const { results } = await batchShipmentTask(deps, { task: 'RELEASE_TO_BILLING', shipmentIds: ['a'], params: { review: { source: 'LOAD_REVIEW' } } }, caller)
      expect(results[0]).toMatchObject({ ok: false, reasons: ['Missing document: POD', 'No driver'] })
    })
  })

  it('sends each row its own version token when it sets a status', async () => {
    const deps = dependencies()
    await batchShipmentTask(deps, { task: 'SET_STATUS', shipmentIds: ['a', 'b'], params: { status: 'ON_HOLD', reason: 'Weather' } }, caller)
    expect(deps.setStatus).toHaveBeenNthCalledWith(1, { status: 'ON_HOLD', reason: 'Weather', shipmentId: 'a', expectedUpdatedAt: 'upd-a' }, caller)
    expect(deps.setStatus).toHaveBeenNthCalledWith(2, { status: 'ON_HOLD', reason: 'Weather', shipmentId: 'b', expectedUpdatedAt: 'upd-b' }, caller)
  })

  describe('ASSIGN_DRIVER', () => {
    it('reports each row in request order, refuses multi-leg and covered rows, and never forwards the overrides', async () => {
      const deps = dependencies()
      const loads: Record<string, Array<Record<string, unknown>>> = {
        ok: [{ id: 'lod-ok', assignmentType: 'NEED_TO_COVER' }],
        legs: [{ id: 'lod-1' }, { id: 'lod-2' }],
        covered: [{ id: 'lod-cov', assignmentType: 'CARRIER', carrierName: 'Swift' }],
        closed: [{ id: 'lod-closed', assignmentType: 'OWN_ASSET' }],
      }
      deps.getLoadsOf = async (id) => loads[id]
      deps.assignAsset = vi.fn(async (input) => {
        if (input.loadId === 'lod-closed') throw new Error('Delivered 2026-03-03: that pay week has closed.')
      })
      const params = { driverId: 'drv-1', truckId: 'trk-7', payOverrideReason: 'sneaky reason here', flattenSplit: true }
      const result = await batchShipmentTask(deps, { task: 'ASSIGN_DRIVER', shipmentIds: ['ok', 'legs', 'covered', 'closed'], params }, caller)
      expect(result.results.map((r) => [r.shipmentId, r.ok, r.message])).toEqual([
        ['ok', true, null],
        ['legs', false, 'Batch driver assignment handles one-leg shipments; open this shipment to assign each leg.'],
        ['covered', false, 'This load is covered by Swift. Bounce the carrier on the shipment first.'],
        ['closed', false, 'Delivered 2026-03-03: that pay week has closed.'],
      ])
      expect(deps.assignAsset).toHaveBeenCalledTimes(2)
      expect(deps.assignAsset).toHaveBeenNthCalledWith(1, { driverId: 'drv-1', truckId: 'trk-7', loadId: 'lod-ok' }, caller)
      expect(deps.writeAudit).toHaveBeenCalledTimes(1)
    })

    it('authorizes as ASSIGN_ASSET and refuses an unauthorized caller before any row', async () => {
      const deps = dependencies()
      const authorize = vi.fn(() => false)
      deps.authorize = authorize
      await expect(batchShipmentTask(deps, { task: 'ASSIGN_DRIVER', shipmentIds: ['a'], params: { driverId: 'drv-1' } }, caller)).rejects.toThrow('Forbidden')
      expect(authorize).toHaveBeenCalledWith('ASSIGN_ASSET', caller)
      expect(deps.assignAsset).not.toHaveBeenCalled()
    })
  })
})
