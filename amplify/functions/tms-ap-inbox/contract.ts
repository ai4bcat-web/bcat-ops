/**
 * Step AG §4 — the seams of `tms-ap-inbox`. Everything S3 (core) and S4 (actions) code against;
 * `memoryStore.ts` implements `ApInboxStore` in memory so both slices test against the same fake.
 *
 * The two bill write paths (`updateCarrierBill`, `updateVendorPayable`) are the ONLY ways this
 * Lambda changes an AP row. Each takes a typed patch and drops every key outside the D8 allow-list
 * (`BILL_WRITABLE_COLUMNS` / `VENDOR_WRITABLE_COLUMNS`); the provenance/bookkeeping columns are
 * added by the store itself.
 */
import type { MailboxPort } from '../../../src/lib/apInbox/mailbox'
import type { BillColumn, VendorColumn } from '../../../src/lib/apInbox/applyPlan'
import type { RawApModelOutput } from '../../../src/lib/apInbox/normalize'
import type {
  ApInboxConfig,
  ApInboxItemRecord,
  ApInboxMode,
  ApInboxState,
  ApInboxStatus,
  Ledger,
  LedgerAssignment,
  LedgerBill,
  LedgerBillStatus,
  LedgerCarrier,
  LedgerVendorPayable,
} from '../../../src/lib/apInbox/types'
import type { OAuthPort, SimPorts } from '../tms-spot-quoter/deps'

/** Provenance written with every AP-row update. */
export interface ApWriteAudit {
  itemId: string
  sourceUrl: string
  /** ISO instant. */
  at: string
}

export interface ApAuditEntry {
  entityType: 'CarrierBill' | 'VendorPayable' | 'ApInboxItem'
  entityId: string
  /** AP_INBOX_APPLIED | AP_INBOX_LINKED | AP_INBOX_REVERTED | AP_INBOX_DISMISSED | AP_INBOX_VENDOR_BILL_CREATED */
  action: string
  actor: string
  /** Ids, field names, before/after of the allowed columns, messageUrl, score, signals — never body text. */
  changes: Record<string, unknown>
}

export interface ApShipmentDocumentInput {
  shipmentId: string
  /** `CARRIER_INVOICE`, filed as a PENDING pointer row (`source:'UPLOAD'`, `uploadedBy:'ap-inbox'`). */
  type: 'CARRIER_INVOICE'
  s3Key: string
  name: string
  contentType: string
  size: number
  /** `ap-inbox:<itemId>` */
  sourceRef: string
}

export interface ApVendorPayableInput {
  id: string
  subject: string
  vendor: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  amount: number | null
  description: string | null
  fromEmail: string | null
  receivedAt: string
  sourceMessageId: string
  attachments: { key: string; name: string; contentType: string; size: number }[]
}

export interface ApInboxStore {
  // ── config + state (TmsSettings.apInbox / apInboxState, UpdateItem SET only) ──
  /** Always a fully resolved config (`resolveApInboxConfig`). */
  getConfig(): Promise<ApInboxConfig>
  /** CAS on `version`; false when `expectedVersion` is stale. Writes `config` with version+1. */
  putConfig(config: ApInboxConfig, expectedVersion: number): Promise<boolean>
  getState(): Promise<ApInboxState>
  /** Shallow merge of the given top-level keys. */
  patchState(patch: Partial<ApInboxState>): Promise<void>
  /** Conditional claim of `runningAt`: true when no live lock (none, or older than `staleBefore`). */
  claimRun(now: Date, staleBefore: Date): Promise<boolean>
  releaseRun(): Promise<void>

  // ── items ──
  /** Conditional put (`attribute_not_exists(id)`): false when the message was already filed. */
  putItemIfAbsent(item: ApInboxItemRecord): Promise<boolean>
  getItem(id: string): Promise<ApInboxItemRecord | null>
  /** CAS on `version` (+ optional status guard); returns the new row, or null when the condition failed. */
  updateItem(
    id: string,
    patch: Partial<Omit<ApInboxItemRecord, 'id' | 'version'>>,
    o: { expectedVersion: number; statusIn?: ApInboxStatus[] },
  ): Promise<ApInboxItemRecord | null>
  /** Newest `receivedAt` first. `sinceIso` bounds `receivedAt` from below. */
  listByStatus(status: ApInboxStatus, o?: { sinceIso?: string; limit?: number }): Promise<ApInboxItemRecord[]>

  // ── the AP world ──
  /** Open bills + AWAITING assignments + NEED_TO_PAY payables + enrichment, built once per run. */
  loadLedger(): Promise<Ledger>
  getBill(id: string): Promise<LedgerBill | null>
  getAssignment(loadCarrierId: string): Promise<LedgerAssignment | null>
  getVendorPayable(id: string): Promise<LedgerVendorPayable | null>
  getCarrier(id: string): Promise<LedgerCarrier | null>
  /**
   * Conditional write: `version = expectedVersion AND status = expectedStatus AND paidCents = 0 AND
   * creditedCents = 0`. Returns the new version, or null when the condition failed. Only
   * `BILL_WRITABLE_COLUMNS` are written (+ provenance, `version+1`, `updatedAt`, `updatedBy:'ap-inbox'`).
   */
  updateCarrierBill(
    id: string,
    set: Partial<Record<BillColumn, string | number>>,
    o: { expectedVersion: number; expectedStatus: LedgerBillStatus; audit: ApWriteAudit },
  ): Promise<{ version: number } | null>
  /** Restore for AP_INBOX_REVERT: same allow-list, same CAS, clears the provenance columns. */
  revertCarrierBill(
    id: string,
    set: Partial<Record<BillColumn, string | number>>,
    o: { expectedVersion: number },
  ): Promise<{ version: number } | null>
  /** Only `VENDOR_WRITABLE_COLUMNS`; false when the row is gone or no longer NEED_TO_PAY. */
  updateVendorPayable(id: string, set: Partial<Record<VendorColumn, string | number>>, audit: ApWriteAudit): Promise<boolean>
  /** AP_INBOX_CREATE_VENDOR_BILL: `source:'EMAIL'`, `status:'NEED_TO_PAY'`. Conditional on a new id. */
  createVendorPayable(input: ApVendorPayableInput, audit: ApWriteAudit): Promise<boolean>
  /** Append attachment pointers to `VendorPayable.attachments` (deduped by key). */
  appendVendorAttachments(id: string, files: ApVendorPayableInput['attachments']): Promise<void>
  putShipmentDocument(doc: ApShipmentDocumentInput): Promise<{ id: string }>
  writeAudit(entry: ApAuditEntry): Promise<void>

  // ── settings the pipeline reads ──
  getAiAgents(): Promise<unknown>
  getBlacklist(): Promise<{ addresses: string[]; keywords: string[] }>
}

/** Bytes the model reads: a base64 `document` / `image` block source (see `_shared/invoiceFileBlocks`). */
export interface ApModelFile {
  name: string
  contentType: string
  bytes: Buffer
}

export interface ApModelInput {
  subject: string
  from: string
  /** ISO date of the message (relative dates in the mail are read against it). */
  mailDate: string
  /** Body text <= 8 000 chars, passed through the untrusted fence by the real model. */
  text: string
  files: ApModelFile[]
}

export interface ApModel {
  /** One call = classify + extract. Throws on a transport / schema failure (the pipeline retries). */
  extract(input: ApModelInput): Promise<RawApModelOutput>
}

export interface ApObjects {
  put(key: string, body: Buffer | string, contentType: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface ApInboxDeps {
  store: ApInboxStore
  /** The read-only mailbox for a mode (GOOGLE → `googlePort('ap-inbox')`, SIMULATED → `simPort('ap-inbox')`). */
  mailboxFor(mode: ApInboxMode): MailboxPort
  model: ApModel
  objects: ApObjects
  oauth: OAuthPort
  sim: SimPorts
  now(): Date
  /** True only on the dev stack: gates SIMULATED mode and the simulated-message `devExtraction` bypass. */
  devStack: boolean
  /** Allowed OAuth redirect origins (`PORTAL_ORIGINS`). */
  portalOrigins?: string[]
  /** Cognito username -> e-mail for access-token callers (no `email` claim). Absent in tests. */
  resolveEmail?(username: string): Promise<string>
  /**
   * Dev only: the classification a harness stored inside a simulated message (`RawApModelOutput`),
   * read instead of calling the model. Absent in production deps; ignored unless `devStack` and
   * the config mode is SIMULATED.
   */
  devExtraction?(messageId: string): Promise<unknown | null>
}
