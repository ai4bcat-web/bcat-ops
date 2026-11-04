/**
 * Step AG — Accounting > AP inbox sync. Shared contracts: pure TypeScript, relative imports
 * only, used by the Lambda (`amplify/functions/tms-ap-inbox`) and the browser alike.
 *
 * Everything here is data. The rules live in `match.ts` (scoring + decision) and
 * `applyPlan.ts` (what may be written onto a bill).
 */

export type ApInboxKind = 'INVOICE' | 'CREDIT_MEMO'
export type ApInboxStatus = 'NEEDS_REVIEW' | 'APPLIED' | 'LINKED' | 'CREATED' | 'DISMISSED'
export type ApInboxMode = 'GOOGLE' | 'SIMULATED'

/** Why an item is in the review queue. `AUTO_OFF` extends the plan: auto-apply switched off by an admin. */
export type ApReviewReason =
  | 'NO_MATCH'
  | 'LOW_CONFIDENCE'
  | 'AMBIGUOUS'
  | 'CONFLICT'
  | 'CREDIT'
  | 'REMIT_MISMATCH'
  | 'NO_BILL_YET'
  | 'STATUS'
  | 'RUN_CAP'
  | 'CHANGED_UNDERFOOT'
  | 'AI_UNSURE'
  | 'AUTO_OFF'

/** What the model said the mail is. Only INVOICE and CREDIT_MEMO are ever stored. */
export type ApMailKind = 'INVOICE' | 'CREDIT_MEMO' | 'STATEMENT' | 'PAYMENT_NOTICE' | 'OTHER'
export type ApConfidence = 'high' | 'medium' | 'low'

/** Everything normalised: cents, ISO dates, normalised PRO / MC / DOT. Never carries bank numbers. */
export interface ApExtraction {
  kind: ApMailKind
  confidence: ApConfidence
  reason: string
  issuer: { name: string | null; kind: 'CARRIER' | 'VENDOR' | 'UNKNOWN'; mc: string | null; dot: string | null }
  /** `normalizePro()` output, deduped, <= 5. */
  pros: string[]
  /** BOL / ref / load numbers as printed, <= 5. */
  otherRefs: string[]
  /** <= 64 chars (`bills.ts` `optionalString(billNumber, 64)`). */
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  termsDays: number | null
  amountCents: number | null
  /** text <= 300 chars, digit runs >= 6 stripped. */
  remitTo: { name: string | null; text: string | null } | null
  notes: string | null
  lowConfidence: string[]
}

export type SignalKey =
  | 'PRO'
  | 'REF'
  | 'INVOICE_NO'
  | 'CARRIER_MC'
  | 'CARRIER_DOT'
  | 'CARRIER_NAME'
  | 'CARRIER_FUZZY'
  | 'CARRIER_CONTRADICTS'
  | 'AMOUNT_EXACT'
  | 'AMOUNT_NEAR'
  | 'AMOUNT_FAR'
  | 'VENDOR_NAME'

export interface Signal {
  key: SignalKey
  points: number
  detail: string
}

export type CandidateVeto = 'CARRIER_CONTRADICTS' | 'REMIT_MISMATCH' | 'STATUS' | 'CREDIT'

export interface Candidate {
  targetKind: 'CARRIER_BILL' | 'LOAD_CARRIER' | 'VENDOR_PAYABLE'
  targetId: string
  billId?: string
  loadCarrierId?: string
  shipmentId?: string
  shipmentNumber?: string
  carrierId?: string
  carrierName?: string
  vendorName?: string
  status: string
  score: number
  signals: Signal[]
  vetoes: CandidateVeto[]
}

// ── Ledger: the open AP set the matcher reads (built once per run by `store.loadLedger()`) ─────

export type LedgerBillStatus = 'IN_REVIEW' | 'TO_BE_PAID' | 'PARTIAL'

export interface LedgerCarrier {
  id: string
  name: string
  dbaName?: string | null
  legalName?: string | null
  /** Other names the directory knows the carrier by. */
  aliases?: string[]
  mcNumber?: string | null
  dotNumber?: string | null
  remitToName?: string | null
}

/** An open `CarrierBill` plus the keys the matcher needs from its load and shipment. */
export interface LedgerBill {
  id: string
  status: LedgerBillStatus
  version: number
  loadCarrierId: string
  loadId: string
  shipmentId: string
  shipmentNumber?: string | null
  loadNumber?: string | null
  /** `Load.aljexId` — the Aljex PRO. */
  aljexId?: string | null
  /** Weak keys: `Load.pickupNumber`, `Load.tmsId`, `LoadCarrier.tripNumber`. */
  refs?: string[]
  carrierId: string
  carrierName?: string | null
  carrierMc?: string | null
  billNumber: string | null
  billDate: string
  billMonth: string
  dueAt: string
  termsDays: number
  billedCents: number
  grossCents: number
  paidCents: number
  creditedCents: number
  remitToName?: string | null
  /** Set once an AP-inbox mail has written to the bill (crash-repair marker). */
  apInboxItemId?: string | null
}

/** A `LoadCarrier` with `apStatus = AWAITING_INVOICE`: assigned, no bill yet. */
export interface LedgerAssignment {
  loadCarrierId: string
  loadId: string
  shipmentId: string
  shipmentNumber?: string | null
  aljexId?: string | null
  refs?: string[]
  carrierId: string
  carrierName?: string | null
  /** `carrierRateCents ?? costCents`. */
  rateCents: number | null
}

export interface LedgerVendorPayable {
  id: string
  /** Always `NEED_TO_PAY` in the ledger. */
  status: string
  vendor: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  /** Cents; null until an invoice was read. */
  amount: number | null
}

export interface Ledger {
  bills: LedgerBill[]
  assignments: LedgerAssignment[]
  vendorPayables: LedgerVendorPayable[]
  /** Directory carriers keyed by id (for MC/DOT/name resolution). */
  carriers: Record<string, LedgerCarrier>
  /** True when the open set was too big and carrier enrichment was skipped. */
  enrichmentSkipped?: boolean
}

// ── Config and state (TmsSettings.apInbox / apInboxState) ─────────────────────────────────────

export interface ApInboxConfig {
  enabled: boolean
  mode: ApInboxMode
  mailbox: string
  runHourChicago: number
  lookbackHours: number
  autoApply: boolean
  autoApplyMinScore: number
  reviewMinScore: number
  maxMessagesPerRun: number
  maxModelCallsPerRun: number
  maxAutoAppliesPerRun: number
  dismissedRetentionDays: number
  resolvedRetentionDays: number
  ignoreSenders: string[]
  version: number
}

export type ApConnectionStatus = 'NOT_CONNECTED' | 'PENDING' | 'CONNECTED' | 'NEEDS_RECONNECT' | 'SIMULATED'

export interface ApInboxConnection {
  status: ApConnectionStatus
  googleEmail: string | null
  connectedAt: string | null
  scopes: string[]
  lastError: string | null
  /** Never leave the Lambda. */
  pendingState?: string
  pendingStateExp?: string
}

export interface ApRunDigest {
  id: string
  trigger: 'SCHEDULE' | 'MANUAL' | 'SIM'
  startedAt: string
  endedAt: string
  listed: number
  reviewed: number
  stage1Rejected: number
  stage2Rejected: number
  modelCalls: number
  notInvoice: number
  invoices: number
  applied: number
  updatedBills: number
  needReview: number
  errors: number
  abandoned: number
  partial: boolean
  error?: 'NEEDS_RECONNECT' | 'AGENT_DISABLED' | 'NOT_CONFIGURED' | 'MODEL_CAP' | string
}

export interface ApInboxState {
  connection: ApInboxConnection
  /** `boundaryIds`: ids whose internalDate == afterMs (<= 50). */
  cursor: { afterMs: number; boundaryIds: string[] } | null
  /** <= 50; dropped after 3 tries (counted as abandoned). */
  retry: { id: string; tries: number; lastAt: string; code: string }[]
  /** Run lock; stale after 6 minutes. */
  runningAt?: string
  /** Chicago YYYY-MM-DD of the last scheduled run that completed. */
  lastScheduledDay?: string
  gapNote?: string
  /** Newest first, <= 14. */
  runs: ApRunDigest[]
}

// ── The stored review item (ApInboxItem row, as the client and Lambda see it) ─────────────────

export interface ApInboxMatchRecord {
  top: Candidate | null
  candidates: Candidate[]
  score: number
  signals: Signal[]
  vetoes: CandidateVeto[]
}

export interface ApInboxTarget {
  kind: 'CARRIER_BILL' | 'LOAD_CARRIER' | 'VENDOR_PAYABLE'
  id: string
  billId?: string
  loadCarrierId?: string
  shipmentId?: string
  vendorPayableId?: string
}

export interface ApAppliedRecord {
  at: string
  by: string
  mode: 'AUTO' | 'HUMAN'
  /** The allow-listed columns only. `version` is the bill version before/after the write. */
  before: Record<string, string | number | null>
  after: Record<string, string | number | null>
  fields: string[]
}

export interface ApInboxAttachmentRef {
  key: string
  name: string
  contentType: string
  size: number
  sha256?: string
  documentId?: string
}

export interface ApInboxItemRecord {
  id: string
  messageId: string
  threadId?: string | null
  mailbox?: string | null
  mode?: ApInboxMode | null
  receivedAt: string
  fromEmail?: string | null
  fromName?: string | null
  subject?: string | null
  kind: ApInboxKind
  status: ApInboxStatus
  reviewReason?: ApReviewReason | null
  extraction: ApExtraction
  match?: ApInboxMatchRecord | null
  target?: ApInboxTarget | null
  applied?: ApAppliedRecord | null
  attachments?: ApInboxAttachmentRef[] | null
  sourceUrl?: string | null
  runId?: string | null
  resolvedAt?: string | null
  resolvedBy?: string | null
  dismissReason?: string | null
  ttlEpoch?: number | null
  version: number
}
