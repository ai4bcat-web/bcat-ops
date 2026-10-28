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
  assignAsset, assignCarrier, bookCarrier, deleteShipment, dispatchLoad, duplicateShipment, getShipmentBundle,
  logCheckCall, recalcCharges, removeLoadCarrier, resolveIncident, restoreShipment, saveOrderForm, sendRateCon,
  setArStatus, setEta, setLoadStatus, setNextCheckCall, setQuickPay, setShipmentStatus, sendTrackingLink,
  submitOrder, tenderRespond, updateStop, voidRateCon,
} from '@/lib/apiClient'
import type { LoadChargeInput, ShipmentBundle } from '@/types/tms'
import type { BookCarrierFields } from '@/features/carriers/components/BookCarrierDialog'
import type { OrderFormValues } from './components/DraftOrderEditor'
import type { DispatchFields } from './components/DispatchDialog'
import type { StopActionInput } from './components/StopCards'
import type { CheckCallFormValues } from './components/LogCheckCallDialog'
import type { ShipmentActionHandlers, LoadActionHandlers } from './components/StatusActions'

export interface ShipmentActions {
  shipment: ShipmentActionHandlers
  load: LoadActionHandlers
  saveForm: (values: OrderFormValues) => Promise<void>
  submit: (carrierRepId: string | undefined) => Promise<void>
  stopAction: (input: StopActionInput) => Promise<void>
  saveCharges: (charges: LoadChargeInput[]) => Promise<void>
  /** Step C — the carrier side of a load, all CAS-checked against the bundle on screen. */
  bookCarrier: (input: BookCarrierFields) => Promise<void>
  setQuickPay: (input: { loadCarrierId: string; quickPayDays: number | null }) => Promise<void>
  sendRateCon: (input: { loadCarrierId: string; pdfBase64: string; to: string[]; cc?: string[]; expiresHours?: number }) => Promise<void>
  voidRateCon: (input: { loadCarrierId: string }) => Promise<void>
  dispatchLoad: (input: DispatchFields) => Promise<void>
  /** Step D — the tracking tab. Each answers with the bundle, which is swapped in here. */
  tracking: TrackingActionHandlers
  /**
   * Re-read the shipment from the server. The link actions live on the tracking router
   * and answer with a link, not a bundle, but they do write LoadCarrier, Load and
   * Shipment — so the tab asks for the real rows rather than patching its own copy.
   */
  reload: () => Promise<void>
  busy: boolean
}

export interface TrackingActionHandlers {
  logCheckCall: (values: CheckCallFormValues) => Promise<void>
  resolveIncident: (checkCallId: string, note?: string) => Promise<void>
  /** `null` clears the reminder — "I don't need to schedule one". */
  setNextCheckCall: (nextCheckCallAt: string | null, note?: string) => Promise<void>
  setEta: (input: { pickupEtaAt?: string | null; deliveryEtaAt?: string | null; note?: string }) => Promise<void>
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

  // Booking is reachable from the load menu and from the actions object; one definition
  // so the two can never drift apart.
  const book = async (input: BookCarrierFields) => {
    await call('Book carrier', () => bookCarrier({
      loadId: load?.id ?? '',
      expectedUpdatedAt: load?.updatedAt ?? expectedUpdatedAt,
      ...input,
    }))
  }

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
    bookCarrier: book,
    setQuickPay: async (input) => {
      await call('Quick pay', () => setQuickPay(input))
    },
    sendRateCon: async (input) => {
      await call('Send rate con', () => sendRateCon(input))
    },
    voidRateCon: async (input) => {
      await call('Void rate con', () => voidRateCon(input))
    },
    dispatchLoad: async (input) => {
      const { sendTrackingLink: alsoSendLink, ...fields } = input
      await call('Dispatch', () => dispatchLoad({ loadId: load?.id ?? '', ...fields }))
      // Only after the truck is dispatched, and never rolled back into it: a text that
      // fails to send is reported on its own and leaves the dispatch standing.
      if (alsoSendLink) {
        const loadCarrier = bundle?.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
        if (!loadCarrier) return
        try {
          const sent = await sendTrackingLink({ loadCarrierId: loadCarrier.id, via: 'SMS' })
          if (sent.smsStatus === 'SENT') toast.success('Tracking link texted to the driver')
          else toast.warning(`Dispatched, but the tracking link was not texted (${sent.smsStatus.replace(/_/g, ' ').toLowerCase()}). Copy it from the Tracking tab.`)
          onBundle(await getShipmentBundle(shipmentId))
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Dispatched, but the tracking link could not be sent')
        }
      }
    },
    tracking: {
      logCheckCall: async (values) => {
        await call('Check call', async () => (await logCheckCall({
          loadId: load?.id ?? '',
          expectedUpdatedAt: load?.updatedAt ?? expectedUpdatedAt,
          ...values,
        })).bundle)
      },
      resolveIncident: async (checkCallId, note) => {
        await call('Resolve exception', async () => (await resolveIncident({ checkCallId, note })).bundle)
      },
      setNextCheckCall: async (nextCheckCallAt, note) => {
        await call('Next check call', async () => (await setNextCheckCall({
          loadId: load?.id ?? '',
          expectedUpdatedAt: load?.updatedAt ?? expectedUpdatedAt,
          nextCheckCallAt,
          note,
        })).bundle)
      },
      setEta: async (input) => {
        const loadCarrier = bundle?.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
        await call('ETA', async () => (await setEta({
          loadCarrierId: loadCarrier?.id ?? '',
          expectedUpdatedAt: loadCarrier?.updatedAt ?? '',
          ...input,
        })).bundle)
      },
    },
    reload: async () => {
      if (!shipmentId) return
      onBundle(await getShipmentBundle(shipmentId))
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
      onBookCarrier: book,
      onRemoveCarrier: async (loadCarrierId, outcome, reason, note) => {
        await call('Remove carrier', () => removeLoadCarrier({ loadCarrierId, outcome, reason, note }))
      },
      onSetArStatus: async (status) => {
        await call('AR status', () => setArStatus({ orderId: order?.id ?? '', status }))
      },
    },
  }
}
