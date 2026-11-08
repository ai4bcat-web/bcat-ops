/**
 * MyCarrierPackets is the source of truth for a carrier's compliance profile. This file is the
 * pure half: a GetCarrierData / CarrierDetails body -> `McpProfile`, an `McpProfile` -> the
 * Carrier row patch, the CarrierContact rows and the CarrierPaymentMethod row, and the
 * MC -> DOT -> name matcher. Nothing here reads or writes a table; `mcpPull.ts` does.
 *
 * Field map: Docs/tms-build/MCP_INTEGRATION.md. MCP values win over hand-typed ones, and
 * `fieldChanges` records exactly what was filled and what was overwritten.
 *
 * Never carried anywhere: SSN, full bank account or routing numbers. Payment keeps last four only.
 */
import { normalizeName as carrierNormalizeKey } from '../tmsDirectory'
import { applyMcpUpdate, dotOf, docketOf, field, flat, isoOf, list, mergeInsurancePolicies, normalizeMcpCarrier, text } from './mcpAdapter'
import type { McpCarrier } from './mcpAdapter'

type Row = Record<string, unknown>

export interface McpAddress {
  street?: string
  city?: string
  state?: string
  zip?: string
  country?: string
}

export interface McpContact {
  name: string
  email?: string
  phone?: string
  types: string[]
}

export interface McpPayment {
  method: 'ACH' | 'CHECK'
  recipientType: 'CARRIER' | 'FACTOR'
  factorName?: string
  factorAddress?: McpAddress
  bankName?: string
  accountName?: string
  accountLast4?: string
  routingLast4?: string
  payeeEmail?: string
  remitToAddress?: McpAddress
}

export interface McpProfile {
  carrier: McpCarrier
  /** True when the body carried packet data. A changes-feed item does not, and must not reset mcpStatus. */
  packetKnown: boolean
  legalName?: string
  dbaName?: string
  phone?: string
  email?: string
  website?: string
  address?: McpAddress
  taxId?: string
  powerUnits?: number
  authorityGrantedAt?: string
  safetyRatingAt?: string
  contacts: McpContact[]
  payment?: McpPayment
}

const last4 = (v: string | undefined): string | undefined => {
  const digits = (v ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : undefined
}

const addressOf = (street: unknown, street2: unknown, city: unknown, state: unknown, zip: unknown, country: unknown): McpAddress | undefined => {
  const out: McpAddress = {}
  const s = [text(street), text(street2)].filter(Boolean).join(' ')
  if (s) out.street = s
  if (text(city)) out.city = text(city)
  if (text(state)) out.state = text(state)
  if (text(zip)) out.zip = text(zip)
  if (text(country)) out.country = text(country)
  return out.street || out.city ? out : undefined
}

/** MCP free text for "contact types" is ours to assign; unknown sources are plain contacts. */
function contactsOf(root: unknown, cd: unknown): McpContact[] {
  const out: McpContact[] = []
  const add = (name: unknown, email: unknown, phone: unknown, types: string[]) => {
    const n = text(name)
    if (!n && !text(email)) return
    out.push({ name: n ?? text(email)!, ...(text(email) ? { email: text(email)!.toLowerCase() } : {}), ...(text(phone) ? { phone: text(phone)! } : {}), types })
  }
  for (const d of list(field(root, 'CarrierDispatchers'))) add(field(d, 'DispatcherName'), field(d, 'Email'), field(d, 'PhoneNumber'), ['DISPATCH'])
  add(field(root, 'ClaimsContactName'), field(root, 'ClaimsContactEmail'), field(root, 'ClaimsContactPhone'), ['CLAIMS'])
  add(field(root, 'OwnerContactName'), field(root, 'OwnerContactEmail'), field(root, 'OwnerContactPhone'), ['OWNER'])
  add(field(root, 'AfterHrsWkDaySupportName'), undefined, field(root, 'AfterHrsWkDaySupportPhone'), ['AFTER_HOURS'])
  add(field(root, 'OperationManagerName'), undefined, undefined, ['MANAGER'])
  // PreviewCarrier's approved e-mails: addresses MCP has verified for this carrier.
  for (const e of list(field(root, 'Emails')).concat(list(field(cd, 'Emails')))) add(undefined, field(e, 'Email'), undefined, [])
  // The same person under two hats is one contact with two types.
  const merged = new Map<string, McpContact>()
  for (const c of out) {
    const key = c.email ?? `${flat(c.name)}|${(c.phone ?? '').replace(/\D/g, '')}`
    const prev = merged.get(key)
    if (!prev) merged.set(key, { ...c, types: [...c.types] })
    else {
      for (const t of c.types) if (!prev.types.includes(t)) prev.types.push(t)
      prev.phone ??= c.phone
    }
  }
  return [...merged.values()]
}

function paymentOf(root: unknown): McpPayment | undefined {
  const info = field(root, 'CarrierPaymentInfo')
  const bank = field(root, 'CarrierBank')
  const factoring = field(root, 'FactoringRemit')
  const carrierRemit = field(root, 'CarrierRemit')
  const factorName = text(field(factoring, 'FactoringCompanyName')) ?? text(field(info, 'FactoringCompanyName'))
  const account = text(field(bank, 'CarrierBankAccountNumber')) ?? text(field(info, 'BankAccountNumber'))
  const routing = text(field(bank, 'CarrierBankRoutingNumber')) ?? text(field(info, 'BankRoutingNumber'))
  const bankName = text(field(bank, 'CarrierBankName')) ?? text(field(info, 'BankName'))
  const accountName = text(field(bank, 'CarrierBankAccountName')) ?? text(field(info, 'BankAccountName'))

  const remit = factorName
    ? addressOf(field(factoring, 'FactoringRemitAddress'), field(factoring, 'FactoringRemitAddress2'), field(factoring, 'FactoringRemitCity'), field(factoring, 'FactoringRemitStateProvince'), field(factoring, 'FactoringRemitZipcode'), field(factoring, 'FactoringRemitCountry'))
    : addressOf(field(carrierRemit, 'CarrierRemitAddress1') ?? field(info, 'RemitAddress1'), field(carrierRemit, 'CarrierRemitAddress2') ?? field(info, 'RemitAddress2'), field(carrierRemit, 'CarrierRemitCity') ?? field(info, 'RemitCity'), field(carrierRemit, 'CarrierRemitStateProvince') ?? field(info, 'RemitState'), field(carrierRemit, 'CarrierRemitZipCode') ?? field(info, 'RemitZipCode'), field(carrierRemit, 'CarrierRemitCountry') ?? field(info, 'RemitCountry'))
  const payeeEmail = (factorName ? text(field(factoring, 'FactoringRemitEmail')) : (text(field(carrierRemit, 'CarrierRemitEmail')) ?? text(field(info, 'RemitEmail'))))?.toLowerCase()

  if (!factorName && !account && !remit && !payeeEmail) return undefined
  return {
    method: account && routing ? 'ACH' : 'CHECK',
    recipientType: factorName ? 'FACTOR' : 'CARRIER',
    ...(factorName ? { factorName, ...(remit ? { factorAddress: remit } : {}) } : {}),
    ...(bankName ? { bankName } : {}),
    ...(accountName ? { accountName } : {}),
    ...(last4(account) ? { accountLast4: last4(account) } : {}),
    ...(last4(routing) ? { routingLast4: last4(routing) } : {}),
    ...(payeeEmail ? { payeeEmail } : {}),
    ...(!factorName && remit ? { remitToAddress: remit } : {}),
  }
}

/** A GetCarrierData body, a PreviewCarrier row or a bare CarrierDetails item. Null when MCP knows no carrier. */
export function normalizeMcpProfile(raw: unknown, ref: { mcNumber?: string; dotNumber?: string } = {}, nowMs: number = Date.now()): McpProfile | null {
  const root = Array.isArray(raw) ? raw[0] : raw
  const carrier = normalizeMcpCarrier(root, ref, nowMs)
  if (!carrier) return null
  const cd = field(list(field(root, 'AssureAdvantage'))[0], 'CarrierDetails') ?? root
  const identity = field(cd, 'Identity')
  const authority = field(cd, 'Authority')
  const packetKnown = ['CarrierCustomerPacketStatuses', 'CarrierCustomerAgreements', 'CarrierRating', 'OnCurrentCustomerAgreement'].some((k) => field(root, k) !== undefined)

  const w9 = list(field(root, 'CarrierW9Forms')).find((f) => field(f, 'IsActive') !== false) ?? list(field(root, 'CarrierW9Forms'))[0]
  const ein = (text(field(w9, 'EIN')) ?? '').replace(/\D/g, '')
  const units = Number(field(field(root, 'CarrierOperationalDetail'), 'TotalPowerUnits'))
  const legalName = text(field(root, 'LegalName')) ?? text(field(root, 'CompanyName')) ?? text(field(identity, 'legalName'))
  const email = text(field(root, 'Email')) ?? text(field(identity, 'emailAddress'))

  return {
    carrier,
    packetKnown,
    ...(legalName ? { legalName } : {}),
    ...(text(field(root, 'DBAName')) ?? text(field(identity, 'dbaName')) ? { dbaName: (text(field(root, 'DBAName')) ?? text(field(identity, 'dbaName')))! } : {}),
    ...(text(field(root, 'Phone')) ?? text(field(identity, 'businessPhone')) ? { phone: (text(field(root, 'Phone')) ?? text(field(identity, 'businessPhone')))! } : {}),
    ...(email ? { email: email.toLowerCase() } : {}),
    ...(text(field(root, 'Website')) ? { website: text(field(root, 'Website'))! } : {}),
    ...((): { address?: McpAddress } => {
      const a = addressOf(field(root, 'Address1') ?? field(identity, 'businessStreet') ?? field(root, 'Street'), field(root, 'Address2'), field(root, 'City') ?? field(identity, 'businessCity'), field(root, 'State') ?? field(identity, 'businessState'), field(root, 'Zipcode') ?? field(root, 'ZipCode') ?? field(identity, 'businessZipCode'), field(root, 'Country') ?? field(identity, 'businessCountry'))
      return a ? { address: a } : {}
    })(),
    ...(ein.length === 9 ? { taxId: `${ein.slice(0, 2)}-${ein.slice(2)}` } : {}),
    ...(Number.isFinite(units) && units > 0 ? { powerUnits: units } : {}),
    ...(isoOf(field(authority, 'authGrantDate')) ? { authorityGrantedAt: isoOf(field(authority, 'authGrantDate'))! } : {}),
    ...(isoOf(field(field(cd, 'Safety'), 'ratingDate')) ? { safetyRatingAt: isoOf(field(field(cd, 'Safety'), 'ratingDate'))! } : {}),
    contacts: contactsOf(root, cd),
    ...(paymentOf(root) ? { payment: paymentOf(root)! } : {}),
  }
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** "MC-0123" / "123" / "mc 123" -> "MC123"; FF and MX docket prefixes are kept. */
export function mcKey(raw: unknown): string | null {
  const d = docketOf(typeof raw === 'string' ? raw : undefined)
  if (!d) return null
  const m = d.match(/^MC0*(\d+)$/)
  return m ? `MC${m[1]}` : d
}

export function dotKey(raw: unknown): string | null {
  const d = dotOf(typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined)
  return d ? String(Number(d)) : null
}

export type MatchedBy = 'MC' | 'DOT' | 'NAME'

export interface CarrierIndex {
  byMc: Map<string, Row[]>
  byDot: Map<string, Row[]>
  byName: Map<string, Row[]>
}

export function buildCarrierIndex(rows: readonly Row[]): CarrierIndex {
  const idx: CarrierIndex = { byMc: new Map(), byDot: new Map(), byName: new Map() }
  for (const row of rows) addToIndex(idx, row)
  return idx
}

export function addToIndex(idx: CarrierIndex, row: Row): void {
  const push = (map: Map<string, Row[]>, key: string | null) => {
    if (!key) return
    const list = map.get(key)
    if (list) list.push(row)
    else map.set(key, [row])
  }
  push(idx.byMc, mcKey(row.mcNumber))
  push(idx.byDot, dotKey(row.dotNumber))
  push(idx.byName, carrierNormalizeKey(typeof row.name === 'string' ? row.name : ''))
}

/** MC, then DOT, then normalised name. A name matches only when exactly one carrier wears it. */
export function matchCarrier(idx: CarrierIndex, profile: McpProfile): { rows: Row[]; by: MatchedBy } | null {
  const mc = mcKey(profile.carrier.mcNumber)
  if (mc && idx.byMc.has(mc)) return { rows: idx.byMc.get(mc)!, by: 'MC' }
  const dot = dotKey(profile.carrier.dotNumber)
  if (dot && idx.byDot.has(dot)) return { rows: idx.byDot.get(dot)!, by: 'DOT' }
  const name = carrierNormalizeKey(profile.legalName ?? '')
  const named = name ? idx.byName.get(name) : undefined
  if (named?.length === 1) return { rows: named, by: 'NAME' }
  return null
}

// ── Carrier row patch ────────────────────────────────────────────────────────

export interface FieldChange {
  before: unknown
  after: unknown
  kind: 'FILLED' | 'OVERWROTE'
}

const blank = (v: unknown): boolean => v == null || v === '' || (Array.isArray(v) && v.length === 0)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** What the audit may show of a value: policies are summarised (the tax id never reaches a patch). */
export function auditValue(key: string, value: unknown): unknown {
  if (key === 'insurancePolicies' && Array.isArray(value)) {
    return value.map((p: Row) => `${String(p.type)} limit=${p.limitCents ?? '-'} exp=${String(p.expiresAt ?? '-').slice(0, 10)}`)
  }
  return value
}

/**
 * The Carrier fields MyCarrierPackets sets, as a patch against `existing`, plus exactly which
 * values it filled and which it overwrote. Only differences are in the patch; an empty `patch`
 * means the row already says what MCP says.
 */
export function mapProfileToCarrier(existing: Row, profile: McpProfile): { patch: Row; changes: Record<string, FieldChange> } {
  const want: Row = {}
  if (profile.legalName) {
    want.name = profile.legalName
    want.normalizedName = carrierNormalizeKey(profile.legalName)
  }
  if (profile.dbaName) want.dbaName = profile.dbaName
  if (profile.carrier.dotNumber) want.dotNumber = profile.carrier.dotNumber
  if (profile.carrier.mcNumber && blank(existing.mcNumber)) want.mcNumber = profile.carrier.mcNumber
  if (profile.phone) want.phone = profile.phone
  if (profile.email) want.email = profile.email
  if (profile.website) want.website = profile.website
  if (profile.address) want.address = profile.address
  // The tax id never rides the Carrier patch: mcpPull hands `profile.taxId` to the encrypted vault (deps.setTaxId).
  if (profile.powerUnits) want.powerUnits = profile.powerUnits
  if (profile.authorityGrantedAt) want.authorityGrantedAt = profile.authorityGrantedAt
  if (profile.safetyRatingAt) want.safetyRatingAt = profile.safetyRatingAt
  if (profile.carrier.authorityStatus) {
    want.authorityStatus = profile.carrier.authorityStatus
    want.inFmcsa = true
  }

  // Packet status, review and risk through the one mapping the rest of the app trusts.
  const state = applyMcpUpdate(profile.packetKnown ? profile.carrier : { ...profile.carrier, status: undefined as never }, profile.packetKnown ? existing : undefined)
  if (!profile.packetKnown) {
    delete state.mcpStatus
    delete state.mcpReviewStatus
    delete state.mcpPacketCompletedAt
  }
  Object.assign(want, state)
  if (profile.carrier.insurance) {
    want.insurancePolicies = mergeInsurancePolicies(existing.insurancePolicies as Row[] | null | undefined, profile.carrier.insurance)
  }

  const patch: Row = {}
  const changes: Record<string, FieldChange> = {}
  for (const [key, after] of Object.entries(want)) {
    if (after === undefined || same(existing[key], after)) continue
    patch[key] = after
    changes[key] = { before: existing[key] ?? null, after, kind: blank(existing[key]) ? 'FILLED' : 'OVERWROTE' }
  }
  // Dispatcher mirror: fill, never overwrite — the primary CarrierContact owns it once someone set one.
  const dispatcher = profile.contacts.find((c) => c.types.includes('DISPATCH'))
  if (dispatcher) {
    for (const [key, value] of [['dispatcherName', dispatcher.name], ['dispatcherEmail', dispatcher.email], ['dispatcherPhone', dispatcher.phone]] as const) {
      if (value && blank(existing[key])) {
        patch[key] = value
        changes[key] = { before: null, after: value, kind: 'FILLED' }
      }
    }
  }
  return { patch, changes }
}

/** The audit's view of `changes`: tax id masked, policies summarised, nothing else altered. */
export function auditChanges(changes: Record<string, FieldChange>): Record<string, FieldChange> {
  return Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, { ...c, before: auditValue(k, c.before), after: auditValue(k, c.after) }]))
}
