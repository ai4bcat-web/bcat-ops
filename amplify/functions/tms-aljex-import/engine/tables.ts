/**
 * Table targets and the guards around them (plan §4.7): never production, never live dev unless
 * explicitly tagged, rehearsal copies only as `<live>-rh<tag>`.
 */
import type { AljexImportJob, EngineTable, EngineTargetPolicy, TableSet } from '../../../../src/types/tms'

export const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
export const DEV_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE'
export const TAG_PATTERN = /^[a-z0-9]{3,12}$/
const SUFFIX_SHAPE = /^[a-z0-9]{20,32}-NONE$/

/**
 * The Lambda's OWN stack suffix (the dev branch or the rehearsal branch), read from the table names Amplify gave it
 * (`Order-<apiId>-NONE`). Honoured ONLY with BCAT_DEV_STACK=true (set on those branches; the synth guard forbids it on
 * main), and never when it is the production suffix. Null = only the hard-coded dev suffix is a dev-stack table.
 */
export function ownStackSuffix(env: Record<string, string | undefined> = process.env): string | null {
  if (env.BCAT_DEV_STACK !== 'true') return null
  const suffixes = [env.ORDER_TABLE_NAME, env.LOAD_TABLE_NAME].map((n) => (n ? n.slice(n.indexOf('-') + 1) : ''))
  const [a, b] = suffixes
  if (!a || a !== b || !SUFFIX_SHAPE.test(a) || a.includes(PROD_SUFFIX)) return null
  return a
}

function devTablePattern(env: Record<string, string | undefined>): RegExp {
  const own = ownStackSuffix(env)
  const suffixes = own && own !== DEV_SUFFIX ? [DEV_SUFFIX, own] : [DEV_SUFFIX]
  return new RegExp(`-(${suffixes.join('|')})(-rh[a-z0-9]{3,12})?$`)
}

/** Tables the engine writes. Everything else in TableSet is read-only reference data (or the job/profile rows, always live). */
export const WRITTEN_TABLES = [
  'shipment',
  'order',
  'load',
  'loadCarrier',
  'loadFinancials',
  'loadCharge',
  'customer',
  'location',
  'carrier',
  'invoice',
  'arPayment',
  'carrierBill',
  'apPayment',
  'proClaim',
  'settings',
  'auditLog',
  'legacyAljexRow',
] as const satisfies readonly EngineTable[]

/** DynamoDB / AppSync model name per logical table (used for `__typename`). */
export const MODEL_NAME: Record<EngineTable, string> = {
  shipment: 'Shipment',
  order: 'Order',
  load: 'Load',
  loadCarrier: 'LoadCarrier',
  loadFinancials: 'LoadFinancials',
  loadCharge: 'LoadCharge',
  customer: 'Customer',
  location: 'Location',
  carrier: 'Carrier',
  invoice: 'Invoice',
  arPayment: 'ArPayment',
  carrierBill: 'CarrierBill',
  apPayment: 'ApPayment',
  proClaim: 'ProClaim',
  settings: 'TmsSettings',
  auditLog: 'AuditLog',
  legacyAljexRow: 'LegacyAljexRow',
  aljexImportJob: 'AljexImportJob',
  aljexMappingProfile: 'AljexMappingProfile',
  factoringItem: 'FactoringItem',
  driver: 'Driver',
  userProfile: 'UserProfile',
  ownershipDivision: 'OwnershipDivision',
  ownershipRule: 'OwnershipRule',
  division: 'Division',
  integration: 'Integration',
}

/**
 * GSI key attributes per table (hash and sort). DynamoDB refuses '' / NULL for any of them, so the
 * engine omits them when unknown and the in-memory store rejects a violation the same way.
 */
export const INDEX_KEYS: Partial<Record<EngineTable, string[]>> = {
  shipment: ['number', 'status', 'pickupAppt', 'customerId', 'pickupMonth'],
  order: ['shipmentId', 'customerId', 'pickupAppt', 'arStatus', 'arStatusChangedAt'],
  load: ['customerId', 'shipmentId', 'status', 'checkCallOpen', 'nextCheckCallAt'],
  loadCarrier: ['loadId', 'shipmentId', 'carrierId', 'apOpen', 'apStatusChangedAt'],
  invoice: ['customerId', 'issuedAt', 'arOpen', 'dueAt', 'invoiceMonth'],
  carrierBill: ['carrierId', 'recordedAt', 'apOpen', 'dueAt', 'billMonth'],
  arPayment: ['customerId', 'receivedAt'],
  apPayment: ['carrierId', 'paidAt'],
  loadCharge: ['shipmentId', 'sortOrder'],
  customer: ['normalizedName'],
  location: ['normalizedName', 'normalizedAddress', 'mergedIntoId'],
  carrier: ['normalizedName', 'status', 'name', 'mcNumber', 'dotNumber'],
}

export interface TargetOptions {
  target: 'LIVE' | 'REHEARSAL'
  targetTag?: string | null
}

/** Rehearsal tables are unmanaged siblings `<live>-rh<tag>`; reference/job tables stay on the live names. */
export function resolveTables(live: TableSet, opts: TargetOptions): TableSet {
  if (opts.target === 'LIVE') return { ...live }
  const tag = opts.targetTag ?? ''
  if (!TAG_PATTERN.test(tag)) throw new Error('A rehearsal target needs a tag of 3-12 lowercase letters/digits')
  const out: TableSet = { ...live }
  for (const t of WRITTEN_TABLES) out[t] = `${live[t]}-rh${tag}`
  return out
}

/** The live names behind a (possibly rehearsal) table set: strips one trailing `-rh<tag>` from every name. */
export function liveTablesOf(tables: TableSet): TableSet {
  const out = { ...tables }
  for (const key of Object.keys(out) as EngineTable[]) out[key] = out[key].replace(/-rh[a-z0-9]{3,12}$/, '')
  return out
}

export class TargetRefused extends Error {}

const DEV_WRITE_SUFFIX = new RegExp(`^${DEV_SUFFIX}(-rh[a-z0-9]{3,12})?$`)

/** The full table set for a policy: written tables on `writeSuffix`, every other (read-only) table on `readSuffix`. */
export function tableSetFor(readSuffix: string, writeSuffix: string): TableSet {
  const written = new Set<string>(WRITTEN_TABLES)
  return Object.fromEntries(Object.entries(MODEL_NAME).map(([k, model]) => [k, `${model}-${written.has(k) ? writeSuffix : readSuffix}`])) as unknown as TableSet
}

/**
 * The only way to let the engine touch non-dev tables: the OFFLINE CLI calls this after the production gate passed
 * (scripts/lib/prodGate.mjs). `writeSuffix` is the production suffix, or - for the test-only rehearsal seam - the dev
 * suffix (optionally `-rh<tag>`); the two stacks are never mixed (a production write set reads production reference
 * tables, a dev-shaped one reads dev reference tables). Anything else is refused here.
 */
export function productionPolicy(writeSuffix: string): EngineTargetPolicy {
  if (writeSuffix === PROD_SUFFIX) return { readSuffix: PROD_SUFFIX, writeSuffix, production: true }
  if (DEV_WRITE_SUFFIX.test(writeSuffix)) return { readSuffix: DEV_SUFFIX, writeSuffix, production: true }
  throw new TargetRefused(`Production mode writes ${PROD_SUFFIX} (or, in the rehearsal seam, a dev suffix), never "${writeSuffix}"`)
}

/**
 * PRODUCTION REHEARSAL (an extension of the allowed set, never a loosening of LIVE): the offline CLI builds this only after the
 * production gate passed for `--target prod-rehearsal:<tag>`. A REHEARSAL job with this tag writes ONLY the `-rh<tag>` siblings of
 * the production WRITTEN tables (restored copies of production backups); every other table (job/profile/reference) is the live
 * production table and is read only. LIVE jobs never run under this policy and REHEARSAL jobs never run under `productionPolicy`.
 */
export function productionRehearsalPolicy(tag: string): EngineTargetPolicy {
  if (!TAG_PATTERN.test(tag)) throw new TargetRefused('A production rehearsal needs a tag of 3-12 lowercase letters/digits')
  return { readSuffix: PROD_SUFFIX, writeSuffix: PROD_SUFFIX, production: true, rehearsalTag: tag }
}

/** Production tables with the WRITTEN ones replaced by their `-rh<tag>` copies (reference/job tables stay on the live names). */
export function productionRehearsalTables(tag: string): TableSet {
  return resolveTables(tableSetFor(PROD_SUFFIX, PROD_SUFFIX), { target: 'REHEARSAL', targetTag: tag })
}

/**
 * Runs before every phase. Throws `TargetRefused` unless the write set is safe for this job:
 * 0. with a production `policy` (offline CLI only, after the production gate) the table set must be exactly the policy's;
 * 1. no table (read or write) names production, and every table ends with the dev suffix (optionally `-rh<tag>`);
 * 2. REHEARSAL writes only `-rh<tag>` tables with the job's tag; LIVE writes only the live tables and needs a `liveTag`.
 * (The synthetic-data and reconciled-rehearsal gates need staged data / other jobs and live in `runSlice`.)
 */
export function assertTargets(live: TableSet, written: TableSet, job: Pick<AljexImportJob, 'target' | 'targetTag' | 'liveTag'>, policy?: EngineTargetPolicy, env: Record<string, string | undefined> = process.env): void {
  if (policy?.production === true && policy.rehearsalTag !== undefined) {
    // Production rehearsal: exactly the -rh<tag> copies as written tables, production reference/job tables, a REHEARSAL job of this tag.
    const tag = policy.rehearsalTag
    if (!TAG_PATTERN.test(tag) || policy.readSuffix !== PROD_SUFFIX || policy.writeSuffix !== PROD_SUFFIX) throw new TargetRefused('Malformed production rehearsal policy')
    const want = productionRehearsalTables(tag)
    for (const key of Object.keys(want) as EngineTable[]) {
      if (written[key] !== want[key]) throw new TargetRefused(`Production rehearsal must use ${want[key]} for ${key}, got ${written[key]}`)
    }
    if (job.target !== 'REHEARSAL' || job.targetTag !== tag) throw new TargetRefused(`Production rehearsal runs REHEARSAL jobs tagged ${tag} only`)
    return
  }
  if (policy?.production === true) {
    // Production mode: exactly the policy's table set, a LIVE job, the owner's live tag. No rehearsal tables, no mixing.
    const want = tableSetFor(policy.readSuffix, policy.writeSuffix)
    for (const key of Object.keys(want) as EngineTable[]) {
      if (written[key] !== want[key]) throw new TargetRefused(`Production mode must use ${want[key]} for ${key}, got ${written[key]}`)
    }
    if ((job.target ?? 'LIVE') !== 'LIVE') throw new TargetRefused('Production mode runs LIVE jobs only')
    if (!job.liveTag || !job.liveTag.trim()) throw new TargetRefused('A production import needs the live tag typed by the owner')
    return
  }
  const devPattern = devTablePattern(env)
  for (const set of [live, written]) {
    for (const name of Object.values(set)) {
      if (name.includes(PROD_SUFFIX)) throw new TargetRefused(`Refusing to touch a production table (${name})`)
      if (!devPattern.test(name)) throw new TargetRefused(`Table ${name} is not a dev-stack table`)
    }
  }
  const target = job.target ?? 'LIVE'
  if (target === 'REHEARSAL') {
    const tag = job.targetTag ?? ''
    if (!TAG_PATTERN.test(tag)) throw new TargetRefused('A rehearsal run needs a target tag of 3-12 lowercase letters/digits')
    for (const t of WRITTEN_TABLES) {
      if (written[t] !== `${live[t]}-rh${tag}`) throw new TargetRefused(`Rehearsal table ${t} must be ${live[t]}-rh${tag}`)
    }
    return
  }
  if (!job.liveTag || !job.liveTag.trim()) throw new TargetRefused('A LIVE import needs the live tag typed by the owner')
  for (const t of WRITTEN_TABLES) {
    if (written[t] !== live[t]) throw new TargetRefused(`A LIVE import must write the live table for ${t}`)
  }
}
