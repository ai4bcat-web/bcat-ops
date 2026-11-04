/**
 * tms-spot-quoter Lambda — see resource.ts.
 *
 * Two doors: AppSync (`event.arguments`, the `tmsSpotActions` router) and EventBridge
 * (`{ poll: true }`, rule SpotQuoterPollRule). There is no Function URL.
 */
import { dispatch, type AppSyncIdentity } from './actions'
import { createSpotDeps, type SpotDeps } from './deps'
import { pollAll } from './poll'

interface SpotEvent {
  arguments?: { action?: unknown; input?: unknown }
  identity?: AppSyncIdentity | null
  poll?: boolean
}

let deps: SpotDeps | null = null

export const handler = async (event: SpotEvent): Promise<unknown> => {
  if (!event) return { ok: false, error: 'unrecognised event' }
  deps ??= createSpotDeps()

  if (event.arguments) {
    const action = typeof event.arguments.action === 'string' ? event.arguments.action : ''
    if (!action) throw new Error('action is required')
    return dispatch(action, event.arguments.input, event.identity, deps)
  }

  if (event.poll === true) {
    const result = await pollAll(deps)
    return { ok: true, polled: result.polled, skipped: result.skipped, stats: result.stats }
  }

  return { ok: false, error: 'pass { poll: true } or an AppSync action' }
}
