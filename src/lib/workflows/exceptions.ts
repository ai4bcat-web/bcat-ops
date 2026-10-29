/**
 * Step K — the Errors tab's one list.
 *
 * Everything that is stuck lands in the same shape no matter which subsystem produced
 * it, so a dispatcher reads one list instead of hunting four pages. The derivation is
 * pure and deterministic given `nowIso`: the same inputs always produce the same rows
 * in the same order, which is what makes the counts on the quick tabs trustworthy.
 *
 * The unknown-customer rule is `isCustomerUnresolved` and nothing else. A second
 * spelling of "do we know the customer" is how a DELIVERED-but-unresolved shipment
 * walks into AR, so the rule is imported, never re-derived.
 */
import { AGENTS, AGENT_KEYS } from './agents'
import { MAX_ATTEMPTS, retryable } from './runState'
import { customerDisplayName, isCustomerUnresolved } from '../customerResolution'
import { descriptorOf } from '../integrations/registry'
import type { WorkflowAgentKey, WorkflowRunRecord } from '../../types/tms'

export type ExceptionKind = 'AI' | 'UNKNOWN_CUSTOMER' | 'TRACKING' | 'ACCOUNTING' | 'PARADE' | 'EDI' | 'INTEGRATION'

export interface ExceptionAction {
  key: 'RETRY' | 'RECHECK' | 'RESOLVE' | 'IDENTIFY_CUSTOMER' | 'RESEND_LINK' | 'TEXT_DRIVER' | 'LOG_CHECK_CALL' | 'OPEN'
  label: string
  /** Present when the action is offered but refused, so the row says why. */
  disabledReason?: string
}

export interface ExceptionRow {
  id: string
  at: string
  kind: ExceptionKind
  runId?: string | null
  /** Which agent produced an AI row. Null on every other kind; the per-role default
   *  filter narrows AI rows by agent, so the row has to carry it. */
  agent?: WorkflowAgentKey | null
  shipmentId?: string | null
  shipmentNumber?: string | null
  party: string
  integration: string
  error: string
  href?: string | null
  actions: ExceptionAction[]
}

/**
 * The rows are read structurally rather than as full records: the Lambda passes real
 * `ShipmentRecord` / `Load` / `TrackingLinkRecord` rows, and a test can build the six
 * fields a rule actually reads without inventing a whole shipment.
 */
export interface ExceptionShipment {
  id: string
  number?: string | null
  status?: string | null
  customerId?: string | null
  customerName?: string | null
  voidedAt?: string | null
  updatedAt?: string | null
}

export interface ExceptionLoad {
  id: string
  shipmentId?: string | null
  shipmentNumber?: string | null
  status?: string | null
  carrierName?: string | null
  checkCallOpen?: string | null
  nextCheckCallAt?: string | null
}

export interface ExceptionTrackingLink {
  id: string
  kind?: string | null
  status?: string | null
  shipmentId?: string | null
  loadId?: string | null
  sentAt?: string | null
  lastPingAt?: string | null
  contactName?: string | null
  /**
   * Where the freight this link tracks has got to, when the caller knows it without the
   * load row being in `loads` — the Errors tab's `loads` are only the ones with an open
   * check call, and the parent shipment's status carries the same movement vocabulary.
   * Without it the second half of the tracking rule would never see a silent truck that
   * nobody had set a check-call reminder on.
   */
  movementStatus?: string | null
  /** The row label, for the same reason: the load row may not be in `loads`. */
  shipmentNumber?: string | null
}

export interface ExceptionIntegration {
  id: string
  provider: string
  kind?: string | null
  category?: string | null
  health?: string | null
  healthReason?: string | null
  healthDetail?: string | null
  lastCheckAt?: string | null
  updatedAt?: string | null
}

export interface ExceptionInput {
  runs: WorkflowRunRecord[]
  shipments: ExceptionShipment[]
  loads: ExceptionLoad[]
  trackingLinks: ExceptionTrackingLink[]
  integrations: ExceptionIntegration[]
  settings: { trackingIntervalMin?: number | null } | null
  nowIso: string
}

export const EXCEPTION_TABS: readonly { key: ExceptionKind | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'AI', label: 'AI agents' },
  { key: 'ACCOUNTING', label: 'Accounting' },
  { key: 'TRACKING', label: 'Tracking' },
  { key: 'PARADE', label: 'Parade' },
  { key: 'UNKNOWN_CUSTOMER', label: 'Unknown customers' },
  { key: 'EDI', label: 'EDI' },
  { key: 'INTEGRATION', label: 'Integrations' },
]

const ALL_KINDS: readonly ExceptionKind[] = [
  'AI',
  'UNKNOWN_CUSTOMER',
  'TRACKING',
  'ACCOUNTING',
  'PARADE',
  'EDI',
  'INTEGRATION',
]

/** A load is trackable only while it is actually moving. */
const MOVING_STATUSES: readonly string[] = [
  'DISPATCHED',
  'LOADING',
  'PICKED_UP',
  'IN_TRANSIT',
  'RECOVERED',
  'ARRIVED_AT_DELIVERY_TERMINAL',
  'OUT_FOR_DELIVERY',
]

/** Health reasons that mean "nothing is wrong here", so they are never an exception. */
const BENIGN_HEALTH_REASONS: readonly string[] = ['NEUTERED_ON_DEV', 'NO_CREDENTIALS', 'NOT_APPLICABLE']

const DEFAULT_TRACKING_INTERVAL_MIN = 30

const ACCOUNTING_PREVIEW_REASON = 'QuickBooks sync is preview-only until it is live'

function defaultActionsFor(kind: ExceptionKind): ExceptionAction[] {
  switch (kind) {
    case 'AI':
      return [
        { key: 'RETRY', label: 'Retry' },
        { key: 'RESOLVE', label: 'Resolve' },
      ]
    case 'UNKNOWN_CUSTOMER':
      return [{ key: 'IDENTIFY_CUSTOMER', label: 'Identify customer' }]
    case 'TRACKING':
      return [
        { key: 'RESEND_LINK', label: 'Resend link' },
        { key: 'TEXT_DRIVER', label: 'Text driver' },
        { key: 'LOG_CHECK_CALL', label: 'Log check call' },
      ]
    case 'ACCOUNTING':
      return [{ key: 'RECHECK', label: 'Re-check', disabledReason: ACCOUNTING_PREVIEW_REASON }]
    case 'EDI':
      // Orderful failures are fixed at Orderful; there is nothing to press here.
      return []
    default:
      return [{ key: 'RECHECK', label: 'Re-check' }]
  }
}

/** Why Retry is refused, or null when it is offered. */
function retryRefusal(run: WorkflowRunRecord): string | null {
  if (retryable(run)) return null
  if (run.outcome === 'APPLIED') return 'This run was already applied'
  if ((run.attempts ?? 0) >= MAX_ATTEMPTS) return `Retried ${MAX_ATTEMPTS} times already`
  return 'This run did not fail'
}

function aiError(run: WorkflowRunRecord): string {
  if (run.error) return run.error
  if (run.outcome === 'UNKNOWN_PARTY') return 'Sender was not matched to a customer or carrier'
  return run.errorCode ?? 'The run stopped without finishing'
}

function olderThan(iso: string | null | undefined, nowMs: number, minutes: number): boolean {
  if (!iso) return false
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return false
  return nowMs - at > minutes * 60_000
}

/** `PARADE` is its own tab even though its provider category is CAPACITY. */
function integrationKindOf(row: ExceptionIntegration): ExceptionKind {
  if (row.provider === 'PARADE') return 'PARADE'
  const category = row.category ?? descriptorOf(row.provider)?.category ?? null
  if (category === 'ACCOUNTING') return 'ACCOUNTING'
  if (category === 'EDI') return 'EDI'
  return 'INTEGRATION'
}

export function collectExceptions(input: ExceptionInput): ExceptionRow[] {
  const rows: ExceptionRow[] = []
  const nowMs = Date.parse(input.nowIso)

  for (const run of input.runs) {
    if (run.exceptionOpen !== 'OPEN') continue
    const refusal = retryRefusal(run)
    rows.push({
      id: `run:${run.id}`,
      at: run.updatedAt ?? run.endedAt ?? run.createdAt ?? input.nowIso,
      kind: 'AI',
      runId: run.id,
      agent: run.agent,
      shipmentId: run.shipmentId ?? null,
      shipmentNumber: run.shipmentNumber ?? null,
      party: run.partyName ?? run.fromEmail ?? run.fromName ?? '—',
      integration: `${AGENTS[run.agent].label} agent`,
      error: aiError(run),
      href: `/tms/workflows/runs/${run.id}`,
      actions: [
        { key: 'RETRY', label: 'Retry', ...(refusal ? { disabledReason: refusal } : {}) },
        { key: 'RESOLVE', label: 'Resolve' },
      ],
    })
  }

  for (const shipment of input.shipments) {
    // Void and cancel are dispositions, not gaps: the freight is not going anywhere
    // and nobody needs to go find out whose it was.
    if (shipment.voidedAt) continue
    if (shipment.status === 'CANCELED') continue
    if (!isCustomerUnresolved(shipment)) continue
    rows.push({
      id: `shipment:${shipment.id}`,
      at: shipment.updatedAt ?? input.nowIso,
      kind: 'UNKNOWN_CUSTOMER',
      shipmentId: shipment.id,
      shipmentNumber: shipment.number ?? null,
      party: customerDisplayName(shipment),
      integration: 'Unknown customers',
      error: 'No customer record is linked to this shipment',
      href: `/tms/shipments/${shipment.id}`,
      actions: defaultActionsFor('UNKNOWN_CUSTOMER'),
    })
  }

  const loadsById = new Map<string, ExceptionLoad>()
  for (const load of input.loads) loadsById.set(load.id, load)

  for (const load of input.loads) {
    if (!load.checkCallOpen) continue
    if (!load.nextCheckCallAt) continue
    const due = Date.parse(load.nextCheckCallAt)
    if (!Number.isFinite(due) || due >= nowMs) continue
    rows.push({
      id: `load:${load.id}:check-call`,
      at: load.nextCheckCallAt,
      kind: 'TRACKING',
      shipmentId: load.shipmentId ?? null,
      shipmentNumber: load.shipmentNumber ?? null,
      party: load.carrierName ?? '—',
      integration: 'Tracking',
      error: `Check call was due ${load.nextCheckCallAt}`,
      href: load.shipmentId ? `/tms/shipments/${load.shipmentId}` : null,
      actions: defaultActionsFor('TRACKING'),
    })
  }

  const staleAfterMin = (input.settings?.trackingIntervalMin ?? DEFAULT_TRACKING_INTERVAL_MIN) * 3
  for (const link of input.trackingLinks) {
    if (link.kind !== 'CARRIER_PING' || link.status !== 'ACTIVE') continue
    const load = link.loadId ? loadsById.get(link.loadId) : undefined
    // The load row is the better source for the status, but it is only here when the
    // caller happened to be listing that load; the link's own `movementStatus` keeps the
    // rest of the board in the rule rather than silently dropping it.
    if (!MOVING_STATUSES.includes(load?.status ?? link.movementStatus ?? '')) continue
    // Never pinged counts from when the link was sent; a link nobody has sent yet is
    // not late, it has not started.
    const last = link.lastPingAt ?? link.sentAt ?? null
    if (!olderThan(last, nowMs, staleAfterMin)) continue
    rows.push({
      id: `link:${link.id}`,
      at: last ?? input.nowIso,
      kind: 'TRACKING',
      shipmentId: link.shipmentId ?? load?.shipmentId ?? null,
      shipmentNumber: load?.shipmentNumber ?? link.shipmentNumber ?? null,
      party: link.contactName ?? load?.carrierName ?? '—',
      integration: 'Tracking',
      error: `No position ping in over ${staleAfterMin} minutes`,
      href: link.shipmentId ? `/tms/shipments/${link.shipmentId}` : null,
      actions: defaultActionsFor('TRACKING'),
    })
  }

  for (const row of input.integrations) {
    if (row.kind !== 'PROVIDER') continue
    if (row.health !== 'INVALID_CREDENTIALS' && row.health !== 'UNABLE_TO_VERIFY') continue
    if (BENIGN_HEALTH_REASONS.includes(row.healthReason ?? '')) continue
    const kind = integrationKindOf(row)
    rows.push({
      id: `integration:${row.id}`,
      at: row.lastCheckAt ?? row.updatedAt ?? input.nowIso,
      kind,
      party: '—',
      integration: descriptorOf(row.provider)?.label ?? row.provider,
      error: row.healthDetail ?? row.healthReason ?? row.health,
      href: `/tms/brokerage/integrations/${row.provider}`,
      actions: defaultActionsFor(kind),
    })
  }

  // Newest first, with the id as a tie-break so the order is total and stable.
  return rows.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : (a.at < b.at ? 1 : -1)))
}

export function countsByIntegration(rows: ExceptionRow[]): Record<ExceptionKind | 'ALL', number> {
  const counts: Record<ExceptionKind | 'ALL', number> = {
    ALL: rows.length,
    AI: 0,
    UNKNOWN_CUSTOMER: 0,
    TRACKING: 0,
    ACCOUNTING: 0,
    PARADE: 0,
    EDI: 0,
    INTEGRATION: 0,
  }
  for (const row of rows) counts[row.kind] += 1
  return counts
}

/** Owner and the three all-seeing roles. Spelled once; both seeds below read it. */
function seesEverything(groups: string[]): boolean {
  return (
    groups.includes('owner') ||
    groups.includes('role-ADMIN') ||
    groups.includes('role-MANAGER') ||
    groups.includes('role-COMPLIANCE')
  )
}

/** Which kinds a person's Errors tab opens on. Removable: this is a seed, not a gate. */
export function defaultFilterFor(groups: string[]): ExceptionKind[] {
  if (seesEverything(groups)) return [...ALL_KINDS]

  const kinds: ExceptionKind[] = []
  const add = (list: readonly ExceptionKind[]) => {
    for (const kind of list) if (!kinds.includes(kind)) kinds.push(kind)
  }
  if (groups.includes('role-AR_AP')) add(['ACCOUNTING', 'AI'])
  if (groups.includes('role-CUSTOMER_REP')) add(['AI', 'UNKNOWN_CUSTOMER', 'EDI'])
  if (groups.includes('role-CARRIER_REP')) add(['AI', 'TRACKING', 'PARADE'])

  // No role group at all means nobody has narrowed this person's view yet.
  return kinds.length > 0 ? kinds : [...ALL_KINDS]
}

/**
 * The other half of the same default: which agents' AI rows open. "AI" as one kind is
 * too coarse for acceptance A4 — AR/AP want the AP agent's rows, a customer rep wants
 * quote and tender, a carrier rep wants AP and capacity — and the matrix that says so
 * lives on the agent descriptors, so adding an agent is one edit there and none here.
 *
 * Still a seed, never a refusal: a role nobody mapped sees every agent, and dropping
 * the chips widens past this the same way it widens past the kinds.
 */
export function defaultAgentsFor(groups: string[]): WorkflowAgentKey[] {
  if (seesEverything(groups)) return [...AGENT_KEYS]

  const roles = groups.filter((g) => g.startsWith('role-')).map((g) => g.slice('role-'.length))
  if (roles.length === 0) return [...AGENT_KEYS]

  const agents = AGENT_KEYS.filter((key) => AGENTS[key].rolesByDefault.some((role) => roles.includes(role)))
  return agents.length > 0 ? agents : [...AGENT_KEYS]
}

/**
 * The actions a row offers. `collectExceptions` already knows why a particular Retry
 * is refused, so its list wins; the kind's defaults are the fallback for a row
 * assembled anywhere else.
 */
export function actionsFor(row: ExceptionRow): ExceptionAction[] {
  return row.actions.length > 0 ? row.actions : defaultActionsFor(row.kind)
}
