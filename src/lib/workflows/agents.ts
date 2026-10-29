/**
 * Step K — the agent catalogue.
 *
 * One descriptor per agent, naming the steps it is allowed to record, what it can
 * propose and the door a person applies that proposal through. Every other module in
 * this directory reads the vocabulary from here, so a run can never invent a step and
 * the Errors filter can never disagree with the trace rail about which agent is which.
 *
 * Lambdas bundle this file by relative path (`../../../src/lib/workflows/agents`), so
 * nothing in this directory may use the `@/` alias.
 */
import type { WorkflowAgentKey, WorkflowProposalKind } from '../../types/tms'

export type { WorkflowAgentKey }

export interface AgentDescriptor {
  key: WorkflowAgentKey
  label: string
  /** The inbox role the mail arrived on. Equal to `key` today; kept separate because
   *  CLASSIFY_EMAIL may re-route the agent while the role on the row stays put. */
  inboxRole: string
  /** In spec order. `beginStep` refuses anything outside this list. */
  steps: readonly string[]
  proposalKind: WorkflowProposalKind
  appliesVia: 'NEW_SHIPMENT' | 'NEW_QUOTE' | 'CARRIER_PAY' | 'VENDORS' | 'NONE'
  defaultInbox: string
  /** Role keys whose Errors tab opens on this agent's rows. Read by
   *  `defaultAgentsFor` in `exceptions.ts`; a seed for the filter, never a gate. */
  rolesByDefault: readonly string[]
}

/** The three roles that see every agent. Spelled once so the matrix cannot drift. */
const ALL_ROLES = ['ADMIN', 'MANAGER', 'COMPLIANCE'] as const

export const AGENTS: Record<WorkflowAgentKey, AgentDescriptor> = {
  QUOTE: {
    key: 'QUOTE',
    label: 'Quote',
    inboxRole: 'QUOTE',
    steps: ['RECEIVE_EMAIL', 'CLASSIFY_EMAIL', 'PARSE_QUOTE', 'MATCH_EMAIL_ENTITIES', 'PROPOSE_QUOTE'],
    proposalKind: 'QUOTE',
    appliesVia: 'NEW_QUOTE',
    defaultInbox: 'quotes@bcatcorp.com',
    rolesByDefault: [...ALL_ROLES, 'CUSTOMER_REP'],
  },
  TENDER: {
    key: 'TENDER',
    label: 'Tender',
    inboxRole: 'TENDER',
    steps: [
      'RECEIVE_EMAIL',
      'CLASSIFY_EMAIL',
      'PARSE_TENDER',
      'MATCH_EMAIL_ENTITIES',
      'MATCH_STOP',
      'PROPOSE_TENDER',
    ],
    proposalKind: 'TENDER',
    appliesVia: 'NEW_SHIPMENT',
    defaultInbox: 'tenders@bcatcorp.com',
    rolesByDefault: [...ALL_ROLES, 'CUSTOMER_REP'],
  },
  AP: {
    key: 'AP',
    label: 'AP',
    inboxRole: 'AP',
    // A vendor bill run overrides `proposalKind` to VENDOR_BILL on its own row; the
    // descriptor names the carrier-invoice case because that is the one with a door.
    steps: [
      'RECEIVE_EMAIL',
      'CLASSIFY_EMAIL',
      'PARSE_INVOICE',
      'MATCH_EMAIL_ENTITIES',
      'MATCH_DOCUMENTS',
      'PROPOSE_BILL',
    ],
    proposalKind: 'CARRIER_BILL',
    appliesVia: 'CARRIER_PAY',
    defaultInbox: 'ap@bcatcorp.com',
    rolesByDefault: [...ALL_ROLES, 'AR_AP', 'CARRIER_REP'],
  },
  CAPACITY: {
    key: 'CAPACITY',
    label: 'Capacity',
    inboxRole: 'CAPACITY',
    steps: ['RECEIVE_EMAIL', 'CLASSIFY_EMAIL', 'PARSE_CAPACITY', 'MATCH_EMAIL_ENTITIES', 'NOTE_CAPACITY'],
    proposalKind: 'CAPACITY',
    appliesVia: 'NONE',
    defaultInbox: 'capacity@bcatcorp.com',
    rolesByDefault: [...ALL_ROLES, 'CARRIER_REP'],
  },
  WEBHOOK: {
    key: 'WEBHOOK',
    label: 'Webhook',
    inboxRole: 'WEBHOOK',
    steps: ['RECEIVE_WEBHOOK', 'ROUTE_WEBHOOK'],
    proposalKind: 'NONE',
    appliesVia: 'NONE',
    // Webhooks arrive on a URL, not an address. Blank rather than a fictional inbox.
    defaultInbox: '',
    rolesByDefault: [...ALL_ROLES],
  },
}

export const AGENT_KEYS: readonly WorkflowAgentKey[] = ['QUOTE', 'TENDER', 'AP', 'CAPACITY', 'WEBHOOK']

export function stepsOf(agent: WorkflowAgentKey): readonly string[] {
  return AGENTS[agent].steps
}

export function isAgent(v: unknown): v is WorkflowAgentKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AGENTS, v)
}
