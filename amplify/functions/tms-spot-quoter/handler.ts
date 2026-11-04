/**
 * tms-spot-quoter Lambda — see resource.ts.
 *
 * Three doors: AppSync (`event.arguments`, the `tmsSpotActions` router), EventBridge
 * (`{ poll: true }`, rule SpotQuoterPollRule) and, for the Cowtown voice agent's call
 * summaries (Step AL), a Function URL (`event.requestContext.http`).
 */
import { dispatch, type AppSyncIdentity } from './actions'
import { createSpotDeps, type SpotDeps } from './deps'
import { pollAll, DEFAULT_BUDGET_MS } from './poll'
import { createCarrierInboxDeps, type CarrierInboxDeps } from './carrierInbox/deps'
import { CS_SCHEDULE_BUDGET_MS, pollCarrierInbox } from './carrierInbox/poll'
import { handleCarrierCall, type FunctionUrlEvent } from './carrierInbox/voice'

interface SpotEvent {
  arguments?: { action?: unknown; input?: unknown }
  identity?: AppSyncIdentity | null
  poll?: boolean
  requestContext?: FunctionUrlEvent['requestContext']
  rawPath?: string
  body?: string | null
  isBase64Encoded?: boolean
}

let deps: SpotDeps | null = null
let csDepsCache: CarrierInboxDeps | null = null
const csDeps = (): CarrierInboxDeps => (csDepsCache ??= createCarrierInboxDeps(deps as SpotDeps))

export const handler = async (event: SpotEvent): Promise<unknown> => {
  if (!event) return { ok: false, error: 'unrecognised event' }
  deps ??= createSpotDeps()

  if (event.arguments) {
    const action = typeof event.arguments.action === 'string' ? event.arguments.action : ''
    if (!action) throw new Error('action is required')
    return dispatch(action, event.arguments.input, event.identity, deps, csDeps)
  }

  if (event.requestContext?.http) return handleCarrierCall(event, csDeps())

  if (event.poll === true) {
    // The carrier inbox is small and org-critical: it goes first, the reps keep the rest.
    const cs = await pollCarrierInbox(csDeps(), { trigger: 'SCHEDULE', budgetMs: CS_SCHEDULE_BUDGET_MS })
      .catch((err: unknown) => {
        console.warn('[tms-spot-quoter] carrier inbox poll failed:', err instanceof Error ? err.message.slice(0, 200) : 'error')
        return { elapsedMs: CS_SCHEDULE_BUDGET_MS }
      })
    const result = await pollAll(deps, {}, DEFAULT_BUDGET_MS - cs.elapsedMs)
    return { ok: true, polled: result.polled, skipped: result.skipped, stats: result.stats }
  }

  return { ok: false, error: 'pass { poll: true } or an AppSync action' }
}
