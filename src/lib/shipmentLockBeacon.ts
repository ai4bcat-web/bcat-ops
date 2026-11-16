/**
 * Letting go of a shipment's edit lock while the page itself is going away (browser tab closed, reload, navigating off the app).
 * A normal GraphQL call started in `pagehide` is usually cancelled with the page, which left the lock to lapse on its own 10 minutes
 * later. A `keepalive` fetch outlives the page, but it has to be built synchronously, so the sign-in token is cached ahead of time
 * (primed every time the lock is taken or refreshed) and the UNLOCK_SHIPMENT mutation is posted straight to the AppSync endpoint.
 */
import { fetchAuthSession } from 'aws-amplify/auth'
import outputs from '../../amplify_outputs.json'

const UNLOCK_MUTATION = 'mutation TmsShipmentActions($action: String!, $input: AWSJSON!) { tmsShipmentActions(action: $action, input: $input) }'
let cachedToken: string | null = null

/** Refreshes the cached token. Cheap: Amplify answers from its own session cache. */
export async function primeLockBeacon(): Promise<void> {
  try {
    const session = await fetchAuthSession()
    cachedToken = session.tokens?.accessToken?.toString() ?? null
  } catch { /* no token: the caller falls back to the ordinary call */ }
}

/** Fires UNLOCK_SHIPMENT as a keepalive request. False when it could not be sent, so the caller can fall back. */
export function unlockShipmentBeacon(shipmentId: string): boolean {
  const url = (outputs as { data?: { url?: string } }).data?.url
  if (!cachedToken || !url || !/^https:\/\//.test(url) || typeof fetch !== 'function') return false
  try {
    void fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: cachedToken },
      body: JSON.stringify({ query: UNLOCK_MUTATION, variables: { action: 'UNLOCK_SHIPMENT', input: JSON.stringify({ shipmentId }) } }),
    }).catch(() => undefined)
    return true
  } catch {
    return false
  }
}
