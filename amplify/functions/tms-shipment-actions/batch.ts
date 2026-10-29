/** Server batches preserve each single-shipment gate and report every requested row. */
import { assertArrayOf, assertEnum, assertRecord, assertString, type Caller } from '../_shared/actionInputs'
import type { Row } from '../_shared/shipmentStore'
import type { BatchShipmentTask, BatchShipmentTaskResult } from '../../../src/types/tms'

export const BATCH_TASK_ACTIONS = {
  RELEASE_TO_BILLING: 'READY_TO_INVOICE',
  SET_SALES_REP: 'SET_SALES_REP',
  SET_REV_DIVISION: 'SET_REV_TAG',
  SET_CARRIER_REP: 'ASSIGN_CARRIER_REP',
  SET_STATUS: 'SET_SHIPMENT_STATUS',
} as const

export interface BatchShipmentDeps {
  getShipment: (shipmentId: string) => Promise<Row | null>
  getOrders: (shipmentId: string) => Promise<Row[]>
  authorize: (action: typeof BATCH_TASK_ACTIONS[BatchShipmentTask], caller: Caller) => boolean
  releaseToBilling: (input: Row, caller: Caller) => Promise<unknown>
  setSalesRep: (input: Row, caller: Caller) => Promise<unknown>
  setRevTag: (input: Row, caller: Caller) => Promise<unknown>
  assignCarrierRep: (input: Row, caller: Caller) => Promise<unknown>
  setStatus: (input: Row, caller: Caller) => Promise<unknown>
  writeAudit: (entityType: string, entityId: string, action: string, caller: Caller, changes: Row) => Promise<void>
}

export async function batchShipmentTask(deps: BatchShipmentDeps, input: Row, caller: Caller): Promise<BatchShipmentTaskResult> {
  const task = assertEnum(input.task, Object.keys(BATCH_TASK_ACTIONS) as BatchShipmentTask[], 'task')
  const shipmentIds = assertArrayOf(input.shipmentIds, 'shipmentIds', (id) => assertString(id, 'shipmentId'), 100)
  if (shipmentIds.length === 0) throw new Error('shipmentIds must have at least one entry')
  const params = input.params == null ? {} : assertRecord(input.params, 'params')
  if (!deps.authorize(BATCH_TASK_ACTIONS[task], caller)) throw new Error(`Forbidden: ${task}`)

  const results: BatchShipmentTaskResult['results'] = []
  for (const shipmentId of shipmentIds) {
    let number: string | null = null
    try {
      const shipment = await deps.getShipment(shipmentId)
      if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
      number = typeof shipment.number === 'string' ? shipment.number : null
      switch (task) {
        case 'RELEASE_TO_BILLING': {
          const orders = await deps.getOrders(shipmentId)
          if (orders.length === 0) throw new Error('Shipment has no order to release to billing')
          await deps.releaseToBilling({ shipmentId, orderId: orders[0].id, expectedUpdatedAt: orders[0].updatedAt }, caller)
          break
        }
        case 'SET_SALES_REP':
          await deps.setSalesRep({ ...params, shipmentId }, caller)
          break
        case 'SET_REV_DIVISION':
          await deps.setRevTag({ ...params, shipmentId }, caller)
          break
        case 'SET_CARRIER_REP':
          await deps.assignCarrierRep({ ...params, shipmentId }, caller)
          break
        case 'SET_STATUS':
          // The CAS token comes from the row this loop just read, so a batch cannot
          // overwrite a change somebody made between the click and the call.
          await deps.setStatus({ ...params, shipmentId, expectedUpdatedAt: shipment.updatedAt }, caller)
          break
      }
      results.push({ shipmentId, number, ok: true, message: null })
    } catch (error) {
      results.push({ shipmentId, number, ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }
  const okCount = results.filter((result) => result.ok).length
  await deps.writeAudit('SHIPMENT', 'BATCH', 'BATCH_SHIPMENT_TASK', caller, {
    task, count: results.length, okCount, failCount: results.length - okCount,
  })
  return { results }
}
