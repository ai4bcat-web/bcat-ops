/**
 * A load an outside carrier covers has no roster driver. Putting one of our drivers on it means taking the carrier off
 * (BOUNCED, the carrier history keeps why) and booking the driver as Ivan Cartage. That is a decision, so the person who
 * picked the driver is asked first: the store asks through this tiny bus, and the calendar's host dialog answers.
 */
export interface OwnFleetSwitchRequest {
  /** OWN_FLEET: an outside carrier comes off and one of our drivers goes on. UNCOVER: the load goes back to "need to cover". */
  kind?: 'OWN_FLEET' | 'UNCOVER'
  loadId: string
  loadLabel: string
  carrierName: string | null
  /** The roster driver (OWN_FLEET), or the own-fleet driver being taken off (UNCOVER, may be null). */
  driverId: string | null
}

type Listener = (req: OwnFleetSwitchRequest, answer: (ok: boolean) => void) => void
let listener: Listener | null = null

/** The host dialog registers itself while mounted; returns the unregister. */
export function onOwnFleetSwitchRequest(fn: Listener): () => void {
  listener = fn
  return () => { if (listener === fn) listener = null }
}

/** Ask whether to switch. Resolves false when nobody can be asked (no calendar open), so nothing is switched silently. */
export function confirmOwnFleetSwitch(req: OwnFleetSwitchRequest): Promise<boolean> {
  return new Promise((resolve) => {
    if (!listener) return resolve(false)
    listener(req, resolve)
  })
}

/** Thrown when the person said no: not an error worth a message. */
export class OwnFleetSwitchCancelled extends Error {
  constructor() { super('Switch to Ivan Cartage cancelled') }
}

export const COVERED_LOAD_MESSAGE = 'This load is covered by an outside carrier. To put one of our drivers on it, pick the driver for the whole load and confirm the switch to Ivan Cartage, or edit the driver on the carrier card.'

// ── "Broker covered" from the calendar: pick the carrier in the Cover dialog (a carrier is never invented) ──

export interface CoverRequest { shipmentId: string; shipmentNumber: string }
let coverListener: ((req: CoverRequest) => void) | null = null

export function onCoverRequest(fn: (req: CoverRequest) => void): () => void {
  coverListener = fn
  return () => { if (coverListener === fn) coverListener = null }
}

/** Open the Cover dialog for a shipment. False when no calendar is listening. */
export function requestCover(req: CoverRequest): boolean {
  if (!coverListener) return false
  coverListener(req)
  return true
}

export const BROKER_ROW_NO_SHIPMENT_MESSAGE = 'This load has no shipment yet, so it cannot be covered or uncovered from the calendar.'
