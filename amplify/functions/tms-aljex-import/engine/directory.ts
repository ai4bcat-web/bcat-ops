/**
 * Master-data phases (P1 customers, P2 carriers, P3 locations) and the Map-based lookups the load
 * phase uses. Keys come from `_shared/directoryKeys.ts`, the same helpers the UPSERT_* actions use,
 * so records the import writes are found by the app's own duplicate checks.
 *
 * Nothing here scans per row: each phase loads a table once into Maps (plan D6/D13).
 */
import type { EngineRow, EngineStore } from '../../../../src/types/tms'
import type { CanonicalRow, CanonicalStop } from '../../../../src/lib/aljex/canonical'
import type { AljexProfile } from '../../../../src/lib/aljex/profile'
import { carrierKey, customerKey, locationAddressKey, locationKey } from '../../_shared/directoryKeys'
import { carrierWindowStart } from './stage'
import { IMPORT_ACTOR, bump, type Counts, type Finding, type MasterCarrier, type MasterCustomer, type StagedMasters } from './types'
import { compactText, daysBetween, stableId } from './util'
import type { CarrierMasterRow, CarriersParse } from '../../../../src/lib/aljex/layouts/carriers'
import type { CustomerMasterRow, CustomersParse } from '../../../../src/lib/aljex/layouts/customers'

export const text = (v: unknown): string => (typeof v === 'string' ? v : '')

export async function scanRows(store: EngineStore, table: Parameters<EngineStore['scanAll']>[0], projection?: string[]): Promise<EngineRow[]> {
  const out: EngineRow[] = []
  for await (const page of store.scanAll(table, projection)) out.push(...page)
  return out
}

const stripZeros = (digits: string): string => digits.replace(/\D/g, '').replace(/^0+/, '')

// ── P1 customers ─────────────────────────────────────────────────────────────────────────────

export interface CustomerLookup {
  /** Aljex account -> directory customer id. */
  byAccount: Map<string, string>
  /** id -> existing row fields the load phase needs (terms). */
  termsById: Map<string, number | null>
}

export interface PhaseEnv {
  store: EngineStore
  rootJobId: string
  runId: string
  profile: AljexProfile
  masters: StagedMasters
  counts: Counts
  findings: Finding[]
  /** This phase was already started by this job (crash/resume): rows it finds are its own, so they count as created. */
  reentry: boolean
}

const CUSTOMER_PROJECTION = ['id', 'name', 'aliases', 'normalizedName', 'aljexCode', 'mergedIntoId', 'status', 'active', 'paymentTermsDays', 'leadSource']

export async function runCustomers(env: PhaseEnv): Promise<void> {
  const { store, masters, counts, findings } = env
  const existing = await scanRows(store, 'customer', CUSTOMER_PROJECTION)
  const byCode = new Map<string, EngineRow>()
  const byKey = new Map<string, EngineRow[]>()
  for (const c of existing) {
    if (text(c.aljexCode)) byCode.set(text(c.aljexCode), c)
    if (c.active === false) continue
    const keys = new Set<string>([customerKey(text(c.name)), ...((c.aliases as string[] | undefined) ?? []).map(customerKey)])
    for (const k of keys) if (k) byKey.set(k, [...(byKey.get(k) ?? []), c])
  }
  const creates: EngineRow[] = []
  const audits: EngineRow[] = []
  const newest = masters.newestShip
  for (const m of masters.customers) {
    const stableCustomerId = stableId('cus', `aljex:${m.account}`)
    const coded = byCode.get(m.account)
    if (coded) {
      bump(counts, 'CUSTOMER', 'staged')
      bump(counts, 'CUSTOMER', coded.id === stableCustomerId && env.reentry ? 'created' : 'matched')
      continue
    }
    bump(counts, 'CUSTOMER', 'staged')
    const names = [m.name, ...m.aliases].map(customerKey).filter(Boolean)
    const candidates = new Map<string, EngineRow>()
    for (const k of names) for (const c of byKey.get(k) ?? []) candidates.set(text(c.id), c)
    if (candidates.size > 1 || [...candidates.values()].some((c) => text(c.mergedIntoId))) {
      bump(counts, 'CUSTOMER', 'conflicts')
      findings.push({ code: 'CUSTOMER_CONFLICT', detail: `account ${m.account}: ${candidates.size} candidates` })
      continue
    }
    const [match] = [...candidates.values()]
    if (match) {
      bump(counts, 'CUSTOMER', 'matched')
      const patch: EngineRow = { aljexCode: m.account, ...(m.leadSource && !text(match.leadSource) ? { leadSource: m.leadSource } : {}) }
      const known = new Set<string>([text(match.name), ...(((match.aliases as string[] | undefined) ?? []))])
      const extra = [m.name, ...m.aliases].filter((n) => n && !known.has(n))
      if (extra.length) patch.aliases = [...(((match.aliases as string[] | undefined) ?? [])), ...extra]
      await store.update('customer', text(match.id), patch, { expression: 'attribute_not_exists(aljexCode)' })
      byCode.set(m.account, { ...match, aljexCode: m.account })
      audits.push(auditRow(`cus-match:${m.account}:${env.runId}`, 'Customer', text(match.id), 'ALJEX_IMPORT_LINK', { aljexCode: m.account, addedAliases: extra.length }))
      continue
    }
    const created = customerRow(m, stableCustomerId, newest)
    creates.push(created)
    bump(counts, 'CUSTOMER', 'created')
    byCode.set(m.account, created)
    for (const k of names) byKey.set(k, [created])
  }
  await store.batchPut('customer', creates)
  await store.batchPut('auditLog', audits)
}

function auditRow(key: string, entityType: string, entityId: string, action: string, changes: Record<string, unknown>): EngineRow {
  return { id: stableId('aud', key), entityType, entityId, action, user: IMPORT_ACTOR, changes }
}

export { auditRow }

function customerRow(m: MasterCustomer, id: string, newestShip: string | null): EngineRow {
  const dormant = newestShip != null && (m.lastShip == null || daysBetween(m.lastShip, newestShip) > 365)
  const address = compactText({ street: m.street, city: m.city, state: m.state, zip: m.zip })
  return compactText({
    id,
    name: m.name,
    normalizedName: customerKey(m.name),
    aliases: m.aliases.length ? m.aliases : undefined,
    aljexCode: m.account,
    status: dormant ? 'DORMANT' : 'ACTIVE',
    active: true,
    billingAddress: Object.keys(address).length ? address : undefined,
    contactName: m.contact,
    notes: `Imported from Aljex acct ${m.account}`,
    leadSource: m.leadSource,
    legacyImported: true,
    legacySource: 'ALJEX',
  })
}

export async function loadCustomerLookup(store: EngineStore): Promise<CustomerLookup> {
  const byAccount = new Map<string, string>()
  const termsById = new Map<string, number | null>()
  for (const c of await scanRows(store, 'customer', ['id', 'aljexCode', 'paymentTermsDays'])) {
    if (text(c.aljexCode)) byAccount.set(text(c.aljexCode), text(c.id))
    termsById.set(text(c.id), typeof c.paymentTermsDays === 'number' ? c.paymentTermsDays : null)
  }
  return { byAccount, termsById }
}

// ── P2 carriers ──────────────────────────────────────────────────────────────────────────────

export interface CarrierRef {
  id: string
  name: string
  mc: string
  termsDays: number | null
}

const CARRIER_PROJECTION = ['id', 'name', 'normalizedName', 'aljexCode', 'mcNumber', 'dotNumber', 'status', 'paymentTermsDays', 'caIntrastateNumber', 'caIntrastateExpiresAt', 'txPucNumber', 'txPucExpiresAt']

/** A carrier id is used when it ran a load on/after the window start, or has an open payable / in-flight load (DECIDED-7). */
export function selectedCarriers(masters: StagedMasters, profile: AljexProfile): { selected: MasterCarrier[]; skipped: MasterCarrier[] } {
  const start = carrierWindowStart(masters, profile.carrierCutoffDate, profile.carrierWindowMonths)
  const selected: MasterCarrier[] = []
  const skipped: MasterCarrier[] = []
  for (const c of masters.carriers) {
    if (c.ownAsset) continue
    const used = start == null || (c.newestShip != null && c.newestShip >= start)
    ;(used || c.openBill || c.inFlight ? selected : skipped).push(c)
  }
  return { selected, skipped }
}

export async function runCarriers(env: PhaseEnv): Promise<void> {
  const { store, counts, findings, profile } = env
  const existing = await scanRows(store, 'carrier', CARRIER_PROJECTION)
  const byCode = new Map<string, EngineRow>()
  const byMc = new Map<string, EngineRow>()
  const byDot = new Map<string, EngineRow>()
  const byName = new Map<string, EngineRow[]>()
  for (const c of existing) {
    if (text(c.aljexCode)) byCode.set(text(c.aljexCode), c)
    if (stripZeros(text(c.mcNumber))) byMc.set(stripZeros(text(c.mcNumber)), c)
    if (stripZeros(text(c.dotNumber))) byDot.set(stripZeros(text(c.dotNumber)), c)
    const k = carrierKey(text(c.name))
    if (k) byName.set(k, [...(byName.get(k) ?? []), c])
  }
  const { selected, skipped } = selectedCarriers(env.masters, profile)
  const creates: EngineRow[] = []
  const audits: EngineRow[] = []
  for (const m of selected) {
    bump(counts, 'CARRIER', 'staged')
    const stable = stableId('car', `aljex:${m.id}`)
    const coded = byCode.get(m.id)
    if (coded) {
      bump(counts, 'CARRIER', coded.id === stable && env.reentry ? 'created' : 'matched')
      continue
    }
    const mc = stripZeros(m.mc)
    const dot = stripZeros(m.dot)
    const nameKey = carrierKey(m.name)
    const nameMatches = byName.get(nameKey) ?? []
    let link: EngineRow | undefined = (mc && byMc.get(mc)) || (dot && byDot.get(dot)) || undefined
    if (!link) {
      const compatible = nameMatches.find((c) => {
        const cmc = stripZeros(text(c.mcNumber))
        return cmc === mc || (!cmc && !mc)
      })
      if (compatible) link = compatible
      else if (nameMatches.length) findings.push({ code: 'NAME_COLLISION', detail: `carrier id ${m.id}` })
    }
    if (link) {
      bump(counts, 'CARRIER', 'matched')
      await store.update('carrier', text(link.id), { aljexCode: m.id, ...complianceFor(m, link) }, { expression: 'attribute_not_exists(aljexCode)' })
      byCode.set(m.id, { ...link, aljexCode: m.id })
      audits.push(auditRow(`car-match:${m.id}:${env.runId}`, 'Carrier', text(link.id), 'ALJEX_IMPORT_LINK', { aljexCode: m.id }))
      continue
    }
    if (!mc && !dot && !m.scac) findings.push({ code: 'CARRIER_NO_IDENTIFIERS', detail: `carrier id ${m.id}` })
    if (m.mcPrefix === 'MX') findings.push({ code: 'CARRIER_MX_PREFIX', detail: `carrier id ${m.id}` })
    const row = carrierRow(m, stable, profile)
    creates.push(row)
    bump(counts, 'CARRIER', 'created')
    byCode.set(m.id, row)
    if (nameKey) byName.set(nameKey, [...nameMatches, row])
    if (mc) byMc.set(mc, row)
    if (dot) byDot.set(dot, row)
  }
  for (const m of skipped) {
    bump(counts, 'CARRIER', 'staged')
    bump(counts, 'CARRIER', 'skipped')
    findings.push({ code: 'CARRIER_SKIPPED', detail: `${m.id}|${m.loads}|${m.newestShip ?? ''}|${m.costCents}` })
  }
  await store.batchPut('carrier', creates)
  await store.batchPut('auditLog', audits)
}

function carrierRow(m: MasterCarrier, id: string, profile: AljexProfile): EngineRow {
  const rating = profile.safetyRatingMap[m.safetyRating.trim().toUpperCase()] ?? 'UNKNOWN'
  const notes = [`Imported from Aljex ${m.id}. Not vetted in BCAT Ops: send a MyCarrierPackets packet before booking.`, m.mcPrefix === 'MX' ? 'MC prefix MX in Aljex.' : m.mcPrefix === 'MC' ? 'MC prefix MC in Aljex.' : '']
  return compactText({
    id,
    name: m.name,
    normalizedName: carrierKey(m.name),
    type: 'TL',
    status: 'PENDING',
    mcNumber: m.mc.replace(/\D/g, ''),
    dotNumber: m.dot.replace(/\D/g, ''),
    scac: m.scac,
    authorityStatus: 'UNKNOWN',
    safetyRating: rating,
    phone: m.phone,
    email: m.email,
    dispatcherName: m.dispatcher,
    dispatcherPhone: m.dispatchPhone,
    insurancePolicies: [],
    internalNotes: notes.filter(Boolean).join(' '),
    ...complianceFor(m, {}),
    aljexCode: m.id,
    legacyImported: true,
    legacySource: 'ALJEX',
    createdBy: IMPORT_ACTOR,
    updatedBy: IMPORT_ACTOR,
    version: 1,
  })
}

/** Carrier compliance numbers/expiries the export carries (additive; never overwrites what a live record already has). */
function complianceFor(m: MasterCarrier, existing: EngineRow): EngineRow {
  const out: EngineRow = {}
  if (m.caIntrastate && !text(existing.caIntrastateNumber)) out.caIntrastateNumber = m.caIntrastate
  if (m.caIntrastateExp && !text(existing.caIntrastateExpiresAt)) out.caIntrastateExpiresAt = m.caIntrastateExp
  if (m.txPuc && !text(existing.txPucNumber)) out.txPucNumber = m.txPuc
  if (m.txPucExp && !text(existing.txPucExpiresAt)) out.txPucExpiresAt = m.txPucExp
  return out
}

export async function loadCarrierLookup(store: EngineStore): Promise<Map<string, CarrierRef>> {
  const out = new Map<string, CarrierRef>()
  for (const c of await scanRows(store, 'carrier', ['id', 'name', 'aljexCode', 'mcNumber', 'paymentTermsDays'])) {
    if (!text(c.aljexCode)) continue
    out.set(text(c.aljexCode), { id: text(c.id), name: text(c.name), mc: text(c.mcNumber), termsDays: typeof c.paymentTermsDays === 'number' ? c.paymentTermsDays : null })
  }
  return out
}

// ── P3 locations ─────────────────────────────────────────────────────────────────────────────

export interface LocationMaps {
  byNameCity: Map<string, string>
  byAddress: Map<string, string>
}

const LOCATION_PROJECTION = ['id', 'name', 'city', 'state', 'zip', 'street', 'normalizedName', 'normalizedAddress', 'mergedIntoId', 'active']

export async function loadLocationMaps(store: EngineStore): Promise<{ maps: LocationMaps; rows: EngineRow[] }> {
  const rows = await scanRows(store, 'location', LOCATION_PROJECTION)
  const maps: LocationMaps = { byNameCity: new Map(), byAddress: new Map() }
  for (const l of rows) {
    if (l.active === false || text(l.mergedIntoId)) continue
    const nk = text(l.normalizedName) || locationKey(text(l.name))
    if (nk) {
      const key = `${nk}|${locationKey(text(l.city))}`
      if (!maps.byNameCity.has(key)) maps.byNameCity.set(key, text(l.id))
    }
    const ak = text(l.normalizedAddress)
    if (ak && !maps.byAddress.has(ak)) maps.byAddress.set(ak, text(l.id))
  }
  return { maps, rows }
}

export interface StopKeys {
  nameKey: string
  cityKey: string
  addrKey: string
}

export function stopKeys(s: Pick<CanonicalStop, 'name' | 'street' | 'city' | 'state' | 'zip'>): StopKeys {
  return {
    nameKey: locationKey(s.name),
    cityKey: locationKey(s.city),
    addrKey: locationAddressKey({ street: s.street, city: s.city, state: s.state, zip: s.zip, country: 'US' }),
  }
}

/** Existing-or-undefined: the UPSERT_LOCATION duplicate rule (same name + city, or same address). */
export function findLocation(maps: LocationMaps, k: StopKeys, hasAddressParts: boolean): string | undefined {
  if (k.nameKey) {
    const hit = maps.byNameCity.get(`${k.nameKey}|${k.cityKey}`)
    if (hit) return hit
  }
  if (hasAddressParts && k.addrKey) return maps.byAddress.get(k.addrKey)
  return undefined
}

const hasAddr = (s: CanonicalStop): boolean => Boolean(s.street || s.city || s.state || s.zip)

export interface LocationAcc {
  role: Set<'pickup' | 'delivery'>
  stop: CanonicalStop
}

/** Feed one chunk's stops into the accumulator of locations that need creating (P3). */
export function collectLocations(env: { maps: LocationMaps; pending: Map<string, LocationAcc> }, rows: CanonicalRow[], counts: Counts): void {
  for (const row of rows) {
    for (const stop of row.stops) {
      if (!stop.name && !hasAddr(stop)) continue
      const k = stopKeys(stop)
      bump(counts, 'LOCATION', 'staged')
      const hit = findLocation(env.maps, k, hasAddr(stop))
      if (hit) {
        const acc = env.pending.get(hit)
        if (acc) acc.role.add(stop.type)
        bump(counts, 'LOCATION', 'matched')
        continue
      }
      const id = stableId('loc', `${k.nameKey}|${k.addrKey}`)
      if (k.nameKey) env.maps.byNameCity.set(`${k.nameKey}|${k.cityKey}`, id)
      if (hasAddr(stop) && k.addrKey) env.maps.byAddress.set(k.addrKey, id)
      env.pending.set(id, { role: new Set([stop.type]), stop })
      bump(counts, 'LOCATION', 'created')
    }
  }
}

export function locationRow(id: string, acc: LocationAcc): EngineRow {
  const s = acc.stop
  const k = stopKeys(s)
  const both = acc.role.size > 1
  return compactText({
    id,
    name: s.name || s.city,
    street: s.street,
    city: s.city,
    state: s.state,
    zip: s.zip,
    country: 'US',
    normalizedName: k.nameKey,
    normalizedAddress: hasAddr(s) ? k.addrKey : '',
    facilityType: both ? 'BOTH' : acc.role.has('pickup') ? 'SHIPPER' : 'RECEIVER',
    active: true,
    apptContactPhone: s.phone,
    apptContactName: s.contact,
    notes: 'Imported from Aljex',
  })
}

/** The location id for a stop on the load phase (Maps built from the post-P3 table). */
export function resolveStopLocation(maps: LocationMaps, stop: CanonicalStop): string | undefined {
  if (!stop.name && !hasAddr(stop)) return undefined
  return findLocation(maps, stopKeys(stop), hasAddr(stop))
}

// ── Master files: CUSTOMERS_MASTER / CARRIERS_MASTER (Step AW stage E) ───────────────────────
// One row per Aljex Account # / Aljex Carrier ID, parsed by src/lib/aljex/layouts/*. The same functions
// run the dry run (over the MemoryStore overlay: nothing is written) and the apply (the real store).
// Re-running is a no-op: rows are found by `aljexCode` / `aljexAliases` first.

export interface MasterRunEnv {
  store: EngineStore
  runId: string
  counts: Counts
  findings: Finding[]
  /** Anchor of the DORMANT test (the cutoff date, `YYYY-MM-DD`); never the wall clock. null = no row is dormant. */
  asOf: string | null
}

export interface MasterRunReport {
  entity: 'CUSTOMERS' | 'CARRIERS'
  /** Numbers only: no names, e-mails or identifiers. */
  summary: Record<string, number>
  /** Aljex keys (Account # / Carrier ID) needing a human look, with the reason. */
  review: Array<{ key: string; reason: string }>
}

const CUSTOMER_FILL_PROJECTION = ['id', 'name', 'normalizedName', 'aljexCode', 'mergedIntoId', 'active', 'billingMethod', 'apEmail', 'billingNeedsReview', 'defaultDivisionKey', 'creditLimitCents', 'paymentTermsDays']
const BILLING_FILL = ['billingMethod', 'apEmail', 'billingNeedsReview', 'defaultDivisionKey', 'creditLimitCents', 'paymentTermsDays'] as const

function customerNote(m: CustomerMasterRow): string {
  const parts = [`Imported from Aljex acct ${m.account}.`]
  if (m.customerType) parts.push(`Type: ${m.customerType}.`)
  if (m.totalShipments != null) parts.push(`${m.totalShipments} shipments${m.firstShipment ? `, first ${m.firstShipment}` : ''}${m.lastShipment ? `, last ${m.lastShipment}` : ''}.`)
  return parts.join(' ')
}

/** What a Customer row carries from the Aljex line (billing fields only when the seed produced them; the Balance Due never). */
function customerFields(m: CustomerMasterRow): EngineRow {
  const address = compactText({ street: m.street, city: m.city, state: m.state, zip: m.zip })
  const [first] = m.contacts
  return compactText({
    name: m.name,
    normalizedName: customerKey(m.name),
    aljexCode: m.account,
    billingAddress: Object.keys(address).length ? address : undefined,
    contactName: first?.name,
    contactEmail: first?.email,
    contactPhone: m.phone,
    billingPhone: m.phone,
    contacts: m.contacts.length
      ? m.contacts.map((c, i) => ({ id: stableId('cct', `aljex:${m.account}:${i}`), name: c.name || c.email, email: c.email || null, phone: c.phone || null, types: [], notifications: [], active: true }))
      : undefined,
    notes: customerNote(m),
    defaultDivisionKey: m.defaultDivisionKey ?? undefined,
    paymentTermsDays: m.paymentTermsDays ?? undefined,
    creditLimitCents: m.creditLimitCents ?? undefined,
    billingMethod: m.billing.billingMethod ?? undefined,
    apEmail: m.billing.apEmail ?? undefined,
    billingNeedsReview: m.billing.billingNeedsReview ?? undefined,
  })
}

export async function runCustomersMaster(env: MasterRunEnv, parsed: CustomersParse): Promise<MasterRunReport> {
  const { store, counts, findings } = env
  const existing = await scanRows(store, 'customer', CUSTOMER_FILL_PROJECTION)
  const byCode = new Map<string, EngineRow>()
  const byKey = new Set<string>()
  for (const c of existing) {
    if (text(c.aljexCode)) byCode.set(text(c.aljexCode), c)
    else if (c.active !== false && !text(c.mergedIntoId)) byKey.add(customerKey(text(c.name)))
  }
  const review: MasterRunReport['review'] = []
  const summary: Record<string, number> = {
    customersCreated: 0, customersMatched: 0, customersEnriched: 0, nameMatchesNotLinked: 0,
    locationsCreated: 0, locationsMatched: 0,
    excluded: parsed.counts.excluded, rejected: parsed.counts.rejected, duplicateGroups: parsed.counts.duplicateGroups,
    factor: parsed.counts.factor, manual: parsed.counts.manual, unset: parsed.counts.unset, needsReview: parsed.counts.needsReview, danisco120: parsed.counts.danisco,
  }
  for (const r of parsed.rejected) findings.push({ code: 'CUSTOMER_ROW_REJECTED', detail: `line ${r.line}: ${r.reason}` })
  for (const g of parsed.duplicateGroups) findings.push({ code: 'CUSTOMER_DUPLICATE_NAME', detail: g.accounts.join(',') })
  for (const m of parsed.customers) if (m.billing.billingNeedsReview) review.push({ key: m.account, reason: m.billing.billingNeedsReview })

  const creates: EngineRow[] = []
  const audits: EngineRow[] = []
  for (const m of parsed.customers) {
    bump(counts, 'CUSTOMER', 'staged')
    const coded = byCode.get(m.account)
    if (coded) {
      // Fill only what a person has not set: a re-run or a hand edit is never overwritten.
      const wanted = customerFields(m)
      const patch: EngineRow = {}
      for (const k of BILLING_FILL) if (wanted[k] !== undefined && (coded[k] === undefined || coded[k] === null || coded[k] === '')) patch[k] = wanted[k]
      if (Object.keys(patch).length) {
        await store.update('customer', text(coded.id), patch)
        audits.push(auditRow(`cus-fill:${m.account}:${env.runId}`, 'Customer', text(coded.id), 'ALJEX_IMPORT_FILL', { fields: Object.keys(patch) }))
        bump(counts, 'CUSTOMER', 'enriched')
        summary.customersEnriched += 1
      } else {
        bump(counts, 'CUSTOMER', 'matched')
        summary.customersMatched += 1
      }
      continue
    }
    if (byKey.has(customerKey(m.name))) {
      summary.nameMatchesNotLinked += 1
      review.push({ key: m.account, reason: 'a customer with the same name exists without an Aljex account; imported separately (possible duplicate)' })
    }
    const dormant = m.lastShipment == null || (env.asOf != null && daysBetween(m.lastShipment, env.asOf) > 365)
    const row = compactText({
      id: stableId('cus', `aljex:${m.account}`),
      ...customerFields(m),
      status: env.asOf != null && dormant ? 'DORMANT' : 'ACTIVE',
      active: true,
      legacyImported: true,
      legacySource: 'ALJEX',
    })
    creates.push(row)
    byCode.set(m.account, row)
    bump(counts, 'CUSTOMER', 'created')
    summary.customersCreated += 1
  }
  await store.batchPut('customer', creates)

  // Status N: a Location, not a customer (R29).
  const { maps } = await loadLocationMaps(store)
  const locs: EngineRow[] = []
  const hasParts = (m: CustomerMasterRow): boolean => Boolean(m.street || m.city || m.state || m.zip)
  const locRows = await scanRows(store, 'location', ['id', 'aljexCode'])
  const locByCode = new Map(locRows.filter((l) => text(l.aljexCode)).map((l) => [text(l.aljexCode), l]))
  for (const m of parsed.locations) {
    bump(counts, 'LOCATION', 'staged')
    if (locByCode.has(m.account)) {
      bump(counts, 'LOCATION', 'matched')
      summary.locationsMatched += 1
      continue
    }
    const k = stopKeys({ name: m.name, street: m.street, city: m.city, state: m.state, zip: m.zip })
    const hit = findLocation(maps, k, hasParts(m))
    if (hit) {
      await store.update('location', hit, { aljexCode: m.account }, { expression: 'attribute_not_exists(aljexCode)' })
      bump(counts, 'LOCATION', 'matched')
      summary.locationsMatched += 1
      continue
    }
    const id = stableId('loc', `aljex-acct:${m.account}`)
    if (k.nameKey) maps.byNameCity.set(`${k.nameKey}|${k.cityKey}`, id)
    if (hasParts(m) && k.addrKey) maps.byAddress.set(k.addrKey, id)
    locs.push(compactText({
      id,
      name: m.name,
      aljexCode: m.account,
      street: m.street,
      city: m.city,
      state: m.state,
      zip: m.zip,
      country: 'US',
      normalizedName: k.nameKey,
      normalizedAddress: hasParts(m) ? k.addrKey : '',
      apptContactName: m.contacts[0]?.name,
      apptContactEmail: m.contacts[0]?.email,
      apptContactPhone: m.phone,
      notes: `Inactive Aljex customer (acct ${m.account}).`,
      active: true,
    }))
    bump(counts, 'LOCATION', 'created')
    summary.locationsCreated += 1
  }
  await store.batchPut('location', locs)
  await store.batchPut('auditLog', audits)
  return { entity: 'CUSTOMERS', summary, review }
}

const digitsOf = (s: string): string => s.replace(/\D/g, '').replace(/^0+/, '')

function carrierNotes(m: CarrierMasterRow): string {
  const parts = [`Imported from Aljex ${m.id}. Not vetted in BCAT Ops: send a MyCarrierPackets packet before booking.`]
  if (m.aliases.length) parts.push(`Merged Aljex carrier ids: ${m.aliases.join(', ')}.`)
  if (m.otherNames.length) parts.push(`Also named: ${m.otherNames.join('; ')}.`)
  if (m.factorId) parts.push(`Paid through Aljex factor ${m.factorId}.`)
  if (m.payableTo && m.payableTo !== m.name) parts.push(`Checks payable to ${m.payableTo}.`)
  const r = m.remit
  if (r.street || r.city) parts.push(`Remit to ${[r.street, r.city, r.state, r.zip].filter(Boolean).join(', ')}.`)
  if (m.quickPay.eligible) parts.push(`Quick pay${m.quickPay.days != null ? ` ${m.quickPay.days} days` : ''}${m.quickPay.pct ? ` at ${m.quickPay.pct}%` : ''}.`)
  if (m.phoneAccounting) parts.push(`Accounting phone ${m.phoneAccounting}.`)
  return parts.join(' ')
}

function newCarrierRow(m: CarrierMasterRow): EngineRow {
  const address = compactText({ street: m.street, city: m.city, state: m.state, zip: m.zip, country: 'US' })
  return compactText({
    id: stableId('car', `aljex:${m.id}`),
    name: m.name,
    normalizedName: carrierKey(m.name),
    aljexCode: m.id,
    aljexAliases: m.aliases.length ? m.aliases : undefined,
    type: 'TL',
    // Inactive in Aljex imports INACTIVE, never active; the rest are not vetted here yet.
    status: m.active ? 'PENDING' : 'INACTIVE',
    statusReason: m.active ? undefined : 'OTHER',
    statusNote: m.active ? undefined : 'Inactive in Aljex',
    mcNumber: m.mc,
    dotNumber: m.dot,
    authorityStatus: 'UNKNOWN',
    safetyRating: m.safety,
    address: Object.keys(address).length > 1 ? address : undefined,
    phone: m.phone,
    dispatcherName: m.contact,
    insurancePolicies: [],
    paymentTermsDays: m.termsDays ?? undefined,
    quickPayEligible: m.quickPay.eligible || undefined,
    defaultQuickPayDays: m.quickPay.eligible ? m.quickPay.days ?? undefined : undefined,
    internalNotes: carrierNotes(m),
    legacyImported: true,
    legacySource: 'ALJEX',
    createdBy: IMPORT_ACTOR,
    updatedBy: IMPORT_ACTOR,
    version: 1,
  })
}

const CARRIER_MASTER_PROJECTION = ['id', 'name', 'aljexCode', 'aljexAliases', 'mcNumber', 'dotNumber', 'status', 'phone', 'paymentTermsDays', 'quickPayEligible']

/** Match order: MC/DOT, then Aljex Carrier ID (also the aliases of existing rows). A name is never a key. */
export async function runCarriersMaster(env: MasterRunEnv, parsed: CarriersParse): Promise<MasterRunReport> {
  const { store, counts, findings } = env
  const existing = await scanRows(store, 'carrier', CARRIER_MASTER_PROJECTION)
  const byMc = new Map<string, EngineRow>()
  const byDot = new Map<string, EngineRow>()
  const byCode = new Map<string, EngineRow>()
  const index = (c: EngineRow): void => {
    if (digitsOf(text(c.mcNumber))) byMc.set(digitsOf(text(c.mcNumber)), c)
    if (digitsOf(text(c.dotNumber))) byDot.set(digitsOf(text(c.dotNumber)), c)
    if (text(c.aljexCode)) byCode.set(text(c.aljexCode), c)
    for (const a of (c.aljexAliases as string[] | undefined) ?? []) byCode.set(a, c)
  }
  existing.forEach(index)

  const summary: Record<string, number> = {
    created: 0, matchedByMcDot: 0, matchedByAljexId: 0, enriched: 0, conflicts: 0, nameConflicts: 0,
    inactive: parsed.counts.inactive, withFactorId: parsed.counts.withFactorId, quickPay: parsed.counts.quickPay,
    mergeGroups: parsed.counts.mergeGroups, rowsMerged: parsed.counts.rowsMerged, otherVendorsSkipped: parsed.counts.otherVendors,
    rejected: parsed.counts.rejected, sameNameDifferentCarrier: parsed.counts.sameNameDifferentCarrier,
    rowsWithFedSs: parsed.counts.sensitiveRows.fedSs, rowsWithBankAccount: parsed.counts.sensitiveRows.bankAccount, rowsWithRouting: parsed.counts.sensitiveRows.routing,
  }
  const review: MasterRunReport['review'] = []
  for (const r of parsed.rejected) findings.push({ code: 'CARRIER_ROW_REJECTED', detail: `line ${r.line}: ${r.reason}` })
  for (const g of parsed.mergeGroups) findings.push({ code: 'CARRIER_MERGED', detail: `${g.id}+${g.aliases.join(',')} by ${g.by}` })

  const creates: EngineRow[] = []
  const audits: EngineRow[] = []
  for (const m of parsed.carriers) {
    bump(counts, 'CARRIER', 'staged')
    const mc = digitsOf(m.mc)
    const dot = digitsOf(m.dot)
    const hitMc = mc ? byMc.get(mc) : undefined
    const hitDot = dot ? byDot.get(dot) : undefined
    if (hitMc && hitDot && hitMc.id !== hitDot.id) {
      bump(counts, 'CARRIER', 'conflicts')
      summary.conflicts += 1
      findings.push({ code: 'CARRIER_MC_DOT_SPLIT', detail: `carrier id ${m.id}: MC and DOT belong to different BCAT carriers` })
      review.push({ key: m.id, reason: 'MC and DOT resolve to different existing carriers' })
      continue
    }
    let link = hitMc ?? hitDot
    let how: 'MC_DOT' | 'ID' = 'MC_DOT'
    if (!link) {
      link = [m.id, ...m.aliases].map((c) => byCode.get(c)).find(Boolean)
      how = 'ID'
    }
    if (!link) {
      const row = newCarrierRow(m)
      if (!mc && !dot) findings.push({ code: 'CARRIER_NO_IDENTIFIERS', detail: `carrier id ${m.id}` })
      creates.push(row)
      index(row)
      bump(counts, 'CARRIER', 'created')
      summary.created += 1
      continue
    }
    summary[how === 'MC_DOT' ? 'matchedByMcDot' : 'matchedByAljexId'] += 1
    // Same MC/DOT under a different name: linked, never overwritten, listed for a person.
    if (how === 'MC_DOT' && carrierKey(text(link.name)) !== carrierKey(m.name)) {
      summary.nameConflicts += 1
      findings.push({ code: 'CARRIER_NAME_DIFFERS', detail: `carrier id ${m.id}` })
      review.push({ key: m.id, reason: 'same MC/DOT as an existing carrier with a different name' })
    }
    const have = new Set<string>([text(link.aljexCode), ...(((link.aljexAliases as string[] | undefined) ?? []))].filter(Boolean))
    const incoming = [m.id, ...m.aliases].filter((c) => !have.has(c))
    const patch: EngineRow = {}
    if (!text(link.aljexCode)) {
      patch.aljexCode = m.id
      const rest = incoming.filter((c) => c !== m.id)
      if (rest.length || have.size) patch.aljexAliases = [...have, ...rest]
    } else if (incoming.length) patch.aljexAliases = [...((link.aljexAliases as string[] | undefined) ?? []), ...incoming]
    if (!text(link.mcNumber) && mc) patch.mcNumber = mc
    if (!text(link.dotNumber) && dot) patch.dotNumber = dot
    if (!text(link.phone) && m.phone) patch.phone = m.phone
    if (typeof link.paymentTermsDays !== 'number' && m.termsDays != null) patch.paymentTermsDays = m.termsDays
    if (link.quickPayEligible == null && m.quickPay.eligible) {
      patch.quickPayEligible = true
      if (m.quickPay.days != null) patch.defaultQuickPayDays = m.quickPay.days
    }
    if (Object.keys(patch).length) {
      await store.update('carrier', text(link.id), patch)
      index({ ...link, ...patch })
      audits.push(auditRow(`car-master:${m.id}:${env.runId}`, 'Carrier', text(link.id), 'ALJEX_IMPORT_LINK', { aljexCode: m.id, aliases: m.aliases.length, fields: Object.keys(patch) }))
      bump(counts, 'CARRIER', 'enriched')
      summary.enriched += 1
    } else bump(counts, 'CARRIER', 'matched')
  }
  await store.batchPut('carrier', creates)
  await store.batchPut('auditLog', audits)
  return { entity: 'CARRIERS', summary, review }
}
