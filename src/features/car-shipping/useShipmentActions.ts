/**
 * Runs the auto shipper's shipment actions (Mark delivered, Create Square draft, Send Square invoice) and reports in plain words.
 * One place, so Auto Shipper Loads and Receivables do exactly the same thing. A Square problem never costs the shipment: the
 * reason is shown and the action can be repeated (it resumes).
 */
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { createSquareInvoice, getShipmentBundle, sendSquareInvoice, setLoadStatus } from '@/lib/apiClient'
import { errorMessage } from '@/lib/utils/errorMessage'
import type { ShipmentActionKind } from './autoShipperLoads'

/** Mark every live load of the shipment Delivered. An auto shipper has no dispatch ladder, so it is allowed from wherever it is. */
export async function markShipmentDelivered(shipmentId: string): Promise<void> {
  const bundle = await getShipmentBundle(shipmentId)
  const loads = bundle.loads.filter((l) => l.status !== 'DELIVERED' && l.status !== 'CANCELED')
  if (loads.length === 0) throw new Error('No load on this shipment is waiting to be delivered')
  for (const load of loads) await setLoadStatus({ loadId: load.id, status: 'DELIVERED' })
}

export function useShipmentActions(onDone: () => void | Promise<void>): {
  busyId: string | null
  run: (kind: ShipmentActionKind, shipmentId: string) => Promise<void>
} {
  const [busyId, setBusyId] = useState<string | null>(null)
  const run = useCallback(async (kind: ShipmentActionKind, shipmentId: string) => {
    if (busyId) return
    setBusyId(shipmentId)
    try {
      if (kind === 'MARK_DELIVERED') {
        await markShipmentDelivered(shipmentId)
        toast.success('Marked Delivered. It is in Ready to invoice now.')
      } else if (kind === 'CREATE_DRAFT') {
        const made = await createSquareInvoice({ shipmentId })
        if (made.skipped) toast.warning(`Square draft not made: ${made.skipped}`, { duration: 15000 })
        else toast.success('Square draft created. Nothing was sent.')
      } else {
        await sendSquareInvoice({ shipmentId })
        toast.success('Invoice sent through Square. It is in Receivables now.')
      }
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusyId(null)
      await onDone()
    }
  }, [busyId, onDone])
  return { busyId, run }
}
