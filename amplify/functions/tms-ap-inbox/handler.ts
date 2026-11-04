/**
 * tms-ap-inbox Lambda — see resource.ts.
 *
 * Two doors: AppSync (`event.arguments`, the `tmsApInboxActions` router) and EventBridge
 * (`{ sync: true, scheduled: true }`, rule ApInboxHourlyRule: hourly, the run itself is gated to
 * the configured Chicago hour or to finishing a partial run). `{ sync: true }` without
 * `scheduled` is a direct invoke (the dev harness): the same run, manual trigger.
 */
import { dispatch, type AppSyncIdentity } from './actions'
import { createApInboxDeps } from './deps'
import type { ApInboxDeps } from './contract'
import { runSync, SCHEDULED_BUDGET_MS } from './sync'

interface ApInboxEvent {
  arguments?: { action?: unknown; input?: unknown }
  identity?: AppSyncIdentity | null
  sync?: boolean
  scheduled?: boolean
}

let deps: ApInboxDeps | null = null

export const handler = async (event: ApInboxEvent): Promise<unknown> => {
  if (!event) return { ok: false, error: 'unrecognised event' }
  deps ??= createApInboxDeps()

  if (event.arguments) {
    const action = typeof event.arguments.action === 'string' ? event.arguments.action : ''
    if (!action) throw new Error('action is required')
    return dispatch(action, event.arguments.input, event.identity, deps)
  }

  if (event.sync === true) {
    const result = await runSync(deps, { trigger: event.scheduled === true ? 'SCHEDULE' : 'MANUAL', budgetMs: SCHEDULED_BUDGET_MS })
    return { ok: true, skipped: result.skipped ?? null, done: result.done, reviewed: result.reviewed, remaining: result.remaining }
  }

  return { ok: false, error: 'pass { sync: true } or an AppSync action' }
}
