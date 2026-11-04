/**
 * Step AB §5.3 — pure `matchSender`: e-mail address → contact → domain → account.
 * The caller supplies the two O(1) Gets (CrmContact by address, CrmDomain by registrable
 * domain); nothing here touches storage.
 */
import type { CrmContactRecord, CrmDomainRecord, SenderMatch, SenderMatchCandidate } from './types'
import {
  DEFAULT_OWN_DOMAINS,
  domainOfAddress,
  isFreemail,
  isOwnDomain,
  normalizeAddress,
  registrableDomain,
} from './domains'

const MAX_CANDIDATES = 3

/**
 * Reads an `Authentication-Results` header for the sender's own domain.
 * true = SPF or DKIM passed aligned; false = a verdict exists and neither did;
 * null = no verdict at all (no downgrade: the plan only downgrades on a *present* failure).
 */
export function authAlignment(verdict: string | null | undefined, senderDomain: string): boolean | null {
  const text = (verdict ?? '').trim().toLowerCase()
  if (!text) return null
  const sender = registrableDomain(senderDomain)
  const aligned = (host: string) => !!host && registrableDomain(host) === sender
  const dkimPass = [...text.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g)].some((m) => aligned(m[1]))
  const spfPass = [...text.matchAll(/spf=pass[^;]*?smtp\.(?:mailfrom|helo)=(?:[^@\s;]*@)?([a-z0-9.-]+)/g)].some((m) =>
    aligned(m[1]),
  )
  return dkimPass || spfPass
}

export interface MatchRows {
  /** `CrmContact` Get by `normalizeAddress(address)`. */
  contact?: CrmContactRecord | null
  /** `CrmDomain` Get by `registrableDomain(address)`; null when the domain is not eligible. */
  domain?: CrmDomainRecord | null
}

/** Which two ids the caller must Get for an address. '' means "no lookup needed". */
export function lookupKeys(address: string): { contactId: string; domainId: string } {
  const contactId = normalizeAddress(address)
  const domain = registrableDomain(domainOfAddress(contactId))
  return { contactId, domainId: domain && !isFreemail(domain) ? domain : '' }
}

export function matchSender(
  address: string,
  authVerdict: string | null | undefined,
  rows: MatchRows,
  ownDomains: readonly string[] = DEFAULT_OWN_DOMAINS,
): SenderMatch {
  const email = normalizeAddress(address)
  if (!email) return { how: 'NONE', candidates: [] }
  const domain = registrableDomain(domainOfAddress(email))
  const aligned = authAlignment(authVerdict, domainOfAddress(email))
  const downgraded = aligned === false

  // 2. Exact contact.
  const contact = rows.contact
  if (contact && contact.id === email && contact.customerId && (contact.status ?? 'ACTIVE') === 'ACTIVE') {
    if (downgraded) {
      return {
        how: 'NONE',
        candidates: [{ customerId: contact.customerId, how: 'EMAIL' }],
        authDowngrade: true,
      }
    }
    return { how: 'EMAIL', customerId: contact.customerId, contact, candidates: [] }
  }

  // 3/5. Free-mail and our own domains never match by domain.
  if (!domain || isFreemail(domain) || isOwnDomain(domain, ownDomains)) return { how: 'NONE', candidates: [] }

  // 4. Domain claim.
  const claim = rows.domain
  if (!claim || claim.id !== domain) return { how: 'NONE', candidates: [] }
  if (claim.conflict) {
    const candidates: SenderMatchCandidate[] = (claim.conflictCustomerIds ?? [])
      .slice(0, MAX_CANDIDATES)
      .map((customerId) => ({ customerId, how: 'DOMAIN' as const }))
    return { how: 'AMBIGUOUS', candidates }
  }
  if (!claim.customerId) return { how: 'NONE', candidates: [] }
  if (downgraded) {
    return {
      how: 'NONE',
      candidates: [{ customerId: claim.customerId, how: 'DOMAIN' }],
      authDowngrade: true,
    }
  }
  return { how: 'DOMAIN', customerId: claim.customerId, candidates: [{ customerId: claim.customerId, how: 'DOMAIN' }] }
}
