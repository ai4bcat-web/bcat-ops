/**
 * One remittance e-mail per PAY TO.
 *
 * A remittance goes to whoever is paid, and the Pay to column names that: the factoring company for a carrier
 * paid through one, otherwise the payee itself. The address is kept once per pay-to, in
 * `TmsSettings.factorRemitEmails`, keyed by the normalized pay-to name (the field keeps its old name; since
 * 2026-11-19 it holds direct payees as well as factors, and a factor's key is the same as before). Whenever a
 * bill is paid to that name, that one address wins over whatever copy sits on a carrier's own payment method
 * or on a bill, so two carriers paid through the same factor, or the same payee, can never disagree.
 * A pay-to with no address of its own falls back to the carriers' copies, so nothing needs backfilling.
 *
 * Pure, and shared by the web app and the finance Lambda so the Payable column and the e-mail it sends can
 * never disagree about who gets the remittance.
 */

export interface FactorRemitEntry {
  /** The factor's name as it was first typed, for display. */
  name: string
  email: string
  /** Other spellings of this pay-to. A carrier or bill that names one of them is paid to this profile. */
  aliases?: string[]
  /** Where checks and notices go, as one line. */
  remitAddress?: string
  /** How this pay-to is paid (ACH, WIRE, CHECK, ...). Bank numbers never live here: carriers' own methods hold those. */
  paymentMethod?: string
  updatedAt?: string | null
  updatedBy?: string | null
}

export const PAY_TO_METHODS = ['ACH', 'WIRE', 'CHECK', 'ZELLE', 'VENMO', 'EFT', 'CARD'] as const
export const MAX_PAY_TO_ALIASES = 12

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

/** The key a pay-to name is filed under. Factors and direct payees share the one registry. */
export const payeeKeyOf = factorKeyOf

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
    const aliases = Array.isArray(e.aliases)
      ? e.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim())
      : []
    const remitAddress = typeof e.remitAddress === 'string' ? e.remitAddress.trim() : ''
    const paymentMethod = typeof e.paymentMethod === 'string' ? e.paymentMethod.trim() : ''
    if (!key || !(email || aliases.length || remitAddress || paymentMethod)) continue
    out[key] = {
      name: typeof e.name === 'string' && e.name ? e.name : key,
      email,
      ...(aliases.length ? { aliases } : {}),
      ...(remitAddress ? { remitAddress } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : null,
      updatedBy: typeof e.updatedBy === 'string' ? e.updatedBy : null,
    }
  }
  return out
}

/**
 * THE resolver: a pay-to name to the key of the profile it belongs to. A name that is its own profile, or one of a
 * profile's aliases, resolves to that profile; any other name is its own key. The Pay to column, the group payment
 * match and the remittance e-mail all go through here, so they cannot disagree about who is paid.
 */
export function payToKeyFor(map: FactorRemitMap | null | undefined, name: string | null | undefined): string {
  const key = factorKeyOf(name)
  if (!key || !map) return key
  if (map[key]) return key
  for (const [profileKey, entry] of Object.entries(map)) {
    if (entry.aliases?.some((alias) => factorKeyOf(alias) === key)) return profileKey
  }
  return key
}

/** The profile a pay-to name resolves to (by name or alias), or null when none is filed. */
export function payToProfileFor(map: FactorRemitMap | null | undefined, name: string | null | undefined): (FactorRemitEntry & { key: string }) | null {
  const key = payToKeyFor(map, name)
  const entry = key ? map?.[key] : undefined
  return entry ? { ...entry, key } : null
}

/** The name a pay-to is shown under: its profile's own spelling when it has one, else as typed. */
export function payToDisplayName(map: FactorRemitMap | null | undefined, name: string | null | undefined): string {
  return payToProfileFor(map, name)?.name?.trim() || String(name ?? '').trim()
}

/** The address set for this factor, or ''. */
export function factorEmailFor(map: FactorRemitMap | null | undefined, factorName: string | null | undefined): string {
  return payToProfileFor(map, factorName)?.email?.trim() || ''
}

interface PayeeLike {
  recipientType?: string | null
  factorName?: string | null
  payeeEmail?: string | null
}

/** The address filed for this pay-to name (a factor's name or a direct payee's), or ''. */
export function payeeEmailFor(map: FactorRemitMap | null | undefined, payTo: string | null | undefined): string {
  return factorEmailFor(map, payTo)
}

/** The pay-to a payment method sends money to: its factor, else the carrier (or the name frozen on the bill). */
export function payToNameFor(info: PayeeLike | null | undefined, directName: string | null | undefined): string {
  if (paysThroughFactor(info)) return String(info?.factorName ?? '').trim()
  return String(directName ?? '').trim()
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
  /** The profile filed for this pay-to (aliases, remit address, method), or null when only an address or nothing is set. */
  profile: FactorRemitEntry | null
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
    const key = payToKeyFor(map, info.factorName)
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
      profile: map?.[key] ?? null,
    })
  }
  return rows.sort((a, b) => b.carrierCount - a.carrierCount || a.name.localeCompare(b.name))
}

/** Factor key to the one spelling of its name, as the Factoring companies table shows it. */
export type FactorNameIndex = ReadonlyMap<string, string>

/** A key with the spaces gone, so "First Line Funding" and "FIRSTLINE FUNDING" meet. Filed under a `~` prefix. */
const compactKey = (key: string) => `~${key.replace(/ /g, '')}`

export function factorNameIndex(summaries: readonly (Pick<FactorSummary, 'key' | 'name'> & { profile?: FactorRemitEntry | null })[]): FactorNameIndex {
  const index = new Map<string, string>()
  for (const s of summaries) index.set(s.key, s.name)
  // A profile's alternate spellings show under the profile's own name.
  for (const s of summaries) for (const alias of s.profile?.aliases ?? []) if (!index.has(factorKeyOf(alias))) index.set(factorKeyOf(alias), s.name)
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

export type PayeeKind = 'FACTOR' | 'DIRECT'

export interface PayeeSummary extends FactorSummary {
  kind: PayeeKind
  /** The carriers paid to this name (a few, for display; the count is `carrierCount`). */
  carrierNames: string[]
}

/** The method a carrier is paid under: the preferred active one, else any active one. */
function effectiveMethod<T extends PayeeLike & { carrierId?: string | null; status?: string | null; isPreferred?: boolean | null }>(
  methods: readonly T[],
): T | null {
  const live = methods.filter((m) => m.status !== 'INACTIVE')
  return live.find((m) => m.isPreferred) ?? live[0] ?? null
}

/**
 * One row per pay-to: every factoring company, and every payee a carrier is paid directly. `carriers` give the
 * names of the direct payees (a carrier paid directly is its own pay-to). A carrier with no payment method has
 * no pay-to yet and is not a row: the Pay-to needed worklist is where those are fixed.
 */
export function summarizePayees(
  carriers: ReadonlyArray<{ id: string; name: string }>,
  infos: ReadonlyArray<PayeeLike & { carrierId?: string | null; status?: string | null; isPreferred?: boolean | null }>,
  map: FactorRemitMap | null | undefined,
): PayeeSummary[] {
  const factors = summarizeFactors(infos, map)
  const rows: PayeeSummary[] = factors.map((f) => ({ ...f, kind: 'FACTOR' as const, carrierNames: [] }))
  const taken = new Set(factors.map((f) => f.key))

  const byCarrier = new Map<string, Array<(typeof infos)[number]>>()
  for (const info of infos) {
    const id = String(info.carrierId ?? '')
    if (!id) continue
    const list = byCarrier.get(id)
    if (list) list.push(info)
    else byCarrier.set(id, [info])
  }
  interface Acc { names: Map<string, number>; carriers: Set<string>; carrierNames: Set<string>; emails: Map<string, number> }
  const direct = new Map<string, Acc>()
  for (const carrier of carriers) {
    const method = effectiveMethod(byCarrier.get(carrier.id) ?? [])
    if (!method || paysThroughFactor(method)) continue
    const key = payToKeyFor(map, carrier.name)
    if (!key || taken.has(key)) continue
    const acc = direct.get(key) ?? { names: new Map(), carriers: new Set(), carrierNames: new Set(), emails: new Map() }
    const name = carrier.name.trim()
    acc.names.set(name, (acc.names.get(name) ?? 0) + 1)
    acc.carriers.add(carrier.id)
    acc.carrierNames.add(name)
    const email = (method.payeeEmail ?? '').trim().toLowerCase()
    if (email) acc.emails.set(email, (acc.emails.get(email) ?? 0) + 1)
    direct.set(key, acc)
  }
  // A direct payee that was given an address but is no longer on any carrier still deserves its row.
  for (const [key, entry] of Object.entries(map ?? {})) {
    if (!taken.has(key) && !direct.has(key)) {
      direct.set(key, { names: new Map([[entry.name, 0]]), carriers: new Set(), carrierNames: new Set(), emails: new Map() })
    }
  }
  for (const [key, acc] of direct) {
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
      kind: 'DIRECT',
      carrierNames: [...acc.carrierNames].slice(0, 5),
      profile: map?.[key] ?? null,
    })
  }
  return rows.sort((a, b) => b.carrierCount - a.carrierCount || a.name.localeCompare(b.name))
}

export interface LinkedCarrier {
  id: string
  name: string
  /** How the carrier reaches this pay-to: through a factor it names, or paid directly as itself. */
  via: 'FACTOR' | 'DIRECT'
  /** The name the carrier's own payment method carries (a factor's typed spelling), when it differs from the profile's. */
  typedName: string
}

/** Every carrier paid to this profile, by its name or any alias: through a factor it names, or directly as itself. */
export function linkedCarriers(
  key: string,
  carriers: ReadonlyArray<{ id: string; name: string }>,
  infos: ReadonlyArray<PayeeLike & { carrierId?: string | null; status?: string | null; isPreferred?: boolean | null }>,
  map: FactorRemitMap | null | undefined,
): LinkedCarrier[] {
  const byCarrier = new Map<string, Array<(typeof infos)[number]>>()
  for (const info of infos) {
    const id = String(info.carrierId ?? '')
    if (!id) continue
    const list = byCarrier.get(id)
    if (list) list.push(info)
    else byCarrier.set(id, [info])
  }
  const out: LinkedCarrier[] = []
  for (const carrier of carriers) {
    const method = effectiveMethod(byCarrier.get(carrier.id) ?? [])
    if (!method) continue
    if (paysThroughFactor(method)) {
      if (payToKeyFor(map, method.factorName) === key) out.push({ id: carrier.id, name: carrier.name, via: 'FACTOR', typedName: String(method.factorName).trim() })
    } else if (payToKeyFor(map, carrier.name) === key) {
      out.push({ id: carrier.id, name: carrier.name, via: 'DIRECT', typedName: carrier.name.trim() })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ── The remit address ────────────────────────────────────────────────────────

/** One line for an address object ("street, city, ST zip"), or '' when it holds nothing. */
export function addressLineOf(address: object | null | undefined): string {
  if (!address) return ''
  const fields = address as Record<string, unknown>
  const text = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string).trim() : '')
  const stateZip = [text('state'), text('zip')].filter(Boolean).join(' ')
  return [text('street'), text('street2'), text('city'), stateZip].filter(Boolean).join(', ')
}

/**
 * A profile keeps its remit address as one line; a document prints street and city lines. "123 Main St, Dallas, TX 75001"
 * splits into its parts; anything else prints whole on the street line, so nothing typed is ever dropped.
 */
export function remitAddressFromLine(line: string | null | undefined): { street: string; city: string | null; state: string | null; zip: string | null } | null {
  const text = String(line ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return null
  const parts = /^(.+),\s*([^,]+),\s*([A-Za-z]{2})\.?,?\s+(\d{5}(?:-\d{4})?)$/.exec(text)
  if (parts) return { street: parts[1]!.trim(), city: parts[2]!.trim(), state: parts[3]!.toUpperCase(), zip: parts[4]! }
  return { street: text, city: null, state: null, zip: null }
}

interface RemitToLike {
  name?: string | null
  factorName?: string | null
  payeeEmail?: string | null
  address?: object | null
}

/**
 * The remit address for a pay-to: the profile's own wins, and the address the carrier (or the bill) carries stays as the
 * fallback, so a pay-to with no profile address reads exactly what it did before.
 */
export function remitAddressFor(map: FactorRemitMap | null | undefined, payTo: string | null | undefined, fallback?: object | null): string {
  return payToProfileFor(map, payTo)?.remitAddress?.trim() || addressLineOf(fallback)
}

/**
 * What a document prints as "remit to": the same frozen snapshot, with the pay-to profile's address and e-mail laid over it.
 * Resolved when the page is drawn, never written back, so a recorded bill keeps what it was recorded with.
 */
export function withPayToProfile<T extends RemitToLike>(remitTo: T | null | undefined, map: FactorRemitMap | null | undefined): T | null {
  if (!remitTo) return null
  const profile = payToProfileFor(map, remitTo.factorName?.trim() || remitTo.name)
  if (!profile) return remitTo
  const address = remitAddressFromLine(profile.remitAddress)
  return {
    ...remitTo,
    ...(address ? { address } : {}),
    ...(profile.email?.trim() ? { payeeEmail: profile.email.trim() } : {}),
  } as T
}
