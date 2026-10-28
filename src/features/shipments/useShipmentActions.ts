/**
 * One place where the shipment UI turns a click into a `tmsShipmentActions` call.
 *
 * Every action is CAS-checked server-side against the `updatedAt` / `version` the user
 * was looking at, so the tokens come from the bundle currently on screen. A success
 * returns the whole bundle, which the caller swaps in; a failure surfaces the Lambda's
 * own message rather than a generic one.
 */
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  assignAsset, assignCarrier, deleteShipment, duplicateShipment, recalcCharges, removeLoadCarrier,
  restoreShipment, saveOrderForm, setArStatus, setLoadStatus, setShipmentStatus, submitOrder,
  tenderRespond, updateStop,
} from '@/lib/apiClient'
import type { LoadChargeInput, ShipmentBundle } from '@/types/tms'
import type { OrderFormValues } from './components/DraftOrderEditor'
import type { StopActionInput } from './components/StopCards'
import type { ShipmentActionHandlers, LoadActionHandlers } from './components/StatusActions'

export interface ShipmentActions {
  shipment: ShipmentActionHandlers
  load: LoadActionHandlers
  saveForm: (values: OrderFormValues) => Promise<void>
  submit: (carrierRepId: string | undefined) => Promise<void>
  stopAction: (input: StopActionInput) => Promise<void>
  saveCharges: (charges: LoadChargeInput[]) => Promise<void>
  busy: boolean
}

export function useShipmentActions(
  bundle: ShipmentBundle | null,
  onBundle: (next: ShipmentBundle) => void,
): ShipmentActions {
  const [busy, setBusy] = useState(false)

  // Every action funnels through here so the busy flag, the toast and the bundle swap
  // are written once instead of sixteen times.
  const call = useCallback(async (label: string, fn: () => Promise<ShipmentBundle>) => {
    setBusy(true)
    try {
      onBundle(await fn())
    } catch (err) {
      const message = err instanceof Error ? err.message : `${label} failed`
      toast.error(message)
      throw err instanceof Error ? err : new Error(message)
    } finally {
      setBusy(false)
    }
  }, [onBundle])

  const shipmentId = bundle?.shipment.id ?? ''
  const expectedUpdatedAt = bundle?.shipment.updatedAt ?? ''
  const order = bundle?.orders[0]
  const load = bundle?.loads[0]

  return {
    busy,
    saveForm: async (values) => {
      await call('Save draft', () => saveOrderForm({
        shipmentId,
        expectedUpdatedAt,
        order: {
          mode: values.mode,
          rateType: values.rateType,
          customerContactId: values.customerContactId || null,
          billToId: values.billToId || null,
          costCenter: values.costCenter || null,
          equipmentType: values.equipmentType || null,
          equipmentLengthFt: values.equipmentLengthFt ? Number(values.equipmentLengthFt) : null,
          customerNotes: values.customerNotes || null,
          internalNotes: values.internalNotes || null,
          references: values.references,
          freight: values.freight,
          specialRequirements: {
            team: values.team, tarps: values.tarps, straps: values.straps,
            liftgate: values.liftgate, hazmat: values.hazmat,
          },
        },
      }))
    },
    submit: async (carrierRepId) => {
      await call('Submit order', () => submitOrder({ shipmentId, expectedUpdatedAt, carrierRepId }))
    },
    stopAction: async (input) => {
      await call('Update stop', () => updateStop({
        loadId: load?.id ?? '',
        expectedUpdatedAt: load?.updatedAt ?? expectedUpdatedAt,
        op: input.op,
        stopId: input.stopId,
        patch: input.patch,
      }))
    },
    saveCharges: async (charges) => {
      await call('Save charges', () => recalcCharges({
        shipmentId,
        expectedVersion: bundle?.shipment.version ?? 0,
        charges,
      }))
    },
    shipment: {
      onDuplicate: async (copies, sameCarrier) => {
        await call('Duplicate', () => duplicateShipment({ shipmentId, copies, sameCarrier }))
        toast.success(`${copies.length} copy${copies.length === 1 ? '' : 'ies'} created`)
      },
      onSetStatus: async (status, reason) => {
        await call('Status change', () => setShipmentStatus({ shipmentId, expectedUpdatedAt, status, reason }))
      },
      onDelete: async () => {
        await call('Delete', () => deleteShipment({ shipmentId, expectedUpdatedAt }))
      },
      onRestore: async () => {
        await call('Restore', () => restoreShipment({ shipmentId }))
      },
      onTenderRespond: async (decision, reason) => {
        await call('Tender response', () => tenderRespond({ shipmentId, expectedUpdatedAt, decision, reason }))
      },
    },
    load: {
      onSetLoadStatus: async (status) => {
        await call('Load status', () => setLoadStatus({ loadId: load?.id ?? '', status }))
      },
      onAssignAsset: async (input) => {
        await call('Assign asset', () => assignAsset({ loadId: load?.id ?? '', ...input }))
      },
      onAssignCarrier: async (input) => {
        await call('Assign carrier', () => assignCarrier({ loadId: load?.id ?? '', ...input }))
      },
      onRemoveCarrier: async (loadCarrierId, outcome, reason) => {
        await call('Remove carrier', () => removeLoadCarrier({ loadCarrierId, outcome, reason }))
      },
      onSetArStatus: async (status) => {
        await call('AR status', () => setArStatus({ orderId: order?.id ?? '', status }))
      },
    },
  }
}
