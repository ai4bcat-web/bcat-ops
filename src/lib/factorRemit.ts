/**
 * One remittance e-mail per factoring company.
 *
 * A factor is not a record of its own: it is the `factorName` written on each carrier's payment method.
 * The address a factor wants remittances at is the same for every carrier it funds, so it is kept once, in
 * `TmsSettings.factorRemitEmails`, keyed by the factor's normalized name. Whenever a carrier is paid through
 * a factor, that one address wins over whatever copy sits on the carrier's own payment method or on a bill.
 * A factor with no address of its own falls back to the carriers' copies, so nothing needs backfilling.
 *
 * Pure, and shared by the web app and the finance Lambda so the Payable column and the e-mail it sends can
 * never disagree about who gets the remittance.
 */

export interface FactorRemitEntry {
  /** The factor's name as it was first typed, for display. */
  name: string
  email: string
  updatedAt?: string | null
  updatedBy?: string | null
}

export type FactorRemitMap = Record<string, FactorRemitEntry>

const LEGAL_SUFFIX = /\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LP|LLP|THE)\b/g

/**
 * The key a factor is filed under: upper case, `&` as AND, punctuation and legal suffixes dropped. Offices
 * of one company ("JD Factors (Ontario Office)") keep their own keys, because they often have their own
 * remittance address.
 */
export function factorKeyOf(name: string | null | undefined): string {
  return String(name ?? '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export function isRemitEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_SHAPE.test(value)
}

/** AppSync hands a JSON field back as a string; the Lambda reads it as an object. */
export function parseFactorRemitMap(raw: unknown): FactorRemitMap {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return {} }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: FactorRemitMap = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const email = typeof e.email === 'string' ? e.email.trim() : ''
    if (!key || !email) continue
    out[key] = {
      name: typeof e.name === 'string' && e.name ? e.name : key,
      email,
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : null,
      updatedBy: typeof e.updatedBy === 'string' ? e.updatedBy : null,
    }
  }
  return out
}

/** The address set for this factor, or ''. */
export function factorEmailFor(map: FactorRemitMap | null | undefined, factorName: string | null | undefined): string {
  const key = factorKeyOf(factorName)
  return (key && map?.[key]?.email?.trim()) || ''
}

interface PayeeLike {
  recipientType?: string | null
  factorName?: string | null
  payeeEmail?: string | null
}

/** True when this payment method pays a factor that has a name to file the address under. */
export function paysThroughFactor(info: PayeeLike | null | undefined): boolean {
  return info?.recipientType === 'FACTOR' && factorKeyOf(info.factorName) !== ''
}

/** The address remittance goes to for a payment method: the factor's own, else the copy on the method. */
export function effectivePayeeEmail(info: PayeeLike | null | undefined, map: FactorRemitMap | null | undefined): string {
  if (!info) return ''
  if (paysThroughFactor(info)) {
    const shared = factorEmailFor(map, info.factorName)
    if (shared) return shared
  }
  return (info.payeeEmail ?? '').trim()
}

/** The same rows with a factor's one address laid over every method that pays through it. */
export function applyFactorRemit<T extends PayeeLike>(infos: readonly T[], map: FactorRemitMap | null | undefined): T[] {
  if (!map || Object.keys(map).length === 0) return [...infos]
  return infos.map((info) => {
    if (!paysThroughFactor(info)) return info
    const shared = factorEmailFor(map, info.factorName)
    return shared ? { ...info, payeeEmail: shared } : info
  })
}

export type FactorEmailSource = 'SET' | 'CARRIERS' | 'CONFLICT' | 'NONE'

export interface FactorSummary {
  key: string
  /** The name most carriers use, for display. */
  name: string
  /** Other spellings of the same key that are on file. */
  otherNames: string[]
  carrierCount: number
  /** The address in force: the one set on the factor, else the one every carrier shares. */
  email: string
  source: FactorEmailSource
  /** Different addresses the carriers carry today, when there is no address set on the factor. */
  conflicting: string[]
}

/** One row per factoring company, from the payment methods that name one and any address already set. */
export function summarizeFactors(
  infos: ReadonlyArray<PayeeLike & { carrierId?: string | null; status?: string | null }>,
  map: FactorRemitMap | null | undefined,
): FactorSummary[] {
  interface Acc { names: Map<string, number>; carriers: Set<string>; emails: Map<string, number> }
  const byKey = new Map<string, Acc>()
  for (const info of infos) {
    if (!paysThroughFactor(info) || info.status === 'INACTIVE') continue
    const key = factorKeyOf(info.factorName)
    const acc = byKey.get(key) ?? { names: new Map(), carriers: new Set(), emails: new Map() }
    const name = String(info.factorName).trim()
    acc.names.set(name, (acc.names.get(name) ?? 0) + 1)
    acc.carriers.add(String(info.carrierId ?? `${key}:${acc.carriers.size}`))
    const email = (info.payeeEmail ?? '').trim().toLowerCase()
    if (email) acc.emails.set(email, (acc.emails.get(email) ?? 0) + 1)
    byKey.set(key, acc)
  }
  // A factor that was given an address but has no carriers on file still deserves a row.
  for (const [key, entry] of Object.entries(map ?? {})) {
    if (!byKey.has(key)) byKey.set(key, { names: new Map([[entry.name, 0]]), carriers: new Set(), emails: new Map() })
  }
  const rows: FactorSummary[] = []
  for (const [key, acc] of byKey) {
    const names = [...acc.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n)
    const set = map?.[key]?.email?.trim() ?? ''
    const carrierEmails = [...acc.emails.keys()]
    let email = set
    let source: FactorEmailSource = 'SET'
    if (!set) {
      if (carrierEmails.length === 1) { email = carrierEmails[0]!; source = 'CARRIERS' }
      else if (carrierEmails.length > 1) { email = ''; source = 'CONFLICT' }
      else { email = ''; source = 'NONE' }
    }
    // A name filed on the factor wins, so the table and every carrier view spell the factor one way.
    const setName = map?.[key]?.name?.trim() ?? ''
    const ordered = setName ? [setName, ...names.filter((n) => n !== setName)] : names
    rows.push({
      key,
      name: ordered[0] ?? key,
      otherNames: ordered.slice(1),
      carrierCount: acc.carriers.size,
      email,
      source,
      conflicting: source === 'CONFLICT' ? carrierEmails : [],
    })
  }
  return rows.sort((a, b) => b.carrierCount - a.carrierCount || a.name.localeCompare(b.name))
}

/** Factor key to the one spelling of its name, as the Factoring companies table shows it. */
export type FactorNameIndex = ReadonlyMap<string, string>

/** A key with the spaces gone, so "First Line Funding" and "FIRSTLINE FUNDING" meet. Filed under a `~` prefix. */
const compactKey = (key: string) => `~${key.replace(/ /g, '')}`

export function factorNameIndex(summaries: readonly Pick<FactorSummary, 'key' | 'name'>[]): FactorNameIndex {
  const index = new Map<string, string>()
  for (const s of summaries) index.set(s.key, s.name)
  for (const s of summaries) if (!index.has(compactKey(s.key))) index.set(compactKey(s.key), s.name)
  return index
}

/**
 * A factor's name the way the Factoring companies table spells it. Every place that shows a carrier's
 * factor goes through this, so "OTR Capital" and "OTR CAPITAL LLC" never appear side by side. A name the
 * index does not know is shown as typed.
 */
export function canonicalFactorName(index: FactorNameIndex | null | undefined, name: string | null | undefined): string {
  const typed = String(name ?? '').trim()
  if (!typed) return ''
  const key = factorKeyOf(typed)
  return index?.get(key) ?? index?.get(compactKey(key)) ?? typed
}
