/**
 * Step AG — in-memory `ApInboxStore` for tests (S3 pipeline, S4 actions). Enforces the same rules
 * the DynamoDB store must: conditional puts, version CAS, the D8 write allow-lists, the bill
 * paid/credited/status guard. Inspect `bills`, `vendors`, `items`, `audits`, `documents` directly.
 */
import {
  BILL_WRITABLE_COLUMNS,
  VENDOR_WRITABLE_COLUMNS,
  pickAllowed,
} from '../../../src/lib/apInbox/applyPlan'
import { AP_INBOX_ACTOR, MAX_RUNS_KEPT, resolveApInboxConfig } from '../../../src/lib/apInbox/constants'
import type {
  ApInboxConfig,
  ApInboxItemRecord,
  ApInboxState,
  ApInboxStatus,
  Ledger,
  LedgerAssignment,
  LedgerBill,
  LedgerCarrier,
  LedgerVendorPayable,
} from '../../../src/lib/apInbox/types'
import type {
  ApAuditEntry,
  ApInboxStore,
  ApShipmentDocumentInput,
  ApVendorPayableInput,
  ApWriteAudit,
} from './contract'

export interface MemoryBill extends LedgerBill {
  /** Everything a test wants to prove untouched (status, remitTo, approvedAt, ...). */
  extra?: Record<string, unknown>
  apInboxSourceUrl?: string | null
  apInboxAppliedAt?: string | null
  updatedBy?: string
}

export interface MemoryVendor extends LedgerVendorPayable {
  apInboxItemId?: string | null
  apInboxSourceUrl?: string | null
  apInboxAppliedAt?: string | null
  attachments?: ApVendorPayableInput['attachments']
  source?: string
}

export const emptyApInboxState = (): ApInboxState => ({
  connection: { status: 'NOT_CONNECTED', googleEmail: null, connectedAt: null, scopes: [], lastError: null },
  cursor: null,
  retry: [],
  runs: [],
})

export interface MemoryStoreSeed {
  config?: Partial<ApInboxConfig>
  state?: Partial<ApInboxState>
  bills?: MemoryBill[]
  assignments?: LedgerAssignment[]
  vendors?: MemoryVendor[]
  carriers?: LedgerCarrier[]
  aiAgents?: unknown
  blacklist?: { addresses: string[]; keywords: string[] }
}

export interface MemoryStore {
  store: ApInboxStore
  items: Map<string, ApInboxItemRecord>
  bills: Map<string, MemoryBill>
  vendors: Map<string, MemoryVendor>
  assignments: Map<string, LedgerAssignment>
  audits: ApAuditEntry[]
  documents: (ApShipmentDocumentInput & { id: string })[]
  getConfigNow(): ApInboxConfig
  getStateNow(): ApInboxState
}

export function createMemoryStore(seed: MemoryStoreSeed = {}): MemoryStore {
  let config = resolveApInboxConfig({ ...seed.config, version: seed.config?.version ?? 1 })
  let state: ApInboxState = { ...emptyApInboxState(), ...seed.state }
  const items = new Map<string, ApInboxItemRecord>()
  const bills = new Map<string, MemoryBill>((seed.bills ?? []).map((b) => [b.id, { ...b }]))
  const vendors = new Map<string, MemoryVendor>((seed.vendors ?? []).map((v) => [v.id, { ...v }]))
  const assignments = new Map<string, LedgerAssignment>((seed.assignments ?? []).map((a) => [a.loadCarrierId, a]))
  const carriers: Record<string, LedgerCarrier> = Object.fromEntries((seed.carriers ?? []).map((c) => [c.id, c]))
  const audits: ApAuditEntry[] = []
  const documents: (ApShipmentDocumentInput & { id: string })[] = []
  let docSeq = 0
  const clone = <T>(v: T): T => structuredClone(v)

  const store: ApInboxStore = {
    async getConfig() {
      return clone(config)
    },
    async putConfig(next, expectedVersion) {
      if (config.version !== expectedVersion) return false
      config = { ...next, version: expectedVersion + 1 }
      return true
    },
    async getState() {
      return clone(state)
    },
    async patchState(patch) {
      state = { ...state, ...clone(patch) }
      if (state.runs.length > MAX_RUNS_KEPT) state.runs = state.runs.slice(0, MAX_RUNS_KEPT)
    },
    async claimRun(now, staleBefore) {
      const at = state.runningAt ? new Date(state.runningAt).getTime() : 0
      if (state.runningAt && at > staleBefore.getTime()) return false
      state = { ...state, runningAt: now.toISOString() }
      return true
    },
    async releaseRun() {
      const { runningAt: _drop, ...rest } = state
      state = rest
    },

    async putItemIfAbsent(item) {
      if (items.has(item.id)) return false
      items.set(item.id, clone(item))
      return true
    },
    async getItem(id) {
      const it = items.get(id)
      return it ? clone(it) : null
    },
    async updateItem(id, patch, o) {
      const cur = items.get(id)
      if (!cur || cur.version !== o.expectedVersion) return null
      if (o.statusIn && !o.statusIn.includes(cur.status)) return null
      const next: ApInboxItemRecord = { ...cur, ...clone(patch), id: cur.id, version: cur.version + 1 }
      items.set(id, next)
      return clone(next)
    },
    async listByStatus(status: ApInboxStatus, o) {
      return [...items.values()]
        .filter((i) => i.status === status && (!o?.sinceIso || i.receivedAt >= o.sinceIso))
        .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
        .slice(0, o?.limit ?? 200)
        .map(clone)
    },

    async loadLedger(): Promise<Ledger> {
      return clone({
        bills: [...bills.values()].map(({ extra: _e, apInboxSourceUrl: _u, apInboxAppliedAt: _a, updatedBy: _b, ...b }) => b),
        assignments: [...assignments.values()],
        vendorPayables: [...vendors.values()].filter((v) => v.status === 'NEED_TO_PAY').map((v) => ({
          id: v.id, status: v.status, vendor: v.vendor, invoiceNumber: v.invoiceNumber, invoiceDate: v.invoiceDate, dueDate: v.dueDate, amount: v.amount,
        })),
        carriers,
      })
    },
    async getBill(id) {
      const b = bills.get(id)
      return b ? clone(b) : null
    },
    async getAssignment(id) {
      return clone(assignments.get(id) ?? null)
    },
    async getVendorPayable(id) {
      const v = vendors.get(id)
      return v ? clone(v) : null
    },
    async getCarrier(id) {
      return clone(carriers[id] ?? null)
    },
    async updateCarrierBill(id, set, o) {
      const b = bills.get(id)
      if (!b || b.version !== o.expectedVersion || b.status !== o.expectedStatus || b.paidCents !== 0 || b.creditedCents !== 0) return null
      Object.assign(b, pickAllowed(set, BILL_WRITABLE_COLUMNS), {
        apInboxItemId: o.audit.itemId,
        apInboxSourceUrl: o.audit.sourceUrl,
        apInboxAppliedAt: o.audit.at,
        version: b.version + 1,
        updatedBy: AP_INBOX_ACTOR,
      })
      return { version: b.version }
    },
    async revertCarrierBill(id, set, o) {
      const b = bills.get(id)
      if (!b || b.version !== o.expectedVersion) return null
      Object.assign(b, pickAllowed(set, BILL_WRITABLE_COLUMNS), {
        apInboxItemId: null,
        apInboxSourceUrl: null,
        apInboxAppliedAt: null,
        version: b.version + 1,
        updatedBy: AP_INBOX_ACTOR,
      })
      return { version: b.version }
    },
    async updateVendorPayable(id, set, audit: ApWriteAudit) {
      const v = vendors.get(id)
      if (!v || v.status !== 'NEED_TO_PAY') return false
      Object.assign(v, pickAllowed(set, VENDOR_WRITABLE_COLUMNS), {
        apInboxItemId: audit.itemId,
        apInboxSourceUrl: audit.sourceUrl,
        apInboxAppliedAt: audit.at,
      })
      return true
    },
    async createVendorPayable(input, audit) {
      if (vendors.has(input.id)) return false
      vendors.set(input.id, {
        id: input.id,
        status: 'NEED_TO_PAY',
        source: 'EMAIL',
        vendor: input.vendor,
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate,
        amount: input.amount,
        attachments: input.attachments,
        apInboxItemId: audit.itemId,
        apInboxSourceUrl: audit.sourceUrl,
        apInboxAppliedAt: audit.at,
      })
      return true
    },
    async appendVendorAttachments(id, files) {
      const v = vendors.get(id)
      if (!v) return
      const have = new Set((v.attachments ?? []).map((f) => f.key))
      v.attachments = [...(v.attachments ?? []), ...files.filter((f) => !have.has(f.key))]
    },
    async putShipmentDocument(doc) {
      const row = { ...doc, id: `doc-${(docSeq += 1)}` }
      documents.push(row)
      return { id: row.id }
    },
    async writeAudit(entry) {
      audits.push(clone(entry))
    },

    async getAiAgents() {
      return clone(seed.aiAgents ?? null)
    },
    async getBlacklist() {
      return clone(seed.blacklist ?? { addresses: [], keywords: [] })
    },
  }

  return { store, items, bills, vendors, assignments, audits, documents, getConfigNow: () => config, getStateNow: () => state }
}
