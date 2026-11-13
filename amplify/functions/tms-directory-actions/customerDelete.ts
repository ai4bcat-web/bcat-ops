/**
 * Admin customer removal (Ryne 2026-11-12: "admins should have the ability to delete customers").
 *
 * PREVIEW_DELETE_CUSTOMER counts every record that points at the customer. A customer nothing
 * points at is hard-deleted (its own CRM rows go with it) and the whole thing is snapshotted into
 * AuditLog so it can be put back. A customer with history is never hard-deleted: it is either
 * archived (the existing ARCHIVE_CUSTOMER, undone by RESTORE_CUSTOMER) or merged into another
 * customer — every pointer is moved to the target, the billing addresses and contacts are carried
 * over, and only then is the source removed.
 *
 * Sent invoices keep their content: a merge moves Invoice.customerId and nothing else (number,
 * PDF, bill-to snapshot and customer name on the invoice stay what the customer received).
 *
 * The merge is idempotent and resumable. Every repoint is conditional on the row still pointing
 * at the source, and the source is deleted last, so a run cut short by the AppSync 30 s limit
 * returns PARTIAL and the client simply calls it again.
 */

export interface DeleteDeps {
  tableOf: (model: string) => string
  get: (table: string, id: string) => Promise<Record<string, unknown> | null>
  /** Every row of a GSI partition (paged). */
  queryIndex: (table: string, index: string, key: string, value: string) => Promise<Record<string, unknown>[]>
  /** Every row of a table (paged); the caller filters. */
  scan: (table: string) => Promise<Record<string, unknown>[]>
  /** SET `set` (null values are written as null) when `field` still equals `expected`; false when it did not. */
  updateIf: (table: string, id: string, set: Record<string, unknown>, field: string, expected: unknown) => Promise<boolean>
  remove: (table: string, id: string) => Promise<void>
  audit: (entityId: string, action: string, changes: Record<string, unknown>) => Promise<void>
  now: () => string
  /** Milliseconds left before the caller must answer; a merge stops early and reports PARTIAL. */
  timeLeftMs?: () => number
}

interface LinkSource {
  key: string
  label: string
  model: string
  /** GSI on customerId; absent = scan. */
  index?: string
  /** Name snapshot moved with the pointer on a merge. Invoices and payments have none on purpose. */
  nameField?: string
}

/** Records with their own history: any one of these blocks a hard delete. */
export const LINK_SOURCES: readonly LinkSource[] = [
  { key: 'shipments', label: 'Shipments', model: 'Shipment', index: 'shipmentsByCustomerIdAndPickupAppt', nameField: 'customerName' },
  { key: 'orders', label: 'Orders', model: 'Order', index: 'ordersByCustomerIdAndPickupAppt', nameField: 'customerName' },
  { key: 'loads', label: 'Loads', model: 'Load', index: 'loadsByCustomerId', nameField: 'customer' },
  { key: 'invoices', label: 'Invoices', model: 'Invoice', index: 'invoicesByCustomerIdAndIssuedAt' },
  { key: 'arPayments', label: 'Payments received', model: 'ArPayment', index: 'arPaymentsByCustomerIdAndReceivedAt' },
  { key: 'factoringItems', label: 'Factoring items', model: 'FactoringItem' },
  { key: 'quotes', label: 'Quotes', model: 'Quote', index: 'quotesByCustomerIdAndQuoteDate', nameField: 'customerName' },
  { key: 'laneRateSamples', label: 'Lane rate history', model: 'LaneRateSample', nameField: 'customerName' },
  { key: 'commissions', label: 'Commissions', model: 'Commission' },
  { key: 'trackingLinks', label: 'Tracking links', model: 'TrackingLink', nameField: 'customerName' },
  { key: 'spotRequests', label: 'Spot quote requests', model: 'SpotRequest' },
]

/** The customer's own CRM rows: deleted with it, moved with it on a merge. */
export const OWNED_SOURCES: readonly LinkSource[] = [
  { key: 'crmContacts', label: 'CRM contacts', model: 'CrmContact', index: 'crmContactsByCustomerId' },
  { key: 'crmDomains', label: 'CRM e-mail domains', model: 'CrmDomain', index: 'crmDomainsByCustomerId' },
  { key: 'crmActivities', label: 'CRM notes & activity', model: 'CrmActivity', index: 'crmActivitiesByCustomerIdAndAt' },
]

export interface LinkCount { key: string; label: string; count: number; blocking: boolean }

export interface DeletePreview {
  customer: { id: string; name: string; active: boolean }
  links: LinkCount[]
  /** Records that block a hard delete. */
  blockingTotal: number
  canHardDelete: boolean
}

async function rowsFor(deps: DeleteDeps, src: LinkSource, customerId: string): Promise<Record<string, unknown>[]> {
  const table = deps.tableOf(src.model)
  if (src.index) return deps.queryIndex(table, src.index, 'customerId', customerId)
  return (await deps.scan(table)).filter((r) => r.customerId === customerId)
}

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

async function locationsLinked(deps: DeleteDeps, customerId: string): Promise<Record<string, unknown>[]> {
  return (await deps.scan(deps.tableOf('Location'))).filter((l) => asArray(l.customerIds).includes(customerId) || l.customerId === customerId)
}

async function customersNaming(deps: DeleteDeps, customerId: string): Promise<Record<string, unknown>[]> {
  return (await deps.scan(deps.tableOf('Customer'))).filter((c) => c.id !== customerId && c.replacementCustomerId === customerId)
}

async function loadCustomer(deps: DeleteDeps, id: string): Promise<Record<string, unknown>> {
  const c = await deps.get(deps.tableOf('Customer'), id)
  if (!c) throw new Error(`Customer not found: ${id}`)
  return c
}

export async function previewDeleteCustomer(deps: DeleteDeps, id: string): Promise<DeletePreview> {
  const customer = await loadCustomer(deps, id)
  const links: LinkCount[] = []
  for (const src of LINK_SOURCES) links.push({ key: src.key, label: src.label, count: (await rowsFor(deps, src, id)).length, blocking: true })
  for (const src of OWNED_SOURCES) links.push({ key: src.key, label: src.label, count: (await rowsFor(deps, src, id)).length, blocking: false })
  links.push({ key: 'locations', label: 'Linked locations (unlinked on delete)', count: (await locationsLinked(deps, id)).length, blocking: false })
  links.push({ key: 'replacementRefs', label: 'Customers naming it as replacement', count: (await customersNaming(deps, id)).length, blocking: false })
  const blockingTotal = links.filter((l) => l.blocking).reduce((n, l) => n + l.count, 0)
  return {
    customer: { id, name: String(customer.name ?? ''), active: customer.active !== false },
    links,
    blockingTotal,
    canHardDelete: blockingTotal === 0,
  }
}

const sameName = (a: unknown, b: unknown) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

function assertConfirmed(customer: Record<string, unknown>, confirmName: unknown): void {
  if (typeof confirmName !== 'string' || !sameName(confirmName, customer.name)) {
    throw new Error(`Type the customer name exactly ("${String(customer.name ?? '')}") to confirm`)
  }
}

export async function deleteCustomer(deps: DeleteDeps, id: string, confirmName: unknown): Promise<Record<string, unknown>> {
  const customer = await loadCustomer(deps, id)
  assertConfirmed(customer, confirmName)
  const preview = await previewDeleteCustomer(deps, id)
  if (!preview.canHardDelete) {
    const what = preview.links.filter((l) => l.blocking && l.count > 0).map((l) => `${l.count} ${l.label.toLowerCase()}`).join(', ')
    throw new Error(`"${String(customer.name)}" has history (${what}) — merge it into another customer or archive it instead`)
  }

  const owned: Record<string, Record<string, unknown>[]> = {}
  for (const src of OWNED_SOURCES) owned[src.key] = await rowsFor(deps, src, id)
  const locations = await locationsLinked(deps, id)
  const replacementRefs = await customersNaming(deps, id)

  // Snapshot first: if anything below fails, the record of what existed is already written.
  await deps.audit(id, 'DELETE_CUSTOMER', { snapshot: { customer, ...owned, locationIds: locations.map((l) => l.id), replacementRefIds: replacementRefs.map((c) => c.id) } })

  for (const loc of locations) {
    const ids = asArray(loc.customerIds).filter((c) => c !== id)
    const set: Record<string, unknown> = { customerIds: ids, updatedAt: deps.now() }
    if (loc.customerId === id) set.customerId = ids[0] ?? null
    await deps.updateIf(deps.tableOf('Location'), String(loc.id), set, 'updatedAt', loc.updatedAt)
  }
  for (const c of replacementRefs) {
    await deps.updateIf(deps.tableOf('Customer'), String(c.id), { replacementCustomerId: null }, 'replacementCustomerId', id)
  }
  for (const src of OWNED_SOURCES) {
    for (const row of owned[src.key]) await deps.remove(deps.tableOf(src.model), String(row.id))
  }
  await deps.remove(deps.tableOf('Customer'), id)
  return { deleted: true, id, name: customer.name }
}

const uniq = (xs: string[]) => {
  const seen = new Set<string>()
  return xs.filter((x) => {
    const k = x.trim().toLowerCase()
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const asJsonArray = (v: unknown): Record<string, unknown>[] => {
  let x = v
  if (typeof x === 'string') {
    try { x = JSON.parse(x) } catch { return [] }
  }
  return Array.isArray(x) ? x.filter((e): e is Record<string, unknown> => e != null && typeof e === 'object') : []
}

/** What the target gains from the source: addresses, contacts and the source's names as aliases. */
export function mergedCustomerFields(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const tAp = String(target.apEmail ?? '').trim()
  const sAp = String(source.apEmail ?? '').trim()
  const extras = uniq([...asArray(target.apEmailsExtra), ...(tAp && sAp ? [sAp] : []), ...asArray(source.apEmailsExtra)])
    .filter((e) => !sameName(e, tAp || sAp))
  if (!tAp && sAp) out.apEmail = sAp
  if (extras.length !== asArray(target.apEmailsExtra).length || extras.some((e, i) => e !== asArray(target.apEmailsExtra)[i])) out.apEmailsExtra = extras
  if (!String(target.noaEmail ?? '').trim() && String(source.noaEmail ?? '').trim()) out.noaEmail = String(source.noaEmail).trim()
  const copies = uniq([...asArray(target.invoiceCopyEmails), ...asArray(source.invoiceCopyEmails)])
  if (copies.length !== asArray(target.invoiceCopyEmails).length) out.invoiceCopyEmails = copies

  for (const f of ['contactName', 'contactEmail', 'contactPhone', 'billingEmail', 'billingContactName', 'billingPhone', 'mcNumber', 'dotNumber', 'aljexCode'] as const) {
    if (!String(target[f] ?? '').trim() && String(source[f] ?? '').trim()) out[f] = source[f]
  }

  const tContacts = asJsonArray(target.contacts)
  const emails = new Set(tContacts.map((c) => String(c.email ?? '').trim().toLowerCase()).filter(Boolean))
  const added = asJsonArray(source.contacts).filter((c) => {
    const e = String(c.email ?? '').trim().toLowerCase()
    return !e || !emails.has(e)
  })
  if (added.length) out.contacts = JSON.stringify([...tContacts, ...added])

  const aliases = uniq([...asArray(target.aliases), String(source.name ?? ''), ...asArray(source.aliases)]).filter((a) => !sameName(a, target.name))
  if (aliases.length !== asArray(target.aliases).length) out.aliases = aliases

  const tNotes = String(target.notes ?? '').trim()
  const sNotes = String(source.notes ?? '').trim()
  if (sNotes && !tNotes.includes(sNotes)) out.notes = tNotes ? `${tNotes}\n\n[Merged from ${String(source.name)}] ${sNotes}` : sNotes
  return out
}

export interface MergeResult {
  status: 'DONE' | 'PARTIAL'
  sourceId: string
  targetId: string
  moved: Record<string, number>
}

export async function mergeCustomer(deps: DeleteDeps, sourceId: string, targetId: string, confirmName: unknown): Promise<MergeResult> {
  if (sourceId === targetId) throw new Error('Pick a different customer to merge into')
  const source = await loadCustomer(deps, sourceId)
  const target = await loadCustomer(deps, targetId)
  assertConfirmed(source, confirmName)
  if (target.mergedIntoId) throw new Error('The target customer was itself merged away — pick the surviving customer')
  if (target.active === false) throw new Error('The target customer is archived — restore it first or pick another')

  const moved: Record<string, number> = {}
  const outOfTime = () => (deps.timeLeftMs ? deps.timeLeftMs() < 4000 : false)
  const targetName = String(target.name ?? '')

  // Copy the source onto the target once, before anything moves, and snapshot both in the audit log.
  if (!source.mergedIntoId) {
    await deps.audit(sourceId, 'MERGE_CUSTOMER_START', { targetId, snapshot: { source, target } })
    const gained = mergedCustomerFields(target, source)
    if (Object.keys(gained).length) {
      const ok = await deps.updateIf(deps.tableOf('Customer'), targetId, { ...gained, updatedAt: deps.now() }, 'updatedAt', target.updatedAt)
      if (!ok) throw new Error('The target customer changed while merging — try again')
    }
    // mergedIntoId marks the run (resumable) and freezes the source: edits, pickers and the
    // duplicate check already treat a merged-away customer as gone.
    const ok = await deps.updateIf(deps.tableOf('Customer'), sourceId, { mergedIntoId: targetId, updatedAt: deps.now() }, 'updatedAt', source.updatedAt)
    if (!ok) throw new Error('The customer changed while merging — try again')
  } else if (source.mergedIntoId !== targetId) {
    throw new Error(`This customer is already being merged into ${String(source.mergedIntoId)} — finish that merge`)
  }

  const POOL = 20
  for (const src of [...LINK_SOURCES, ...OWNED_SOURCES]) {
    const rows = await rowsFor(deps, src, sourceId)
    const table = deps.tableOf(src.model)
    let n = 0
    for (let i = 0; i < rows.length; i += POOL) {
      if (outOfTime()) return { status: 'PARTIAL', sourceId, targetId, moved }
      const chunk = rows.slice(i, i + POOL)
      const results = await Promise.all(chunk.map((row) => {
        const set: Record<string, unknown> = { customerId: targetId }
        if (src.nameField && row[src.nameField] != null && sameName(row[src.nameField], source.name)) set[src.nameField] = targetName
        return deps.updateIf(table, String(row.id), set, 'customerId', sourceId)
      }))
      n += results.filter(Boolean).length
    }
    moved[src.key] = n
  }

  if (outOfTime()) return { status: 'PARTIAL', sourceId, targetId, moved }
  let locs = 0
  for (const loc of await locationsLinked(deps, sourceId)) {
    const ids = uniq(asArray(loc.customerIds).map((c) => (c === sourceId ? targetId : c)))
    const set: Record<string, unknown> = { customerIds: ids, updatedAt: deps.now() }
    if (loc.customerId === sourceId) set.customerId = targetId
    if (sameName(loc.customerName, source.name)) set.customerName = targetName
    if (await deps.updateIf(deps.tableOf('Location'), String(loc.id), set, 'updatedAt', loc.updatedAt)) locs++
  }
  moved.locations = locs
  let refs = 0
  for (const c of await customersNaming(deps, sourceId)) {
    if (await deps.updateIf(deps.tableOf('Customer'), String(c.id), { replacementCustomerId: targetId }, 'replacementCustomerId', sourceId)) refs++
  }
  moved.replacementRefs = refs

  // Anything still pointing at the source (a row written mid-merge) keeps it alive for the next run.
  for (const src of [...LINK_SOURCES, ...OWNED_SOURCES]) {
    if ((await rowsFor(deps, src, sourceId)).length) return { status: 'PARTIAL', sourceId, targetId, moved }
  }

  await deps.audit(sourceId, 'MERGE_CUSTOMER', { targetId, targetName, sourceName: source.name, moved })
  await deps.remove(deps.tableOf('Customer'), sourceId)
  return { status: 'DONE', sourceId, targetId, moved }
}

export async function restoreCustomer(deps: DeleteDeps, id: string): Promise<Record<string, unknown>> {
  const c = await loadCustomer(deps, id)
  if (c.mergedIntoId) throw new Error('A merged customer cannot be restored')
  if (c.active !== false) return c
  const ok = await deps.updateIf(deps.tableOf('Customer'), id, { active: true, updatedAt: deps.now() }, 'updatedAt', c.updatedAt)
  if (!ok) throw new Error('This customer changed — refresh and try again')
  await deps.audit(id, 'RESTORE_CUSTOMER', { name: c.name })
  return loadCustomer(deps, id)
}
