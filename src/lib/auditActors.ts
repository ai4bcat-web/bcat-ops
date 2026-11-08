/**
 * Who an AuditLog `user` value is. The Lambdas stamp `caller.email` (a person's login e-mail) or,
 * for automations, the service's own name; this file is the ONE table that turns those names into
 * the friendly agent names the Activity block prints.
 *
 *   person  -> the display name from the UserProfile cache
 *   agent   -> `AI agent · <name>` (an automation that reads or decides, or writes on someone's behalf)
 *   system  -> `System` (scheduled / mechanical jobs and portals with no person behind them)
 *
 * The keys are every automation actor literal the amplify functions write today (grep of the
 * writers: workflow-agent, tracking-automation, carrier-inbox, ap-inbox, shipment-email-intake,
 * dispatch-twilio-webhook, intake-reconcile, spot quoter, mcp-sync, aljex-import …).
 */
import { displayName } from './roles'

export type ActorKind = 'person' | 'agent' | 'system'

export interface ResolvedActor {
  kind: ActorKind
  /** The bare name: a person's display name, an agent's friendly name, or 'System'. */
  name: string
  /** What the row prints. */
  label: string
}

interface AutomationActor { kind: 'agent' | 'system'; name: string }

/** Lower-case audit `user` -> automation. Add a Lambda's actor here and nowhere else. */
export const AUTOMATION_ACTORS: Record<string, AutomationActor> = {
  'workflow-agent': { kind: 'agent', name: 'Workflow agent' },
  'tracking-automation': { kind: 'agent', name: 'Tracking agent' },
  'tracking-agent': { kind: 'agent', name: 'Tracking agent' },
  'check-call-notifier': { kind: 'agent', name: 'Check-call agent' },
  'carrier-inbox': { kind: 'agent', name: 'Carrier inbox agent' },
  'ap-inbox': { kind: 'agent', name: 'AP inbox agent' },
  'shipment-email-intake': { kind: 'agent', name: 'Intake extractor' },
  intake: { kind: 'agent', name: 'Intake extractor' },
  'intake-reconcile': { kind: 'agent', name: 'Intake extractor' },
  'dispatch-twilio-webhook': { kind: 'agent', name: 'Dispatch text agent' },
  'spot-quoter': { kind: 'agent', name: 'Spot quoter' },
  'shipment-notifier': { kind: 'agent', name: 'Shipment notifier' },
  'tms-dashboard-rollup': { kind: 'system', name: 'System' },
  'load-tracking-projector': { kind: 'system', name: 'System' },
  'compliance-scanner': { kind: 'system', name: 'System' },
  'mcp-sync': { kind: 'system', name: 'System' },
  'aljex-import': { kind: 'system', name: 'System' },
  carrier_portal: { kind: 'system', name: 'Carrier portal' },
  driver_portal: { kind: 'system', name: 'Driver portal' },
  'system@bcatcorp.com': { kind: 'system', name: 'System' },
}

/**
 * Router system callers all write `system@bcatcorp.com`; the audit ACTION says which Lambda it was.
 * Only consulted for that shared address.
 */
const SYSTEM_ADDRESS_BY_ACTION: Record<string, string> = {
  FILE_INBOUND_OFFER: 'carrier-inbox',
  INGEST_SHIPMENT_MESSAGE: 'shipment-email-intake',
  INGEST_ATTACHMENT: 'shipment-email-intake',
  RUN_TRACKING_AUTOMATION: 'tracking-automation',
  TRACKING_AUTOMATION_ERROR: 'tracking-automation',
}

export interface StaffLike { id: string; email: string; name?: string | null }

const SYSTEM: ResolvedActor = { kind: 'system', name: 'System', label: 'System' }

const fromTable = (a: AutomationActor): ResolvedActor =>
  a.kind === 'agent'
    ? { kind: 'agent', name: a.name, label: `AI agent · ${a.name}` }
    : { kind: 'system', name: a.name, label: a.name }

export function resolveActor(user: string | null | undefined, staff: readonly StaffLike[], action?: string): ResolvedActor {
  const key = (user ?? '').trim().toLowerCase()
  if (!key) return SYSTEM
  if (key === 'system@bcatcorp.com') {
    const hinted = action && Object.hasOwn(SYSTEM_ADDRESS_BY_ACTION, action) ? SYSTEM_ADDRESS_BY_ACTION[action] : undefined
    return fromTable(AUTOMATION_ACTORS[hinted ?? key]!)
  }
  if (Object.hasOwn(AUTOMATION_ACTORS, key)) return fromTable(AUTOMATION_ACTORS[key]!)
  const person = staff.find((p) => p.id.toLowerCase() === key || p.email.toLowerCase() === key)
  if (person) {
    const name = displayName(person)
    return { kind: 'person', name, label: name }
  }
  // A login e-mail with no profile row: the name its local part spells (same rule as the rep pickers).
  if (key.includes('@')) {
    const name = displayName(key)
    return { kind: 'person', name, label: name }
  }
  return { kind: 'person', name: 'Unknown user', label: 'Unknown user' }
}
