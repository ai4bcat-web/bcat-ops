/**
 * tms-crm-actions Lambda — see resource.ts. AppSync `tmsCrmActions(action, input)` only.
 */
import './tableEnv'
import { dispatch, type AppSyncIdentity } from './actions'

interface CrmEvent {
  arguments?: { action?: unknown; input?: unknown }
  identity?: AppSyncIdentity | null
}

export const handler = async (event: CrmEvent): Promise<unknown> => {
  const action = typeof event?.arguments?.action === 'string' ? event.arguments.action : ''
  if (!action) throw new Error('action is required')
  return dispatch(action, event.arguments?.input, event.identity)
}
