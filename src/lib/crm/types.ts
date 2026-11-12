/**
 * Step AB — CRM contract types shared by the CRM Lambda, the spot Lambda and the UI.
 * Row shapes live in `src/types/tms.ts` (Step AB block); this file holds the action
 * contract and the pure-function value types (§5.3, §5.4, §5.6, §9.4).
 */
import type {
  CrmAccountRecord,
  CrmActivityKind,
  CrmActivityRecord,
  CrmContactRecord,
  CrmContactSource,
  CrmDomainRecord,
  CrmDomainSource,
} from '../../types/tms'

export type {
  CrmAccountRecord,
  CrmActivityKind,
  CrmActivityRecord,
  CrmContactRecord,
  CrmContactSource,
  CrmDomainRecord,
  CrmDomainSource,
}

// ── Matching an address to an account (§5.3) ─────────────────────────────────
export type SenderMatchHow = 'EMAIL' | 'DOMAIN' | 'AMBIGUOUS' | 'NONE'

export interface SenderMatchCandidate {
  customerId: string
  how: 'EMAIL' | 'DOMAIN'
}

export interface SenderMatch {
  how: SenderMatchHow
  customerId?: string
  contact?: CrmContactRecord
  /** ≤ 3 */
  candidates: SenderMatchCandidate[]
  /** Set when SPF/DKIM did not verify aligned and the match was downgraded to a candidate. */
  authDowngrade?: boolean
}

// ── Viewer (§5.6): derived from `cognito:groups` exactly as other Lambdas' authorize() ──
export interface CrmViewer {
  id: string
  role: string | null
  isOwnerOrAdmin: boolean
}

// ── Stage-entry derivations ──────────────────────────────────────────────────
export const CRM_LEAD_STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'NURTURING'] as const
export type CrmPromotion = 'PROMOTE' | 'ALREADY_ACTIVE' | 'REFUSE'

// ── System activity writes (the §9.4 store contract) ────────────────────────
export type CrmSystemActivityKind = 'EMAIL_IN' | 'EMAIL_OUT' | 'QUOTE_DRAFTED' | 'QUOTE_SENT'

export interface CrmActivityRefsInput {
  spotRequestId?: string
  quoteId?: string
  shipmentId?: string
  gmailThreadId?: string
}

export interface UpsertContactInput {
  email: string
  customerId?: string
  name?: string
  ownerId: string
  source: CrmContactSource
}

export interface AddSystemActivityInput {
  customerId?: string
  contactEmail?: string
  ownerId: string
  kind: CrmSystemActivityKind
  at: string
  subject?: string
  refs: CrmActivityRefsInput
}

/**
 * `_shared/crmStore.ts` (slice 4), imported by path from the spot Lambda. `db` is the
 * DynamoDB DocumentClient the Lambda already holds; typed `unknown` here so this file
 * stays dependency-free.
 */
export interface CrmStoreContract<Db = unknown> {
  upsertContact(db: Db, input: UpsertContactInput): Promise<CrmContactRecord>
  addSystemActivity(db: Db, input: AddSystemActivityInput): Promise<void>
  lookupSender(db: Db, address: string, authVerdict?: string | null): Promise<SenderMatch>
}

// ── tmsCrmActions actions (§5.4) ─────────────────────────────────────────────
export type CrmActionName =
  | 'CRM_GET_ACCOUNT'
  | 'CRM_LIST_ACCOUNTS'
  | 'CRM_ADD_ACTIVITY'
  | 'CRM_ADD_TASK'
  | 'CRM_COMPLETE_TASK'
  | 'CRM_SET_NEXT_STEP'
  | 'CRM_LIST_FOLLOWUPS'
  | 'CRM_UPSERT_CONTACT'
  | 'CRM_CLAIM_DOMAIN'
  | 'CRM_ASSIGN_OWNER'
  | 'CRM_BACKFILL'
  // Step AI: dashboards ride the CRM router; read verbs first so apiClient treats the reads as reads.
  | 'PREVIEW_DASHBOARD_CHAT' | 'PREVIEW_ASSISTANT_CHAT'
  | 'PREVIEW_DASHBOARD'
  | 'LIST_DASHBOARDS'
  | 'GET_DASHBOARD'
  | 'GET_DASHBOARD_OPTIONS'
  | 'SAVE_DASHBOARD'
  | 'ARCHIVE_DASHBOARD'

export interface CrmTimelineEntry {
  id: string
  at: string
  kind: CrmActivityKind | 'QUOTE_CREATED' | 'QUOTE_SENT_DERIVED' | 'QUOTE_WON' | 'QUOTE_LOST' | 'SHIPMENT_CREATED' | 'STAGE_CHANGE'
  direction?: 'IN' | 'OUT' | null
  /** E-mail kinds carry `subject: null, restricted: true` for viewers who may not see it. */
  subject?: string | null
  restricted?: boolean
  summary?: string | null
  actorId?: string | null
  amountCents?: number | null
  /** Rows computed from Quote / Shipment / Customer rather than stored. */
  derived?: boolean
  refs?: { quoteId?: string; shipmentId?: string; spotRequestId?: string; gmailThreadId?: string } | null
}

export interface CrmAccountView {
  account: CrmAccountRecord | null
  owner: { id: string; name: string | null; email: string | null } | null
  stage: string | null
  contacts: (CrmContactRecord & { origin: 'CRM' | 'CUSTOMER_JSON' | 'BOTH' })[]
  timeline: CrmTimelineEntry[]
  openTasks: CrmActivityRecord[]
  domains: CrmDomainRecord[]
  derived: { lastTouchAt: string | null; lastQuoteAt: string | null; lastShipmentAt: string | null }
  /** False when the viewer may not see CRM detail for this account (§5.6). */
  visible: boolean
}

export interface CrmFollowUpRow {
  customerId: string
  customerName: string | null
  ownerId: string | null
  nextStep: string | null
  nextStepDueAt: string | null
  openTasks: CrmActivityRecord[]
  overdue: boolean
}

export interface CrmListAccountRow {
  customerId: string
  ownerId: string | null
  stage: string | null
  lastTouchAt: string | null
  lastTouchKind: CrmActivityKind | null
  nextStep: string | null
  nextStepDueAt: string | null
  openTaskCount: number
  /** Only when the list was asked `withActivity`: open invoice balance, and the newest shipment pickup. */
  openArCents?: number
  lastShipmentAt?: string | null
  /** Only with `withActivity`: shipments done for the customer, all-time, voided/canceled left out. */
  shipmentCount?: number
}
