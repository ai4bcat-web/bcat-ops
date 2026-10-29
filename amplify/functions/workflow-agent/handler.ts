/**
 * workflow-agent Lambda — see resource.ts.
 *
 * One function, four doors:
 *   - AppSync (`event.arguments`)        the `tmsWorkflowActions` router,
 *   - Function URL (`requestContext`)    the mailbox bridge's prepare/commit,
 *   - async invoke (`event.runFor`)      a bridge handing one message over,
 *   - EventBridge (`event.sweep`)        the stalled-run sweep.
 *
 * Plus the back door it inherited: `{ id }` and `{ all: true }` are the old
 * `vendor-ap-extract` payloads. `vendor-ap-intake` still sends `{ id }` from
 * deployed code, and the env var now points here, so a deploy that lands the
 * two functions in either order must not drop an invoice on the floor.
 */
import { dispatch, type AppSyncIdentity } from './actions'
import { handleInbox, type FnUrlEvent } from './inbox'
import { backfillAp, runFor, sweepStalled, type RunForInput } from './run'

/**
 * Every shape AWS can hand this function, in one type. Which door was used is
 * decided by which field is present — the fields themselves are checked where
 * they are read.
 */
interface AgentEvent extends FnUrlEvent {
  arguments?: { action?: unknown; input?: unknown }
  identity?: AppSyncIdentity | null
  runFor?: RunForInput
  sweep?: boolean
  /** vendor-ap-extract back-compat: a single VendorPayable row id. */
  id?: string
  /** vendor-ap-extract back-compat: the whole-queue backfill. */
  all?: boolean
}

export const handler = async (event: AgentEvent): Promise<unknown> => {
  if (!event) return { ok: false, error: 'unrecognised event' }

  if (event.arguments) {
    const action = typeof event.arguments.action === 'string' ? event.arguments.action : ''
    if (!action) throw new Error('action is required')
    return dispatch(action, event.arguments.input, event.identity)
  }

  if (event.requestContext?.http) return handleInbox(event)

  if (event.runFor) {
    const run = await runFor(event.runFor)
    return { ok: true, id: run.id, status: run.status, outcome: run.outcome ?? null }
  }

  if (event.sweep === true) return sweepStalled()

  if (typeof event.id === 'string' && event.id) {
    const run = await runFor({ sourceKind: 'VENDOR_PAYABLE', sourceId: event.id, inboxRole: 'AP', provider: 'GMAIL' })
    return { ok: true, id: run.id, result: run.outcome ?? run.status }
  }
  if (event.all === true) return backfillAp()

  return { ok: false, error: 'pass { runFor }, { sweep: true }, { id } or { all: true }' }
}
