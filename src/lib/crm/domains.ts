/**
 * Step AB §5.3 — sender normalisation and the registrable domain, with no Public Suffix
 * List dependency (limit stated in AB-plan §13 R6: a short built-in two-level list).
 */
import { FREEMAIL_DOMAINS } from '../workflows/partyMatch'

/** Consumer mailbox providers added to `partyMatch`'s list. */
export const FREEMAIL_EXTRA: readonly string[] = [
  'googlemail.com',
  'att.net',
  'sbcglobal.net',
  'verizon.net',
  'cox.net',
  'bellsouth.net',
  'earthlink.net',
  'rocketmail.com',
  'hey.com',
]

/** Second-level labels under which the registrable domain is three labels long. */
const TWO_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.mx',
  'co.in', 'com.br', 'com.ar', 'co.jp', 'co.za', 'com.cn', 'com.tr', 'com.sg', 'com.hk',
])

/** Portals, EDI relays and marketplaces: one domain, many unrelated companies. */
const SHARED_SERVICE_DOMAINS: ReadonlySet<string> = new Set([
  'amazon.com', 'coupa.com', 'ariba.com', 'jaggaer.com', 'tungsten-network.com',
  'sps-commerce.com', 'spscommerce.com', 'truckstop.com', 'dat.com', 'echo.com',
  'docusign.net', 'quickbooks.com', 'intuit.com', 'google.com', 'microsoft.com',
])

/** Our own mailboxes are never a customer's domain. */
export const DEFAULT_OWN_DOMAINS: readonly string[] = ['bcatcorp.com']

export function isFreemail(domain: string): boolean {
  const d = domain.trim().toLowerCase()
  return FREEMAIL_DOMAINS.has(d) || FREEMAIL_EXTRA.includes(d)
}

/** `Name <A@B.com>` or `a@b.com` → `a@b.com`; anything without a plausible address → ''. */
export function normalizeAddress(raw: string | null | undefined): string {
  let value = (raw ?? '').trim()
  const angle = value.match(/<([^<>]+)>\s*$/)
  if (angle) value = angle[1]
  value = value.trim().toLowerCase().replace(/^mailto:/, '')
  return /^[^\s@<>,;]+@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value) ? value : ''
}

export function domainOfAddress(raw: string | null | undefined): string {
  const address = normalizeAddress(raw)
  return address ? address.slice(address.lastIndexOf('@') + 1) : ''
}

/**
 * Registrable domain of an e-mail address, a host or a URL: last two labels, or last
 * three under a known two-level suffix. `mail.acme.com` → `acme.com`. '' when none.
 */
export function registrableDomain(input: string | null | undefined): string {
  let host = (input ?? '').trim().toLowerCase()
  if (!host) return ''
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#:\s>]/)[0]
  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9-]+$/.test(l))) return ''
  const lastTwo = labels.slice(-2).join('.')
  if (TWO_LEVEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.')
  return lastTwo
}

export function isOwnDomain(domain: string, own: readonly string[] = DEFAULT_OWN_DOMAINS): boolean {
  return own.includes(domain.trim().toLowerCase())
}

/** Domains that must never be claimed by a customer (§5.3): shared portals and EDI relays. */
export function isSharedServiceDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase()
  return SHARED_SERVICE_DOMAINS.has(d) || /^edi[a-z0-9-]*\./.test(d)
}

/** True when a domain may be written to `CrmDomain` at all. */
export function isClaimableDomain(domain: string, own: readonly string[] = DEFAULT_OWN_DOMAINS): boolean {
  const d = domain.trim().toLowerCase()
  return !!d && !isFreemail(d) && !isOwnDomain(d, own) && !isSharedServiceDomain(d)
}
