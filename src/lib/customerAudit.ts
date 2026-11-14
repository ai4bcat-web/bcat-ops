/**
 * Customer profile audit history (Ryne 2026-11-14: "what gets changed in their data and why").
 *
 * One shape, written by every customer write door (UPSERT_CUSTOMER, SET_CUSTOMER_STATUS,
 * ARCHIVE_CUSTOMER, the OTR rejected → manual invoice action, scripts) and read by the
 * customer profile's History tab:
 *
 *   AuditLog { entityType: 'CUSTOMER', entityId, action, user,
 *              changes: { kind: 'customer-change', fields: [{ field, before, after }], reason, source } }
 *
 * Pure: imported by the Lambdas (relative path) and by the UI. Older rows written before this
 * shape (previous/next, before/after, { field: { from, to } }, oldMethod/newMethod) are read
 * through `customerHistoryEntry` so the import scripts' changes show up too.
 */

export const CUSTOMER_AUDIT_ENTITY_TYPES = ['CUSTOMER', 'Customer'] as const
export const CUSTOMER_AUDIT_ENTITY_TYPE = 'CUSTOMER'

export interface CustomerFieldChange { field: string; before: unknown; after: unknown }
export interface CustomerAuditChanges {
  kind: 'customer-change'
  fields: CustomerFieldChange[]
  reason: string | null
  source: string
  name?: string | null
}

/** Bookkeeping fields that change on every write and say nothing about the customer. */
const IGNORED_FIELDS = new Set([
  'id', '__typename', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'normalizedName',
  'owner', 'version', 'mergedIntoId', 'statusChangedAt', 'statusChangedBy', 'expectedUpdatedAt',
  'changeReason', 'changeSource', 'duplicateOverrideReason',
])

/** Payment method, terms, factoring and the invoice/billing addresses: a change needs a reason. */
export const REASON_REQUIRED_FIELDS = [
  'billingMethod', 'factored', 'paymentTermsDays', 'haulpayDebtorId',
  'billingEmail', 'apEmail', 'apEmailsExtra', 'noaEmail', 'invoiceCopyEmails',
] as const

export const CUSTOMER_FIELD_LABELS: Record<string, string> = {
  name: 'Name', aliases: 'Also known as', aljexCode: 'Aljex code',
  contactName: 'Contact name', contactEmail: 'Contact e-mail', contactPhone: 'Contact phone', notes: 'Notes',
  mcNumber: 'MC #', dotNumber: 'DOT #', mcNameVerified: 'MC name verified', factored: 'Factored',
  billingEmail: 'Billing e-mail', billingContactName: 'Billing contact', billingPhone: 'Billing phone', billingAddress: 'Billing address',
  billingMethod: 'Payment method', apEmail: 'Invoice e-mail (AP 1)', apEmailsExtra: 'More AP e-mails', noaEmail: 'NOA e-mail',
  invoiceCopyEmails: 'Invoice copy-to e-mails', billingNeedsReview: 'Billing needs review',
  paymentTermsDays: 'Payment terms (days)', creditLimitCents: 'Credit limit', creditHoldFlag: 'Credit hold',
  freeCreditRequired: 'Free credit required', creditUsageWarningBps: 'Credit warning level', maxDaysLate: 'Max days late',
  requiredDocsForInvoice: 'Docs required to invoice', reviewRequirements: 'Review requirements',
  defaultDivisionKey: 'Default division', defaultSalesRepId: 'Default sales rep', accountOwnerIds: 'Account owners',
  active: 'Active', status: 'Status', statusReason: 'Status reason', replacementCustomerId: 'Replaced by customer',
  apptWorkflow: 'Appointment workflow', leadSource: 'Lead source', industry: 'Industry', serviceTier: 'Service tier', website: 'Website',
  invoiceFrequency: 'Invoice frequency', gpSplitBps: 'GP split', rateConTerms: 'Rate con terms', visibilityPrefs: 'Visibility',
  teamKey: 'Team', operatedById: 'Operated by', contacts: 'Contacts', billToParties: 'Bill-to parties',
  requiredReferences: 'Required references', chargeCodeOverrides: 'Charge code overrides', defaultCharges: 'Default charges',
  pricingDefaults: 'Pricing defaults', quotingDefaults: 'Quoting defaults', project44CustomerId: 'project44 id', hubspotId: 'HubSpot id',
  haulpayDebtorId: 'Factoring debtor id', ediSettings: 'EDI settings', aiMemory: 'AI agent notes',
  defaultCarrierTeamKey: 'Default carrier team', defaultCarrierRepId: 'Default carrier rep',
  marginTargetBps: 'Margin target', marginFloorBps: 'Margin floor', quoteAutoReply: 'Quote auto-reply',
  requiredLoadFields: 'Required load fields', checkCallPlan: 'Check call plan', defaultTrackerId: 'Default tracker',
  trackingAutomation: 'Tracking automation', trackingMode: 'Tracking mode', trackingMethod: 'Tracking method',
  driverSmsTarget: 'Driver text target', agingStatementSentAt: 'Aging statement sent', agingStatementSentTo: 'Aging statement sent to',
  legacyImported: 'Imported from Aljex', legacySource: 'Import source',
}

export function customerFieldLabel(field: string): string {
  return CUSTOMER_FIELD_LABELS[field] ?? field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
}

/** null, undefined, '' and [] are all "nothing"; objects compare with sorted keys. */
function normalize(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return null
  if (Array.isArray(value)) return value.length === 0 ? null : value.map(normalize)
  if (typeof value === 'string') {
    // AWSJSON fields come back as strings from some readers.
    const t = value.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try { return normalize(JSON.parse(t)) } catch { return value }
    }
    return value
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, normalize(v)] as const)
      .filter(([, v]) => v !== null)
      .sort(([a], [b]) => a.localeCompare(b))
    return entries.length === 0 ? null : Object.fromEntries(entries)
  }
  return value
}

const same = (a: unknown, b: unknown) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))

/** Long text (rate con terms, AI notes) is cut so one row never nears DynamoDB's item limit. */
function clip(value: unknown): unknown {
  const v = normalize(value)
  if (typeof v === 'string' && v.length > 2000) return `${v.slice(0, 2000)}…`
  if (v !== null && typeof v === 'object') {
    const s = JSON.stringify(v)
    if (s.length > 4000) return `${s.slice(0, 4000)}…`
  }
  return v
}

/**
 * The fields that differ between two customer rows. `after` may be a patch: a key it does not
 * carry is not a change. On a create pass `before = null`: every field that has a value is listed.
 */
export function diffCustomer(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>): CustomerFieldChange[] {
  const out: CustomerFieldChange[] = []
  for (const field of Object.keys(after).sort()) {
    if (IGNORED_FIELDS.has(field)) continue
    const a = after[field]
    if (a === undefined) continue
    const b = before ? before[field] : null
    if (same(b, a)) continue
    out.push({ field, before: clip(b), after: clip(a) })
  }
  return out
}

export function changeNeedsReason(fields: readonly CustomerFieldChange[]): boolean {
  return fields.some((f) => (REASON_REQUIRED_FIELDS as readonly string[]).includes(f.field))
}

export const REASON_REQUIRED_MESSAGE =
  'Give a reason for this change: payment method, terms, factoring and billing/invoice e-mails need one'

export function buildCustomerAuditChanges(input: {
  fields: CustomerFieldChange[]; reason?: string | null; source: string; name?: string | null
}): CustomerAuditChanges {
  return {
    kind: 'customer-change',
    fields: input.fields,
    reason: input.reason?.trim() || null,
    source: input.source,
    ...(input.name !== undefined ? { name: input.name } : {}),
  }
}

// ── Reading: one History entry per AuditLog row ─────────────────────────────

export interface CustomerHistoryEntry {
  id: string
  at: string
  user: string
  action: string
  title: string
  fields: CustomerFieldChange[]
  reason: string | null
  source: string | null
}

const ACTION_TITLES: Record<string, string> = {
  CUSTOMER_CREATED: 'Customer created',
  CUSTOMER_UPDATED: 'Profile edited',
  CUSTOMER_STATUS_CHANGED: 'Status changed',
  CUSTOMER_ARCHIVED: 'Archived',
  BILLING_METHOD_SET: 'Billing set up',
  BILLING_METHOD_CHANGED: 'Payment method changed',
  AP_EMAIL_SET: 'Invoice e-mail set',
  PROMOTE_PROSPECT: 'Became a customer',
  DUPLICATE_CUSTOMER_OVERRIDE: 'Created despite a matching name',
  AGING_STATEMENT_SENT: 'Aging statement sent',
  DELETE_CUSTOMER: 'Deleted',
  MERGE_CUSTOMER: 'Merged',
  MERGE_CUSTOMER_START: 'Merge started',
  RESTORE_CUSTOMER: 'Restored',
}

function titleFor(action: string): string {
  if (ACTION_TITLES[action]) return ACTION_TITLES[action]
  if (/^AW_|^SCRIPT_|_IMPORT|_SHEET|_BACKFILL/.test(action)) return 'Updated by an import'
  return action.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function pairsFrom(prev: unknown, next: unknown): CustomerFieldChange[] {
  const p = (prev && typeof prev === 'object' ? prev : {}) as Record<string, unknown>
  const n = (next && typeof next === 'object' ? next : {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(p), ...Object.keys(n)])].filter((k) => !IGNORED_FIELDS.has(k)).sort()
  return keys.filter((k) => !same(p[k], n[k])).map((k) => ({ field: k, before: clip(p[k]), after: clip(n[k]) }))
}

/** Field changes out of any customer audit payload, new shape or old. */
function fieldsOf(c: Record<string, unknown>): CustomerFieldChange[] {
  if (Array.isArray(c.fields)) {
    return (c.fields as unknown[]).filter((f): f is CustomerFieldChange => !!f && typeof f === 'object' && typeof (f as CustomerFieldChange).field === 'string')
  }
  if ('previous' in c || 'next' in c) return pairsFrom(c.previous, c.next)
  if ('before' in c && 'after' in c && typeof c.before === 'object' && typeof c.after === 'object') return pairsFrom(c.before, c.after)
  if ('oldMethod' in c || 'newMethod' in c) return [{ field: 'billingMethod', before: c.oldMethod ?? null, after: c.newMethod ?? null }]
  if ('oldApEmail' in c || 'newApEmail' in c) return [{ field: 'apEmail', before: c.oldApEmail ?? null, after: c.newApEmail ?? null }]
  // { status: { from, to } } and other per-field from/to maps.
  const out: CustomerFieldChange[] = []
  for (const [k, v] of Object.entries(c)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && ('from' in v || 'to' in v)) {
      const fv = v as { from?: unknown; to?: unknown }
      out.push({ field: k, before: clip(fv.from), after: clip(fv.to) })
    }
  }
  if (out.length === 0 && 'from' in c && typeof c.from === 'string') out.push({ field: 'status', before: c.from, after: str(c.to) ?? 'ACTIVE' })
  return out
}

function reasonOf(c: Record<string, unknown>): string | null {
  const reasons = Array.isArray(c.reasons) ? (c.reasons as unknown[]).map(str).filter(Boolean) : []
  return str(c.reason) ?? str(c.otrReason) ?? (reasons.length ? [...new Set(reasons)].join('; ') : null) ?? str(c.why) ?? str(c.how)
}

export function customerHistoryEntry(row: { id: string; action: string; user: string; createdAt: string; changes: unknown }): CustomerHistoryEntry {
  let c: Record<string, unknown> = {}
  if (typeof row.changes === 'string') { try { c = JSON.parse(row.changes) as Record<string, unknown> } catch { c = {} } }
  else if (row.changes && typeof row.changes === 'object') c = row.changes as Record<string, unknown>
  const user = row.user.startsWith('system:') ? `Script ${row.user.slice('system:'.length)}` : row.user
  const source = str(c.source) ?? (row.user.startsWith('system:') ? 'Script' : null)
  return { id: row.id, at: row.createdAt, user, action: row.action, title: titleFor(row.action), fields: fieldsOf(c), reason: reasonOf(c), source }
}

/** Newest first. */
export function customerHistory(rows: readonly { id: string; action: string; user: string; createdAt: string; changes: unknown }[]): CustomerHistoryEntry[] {
  return rows.map(customerHistoryEntry).sort((a, b) => b.at.localeCompare(a.at))
}

/** One value as History prints it. */
export function formatAuditValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '(blank)'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (field === 'creditLimitCents' && typeof value === 'number') return `$${(value / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  if (/Bps$/.test(field) && typeof value === 'number') return `${(value / 100).toFixed(2)}%`
  if (field === 'billingMethod') return value === 'FACTOR' ? 'Factor' : value === 'MANUAL' ? 'Manual invoice' : String(value)
  if (field === 'paymentTermsDays' && typeof value === 'number') return `Net ${value}`
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ')
  if (field === 'billingAddress' && typeof value === 'object') {
    const a = value as Record<string, unknown>
    return [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') || '(blank)'
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
