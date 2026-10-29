/**
 * Step K — who sent this.
 *
 * One address, matched exactly against the directory, is the only thing that ever
 * becomes a party. A shared domain or a name that merely normalises the same yields
 * candidates for a person to pick from, because "acme.com" is also the domain of every
 * other Acme and a display name is whatever the sender typed. Guessing here would put
 * a stranger's freight on a customer's account.
 *
 * Even an exact address is only as good as the From header it came from, so a
 * caller that knows what the receiving server thought (an INBOX message carries
 * its `Authentication-Results`) gets the hit downgraded to a candidate when that
 * verdict does not vouch for the sending domain.
 *
 * Name comparison reuses `normalizeName` from the directory, so the agent and the
 * directory's own dedupe always agree on when two names are the same name.
 */
import { normalizeName } from '../tmsDirectory'
import type { WorkflowPartyCandidate } from '../../types/tms'

/**
 * Consumer domains. A shared mailbox provider says nothing about who the sender works
 * for, so these never produce a domain candidate at all.
 */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'live.com',
  'msn.com',
  'comcast.net',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'mail.com',
  'yandex.com',
  'ymail.com',
])

const MAX_CANDIDATES = 3

export function domainOf(email: string | null | undefined): string {
  const raw = (email ?? '').trim().toLowerCase()
  const at = raw.lastIndexOf('@')
  if (at < 0) return ''
  // Drops a trailing `>` from a `Name <a@b.com>` header and any other stray punctuation.
  return raw.slice(at + 1).replace(/[^a-z0-9.-]/g, '')
}

export interface PartyDirectory {
  customers: Array<{ id: string; name: string; contacts?: unknown; aliases?: string[] | null }>
  carriers: Array<{ id: string; name: string; email?: string | null; dbaName?: string | null }>
  carrierContacts: Array<{ id: string; carrierId: string; name?: string | null; email?: string | null }>
}

/** Structurally the run row's own candidate shape, so one never has to be mapped. */
export type PartyMatch = WorkflowPartyCandidate

export interface PartyMatchResult {
  match: PartyMatch | null
  candidates: PartyMatch[]
  /**
   * Why an exact-address hit was not treated as a match. Set only when the
   * message carried an `Authentication-Results` verdict that did not vouch for
   * the sending domain, so the trace can say what the agent refused to believe.
   */
  authDowngrade?: string | null
}

/**
 * The identifiers an `Authentication-Results` segment can name the checked
 * domain with. A parenthetical comment ("domain of bob@acme.com designates…")
 * is not one of them, which is why the value stops at the first bracket.
 */
const AUTH_IDENTIFIERS = /(?:header\.d|header\.i|header\.from|smtp\.mailfrom|envelope-from|smtp\.helo)\s*=\s*([^\s;()]+)/gi

function authDomainsIn(segment: string): string[] {
  const out: string[] = []
  AUTH_IDENTIFIERS.lastIndex = 0
  let found = AUTH_IDENTIFIERS.exec(segment)
  while (found) {
    const value = found[1].replace(/[<>"']/g, '')
    const at = value.lastIndexOf('@')
    const domain = (at >= 0 ? value.slice(at + 1) : value).toLowerCase().replace(/[.,;]+$/, '')
    if (domain) out.push(domain)
    found = AUTH_IDENTIFIERS.exec(segment)
  }
  return out
}

/** DMARC's relaxed alignment: the same organisational domain, either way round. */
function aligned(authDomain: string, senderDomain: string): boolean {
  return authDomain === senderDomain
    || senderDomain.endsWith(`.${authDomain}`)
    || authDomain.endsWith(`.${senderDomain}`)
}

/**
 * Does the verdict say a check passed *for this sender's own domain*?
 *
 * Only `spf=pass` and `dkim=pass` count, and only when the same segment names a
 * domain aligned with the From address. A bare `pass` with no identifier, a
 * `pass` for somebody else's domain (a forwarder signing its own mail) and every
 * other verdict — none, neutral, softfail, fail, temperror — do not.
 */
function authPasses(authResult: string, senderDomain: string): boolean {
  if (!senderDomain) return false
  for (const segment of authResult.split(';')) {
    const method = /^(spf|dkim)\s*=\s*([a-z]+)/i.exec(segment.trim())
    if (!method || method[2].toLowerCase() !== 'pass') continue
    if (authDomainsIn(segment).some((domain) => aligned(domain, senderDomain))) return true
  }
  return false
}

type Party = { kind: 'CUSTOMER' | 'CARRIER'; id: string; name: string }

/** `Bob Smith <bob@acme.com>` and ` BOB@ACME.COM ` are the same address. */
function normalizeEmail(value: string | null | undefined): string {
  const raw = (value ?? '').trim()
  const angled = /<([^>]+)>/.exec(raw)
  return (angled ? angled[1] : raw).trim().toLowerCase()
}

/** Every directory address, with the party it belongs to. */
function addressIndex(dir: PartyDirectory): Array<{ party: Party; email: string }> {
  const out: Array<{ party: Party; email: string }> = []

  for (const customer of dir.customers) {
    const contacts = Array.isArray(customer.contacts) ? customer.contacts : []
    for (const contact of contacts) {
      if (!contact || typeof contact !== 'object') continue
      const email = 'email' in contact && typeof contact.email === 'string' ? normalizeEmail(contact.email) : ''
      if (email) out.push({ party: { kind: 'CUSTOMER', id: customer.id, name: customer.name }, email })
    }
  }

  const carrierNames = new Map<string, string>()
  for (const carrier of dir.carriers) {
    carrierNames.set(carrier.id, carrier.name)
    const email = normalizeEmail(carrier.email)
    if (email) out.push({ party: { kind: 'CARRIER', id: carrier.id, name: carrier.name }, email })
  }

  for (const contact of dir.carrierContacts) {
    const email = normalizeEmail(contact.email)
    const name = carrierNames.get(contact.carrierId)
    // A contact whose carrier is not in the directory cannot be named, and an unnamed
    // candidate is useless to the person who has to choose.
    if (email && name) out.push({ party: { kind: 'CARRIER', id: contact.carrierId, name }, email })
  }

  return out
}

/** The names the directory knows a party by: its own, its DBA and its aliases. */
function nameIndex(dir: PartyDirectory): Array<{ party: Party; normalized: string }> {
  const out: Array<{ party: Party; normalized: string }> = []
  const push = (party: Party, raw: string | null | undefined) => {
    const normalized = normalizeName((raw ?? '').trim())
    if (normalized) out.push({ party, normalized })
  }
  for (const customer of dir.customers) {
    const party: Party = { kind: 'CUSTOMER', id: customer.id, name: customer.name }
    push(party, customer.name)
    for (const alias of customer.aliases ?? []) push(party, alias)
  }
  for (const carrier of dir.carriers) {
    const party: Party = { kind: 'CARRIER', id: carrier.id, name: carrier.name }
    push(party, carrier.name)
    push(party, carrier.dbaName)
  }
  return out
}

export function matchParty(
  from: { fromEmail?: string | null; fromName?: string | null; bodyTail?: string | null; authResult?: string | null },
  dir: PartyDirectory,
  prefer?: 'CUSTOMER' | 'CARRIER' | null,
): PartyMatchResult {
  const sender = normalizeEmail(from.fromEmail)
  if (!sender) return { match: null, candidates: [] }

  const addresses = addressIndex(dir)
  const seen = new Set<string>()
  const candidates: PartyMatch[] = []
  const add = (party: Party, how: PartyMatch['how']) => {
    const key = `${party.kind}:${party.id}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ ...party, how })
  }

  // 1. Exact address. The only rule that can establish identity.
  const exact: Party[] = []
  const exactSeen = new Set<string>()
  for (const entry of addresses) {
    if (entry.email !== sender) continue
    const key = `${entry.party.kind}:${entry.party.id}`
    if (exactSeen.has(key)) continue
    exactSeen.add(key)
    exact.push(entry.party)
  }
  if (exact.length === 1) {
    const verdict = (from.authResult ?? '').trim()
    // An exact address is the one rule that establishes identity, and the From
    // header is whatever the sender typed. When the receiving mail server did
    // check, and its answer does not vouch for this domain, the hit drops to a
    // candidate: a person confirms instead of the spoofer being believed. No
    // verdict at all (every internal bridge) keeps the address at face value.
    if (verdict && !authPasses(verdict, domainOf(sender))) {
      const downgraded: PartyMatch = { ...exact[0], how: 'DOMAIN' }
      return {
        match: null,
        candidates: [downgraded],
        authDowngrade: 'sender authentication did not pass for the sending domain',
      }
    }
    const match: PartyMatch = { ...exact[0], how: 'EMAIL' }
    return { match, candidates: [match] }
  }
  if (exact.length > 1) {
    // One address on two parties proves nothing about which one sent this.
    for (const party of exact) add(party, 'EMAIL')
    return { match: null, candidates: sortCandidates(candidates, prefer) }
  }

  // 2. Sender domain. Candidates only, even when exactly one party shares it.
  const domain = domainOf(sender)
  if (domain && !FREEMAIL_DOMAINS.has(domain)) {
    const suffix = `@${domain}`
    for (const entry of addresses) {
      if (entry.email.endsWith(suffix)) add(entry.party, 'DOMAIN')
    }
  }

  // 3. Display name, then the signature line. A name alone never becomes a match.
  const names = nameIndex(dir)
  const bodyLines = (from.bodyTail ?? '').split('\n')
  let signature = ''
  for (let i = bodyLines.length - 1; i >= 0; i -= 1) {
    const line = bodyLines[i].trim()
    if (line) {
      signature = line
      break
    }
  }
  for (const raw of [from.fromName ?? '', signature]) {
    const normalized = normalizeName(raw.trim())
    if (!normalized) continue
    for (const entry of names) {
      if (entry.normalized === normalized) add(entry.party, 'NAME')
    }
  }

  return { match: null, candidates: sortCandidates(candidates, prefer) }
}

/** `prefer` floats its own kind to the front; the cap keeps the row small. */
function sortCandidates(candidates: PartyMatch[], prefer?: 'CUSTOMER' | 'CARRIER' | null): PartyMatch[] {
  const ordered = prefer
    ? [...candidates].sort((a, b) => Number(b.kind === prefer) - Number(a.kind === prefer))
    : candidates
  return ordered.slice(0, MAX_CANDIDATES)
}
