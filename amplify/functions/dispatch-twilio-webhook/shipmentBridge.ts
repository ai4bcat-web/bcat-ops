/**
 * Step AJ/AK — a driver's text, carried into the shipment thread.
 *
 * Dispatch keeps every text in the driver's conversation. When that driver has exactly one
 * live shipment (or one that is waiting on a reply), the same text is also written into the
 * shipment's own thread so the SMS pane is two-way. It never guesses: several candidate
 * shipments and nothing waiting means the text stays in Dispatch only.
 */
import type { Load } from '../../../src/types'

/** Load statuses a driver can be texted about: the tracking agent's "in motion" set, plus just dispatched. */
const LIVE_STATUSES: readonly string[] = [
  'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'RECOVERED',
  'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING',
]

interface BridgeLoad { id: string; shipmentId?: string | null; status?: string | null; checkCallAwaitingSince?: string | null }

export interface BridgeTarget { shipmentId: string; loadId: string }

/** The one shipment this driver's text belongs to, or null when that cannot be said for certain. */
export function pickBridgeTarget(loads: readonly BridgeLoad[]): BridgeTarget | null {
  const live = loads.filter((l) => l.shipmentId && LIVE_STATUSES.includes(String(l.status ?? '')))
  const waiting = live.filter((l) => l.checkCallAwaitingSince)
  if (waiting.length > 0) {
    const latest = waiting.reduce((a, b) => (String(b.checkCallAwaitingSince) > String(a.checkCallAwaitingSince) ? b : a))
    return { shipmentId: String(latest.shipmentId), loadId: latest.id }
  }
  const shipments = new Set(live.map((l) => l.shipmentId))
  if (shipments.size !== 1) return null
  const only = live[0]
  return { shipmentId: String(only.shipmentId), loadId: only.id }
}

export interface ShipmentBridgeDeps {
  loadsForDriver(driverId: string): Promise<Load[]>
  /** Calls the tracking router as a system caller. Throws on a failure. */
  invokeTracking(arguments_: { action: string; input: Record<string, unknown> }): Promise<unknown>
  /** The number the driver texted (our dispatch line). */
  dispatchNumber: string
}

export interface InboundText { driverId: string; from: string; body: string; sid: string }

/** Best-effort: returns the shipment it bridged to, or null. Throws only if the router call fails. */
export async function bridgeToShipment(deps: ShipmentBridgeDeps, text: InboundText): Promise<BridgeTarget | null> {
  if (!text.body.trim()) return null
  const loads = await deps.loadsForDriver(text.driverId)
  const target = pickBridgeTarget(loads as unknown as BridgeLoad[])
  if (!target) return null
  await deps.invokeTracking({
    action: 'INGEST_SHIPMENT_MESSAGE',
    input: {
      shipmentId: target.shipmentId,
      loadId: target.loadId,
      channel: 'SMS',
      party: 'DRIVER',
      kind: 'CHECK_CALL_REPLY',
      from: text.from,
      to: deps.dispatchNumber,
      body: text.body,
      // Twilio retries a webhook with the same MessageSid; the router dedupes on this.
      messageId: `sms:${text.sid}`,
    },
  })
  return target
}
