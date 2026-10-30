/**
 * White-label domain request (Step L).
 *
 * Computes the DNS records a registrar needs and builds the stored block. The
 * server never trusts a caller-supplied status: a browser that could post
 * VERIFIED would be a badge that means nothing.
 *
 * Pure: no store, no clock, no network. Imports are relative because the
 * tmsDirectoryActions Lambda bundles this file by path.
 */

export interface DnsRecord {
  type: 'CNAME' | 'TXT'
  name: string
  value: string
}

export interface WhiteLabel {
  domain: string
  status: 'NOT_REQUESTED' | 'PENDING' | 'VERIFIED' | 'FAILED'
  records: DnsRecord[]
  requestedAt?: string | null
  requestedBy?: string | null
  checkedAt?: string | null
  failureReason?: string | null
}

/** Public suffixes we refuse to white-label on their own. */
const PUBLIC_SUFFIXES: Record<string, true> = {
  com: true, net: true, org: true, edu: true, gov: true, mil: true, int: true,
  io: true, co: true, app: true, dev: true, cloud: true, info: true, biz: true,
  us: true, ca: true, mx: true, uk: true, 'co.uk': true, 'com.au': true, 'co.nz': true,
}

const IP_V4_RE = /^(\d{1,3}\.){3}\d{1,3}$/

function looksLikeIp(value: string): boolean {
  if (!IP_V4_RE.test(value)) return false
  return value.split('.').every((octet) => {
    const n = Number(octet)
    return Number.isFinite(n) && n >= 0 && n <= 255
  })
}

/**
 * Lowercase, strip scheme, path, port and trailing dot. Refuse an IP or a
 * public-suffix-only string.
 */
export function normalizeDomain(raw: unknown): string {
  if (raw === null || raw === undefined) throw new Error('Domain must be text.')
  if (typeof raw !== 'string') throw new Error('Domain must be text.')
  let value = raw.trim().toLowerCase()
  if (!value) throw new Error('Domain is required.')

  // Prefer URL parsing when a scheme is present.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      value = parsed.hostname
    } catch {
      // Fall through to manual parsing.
    }
  }

  // Manual parsing for scheme-less inputs.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  value = value.replace(/^[^@]*@/, '')
  value = value.replace(/:[0-9]+(?=[\/]?|$)/, '')
  value = value.split('/')[0]
  value = value.replace(/\.$/, '')

  if (!value) throw new Error('Domain is required.')
  if (looksLikeIp(value)) throw new Error('An IP address cannot be used as a white-label domain.')

  const labels = value.split('.').filter(Boolean)
  if (labels.length < 2) throw new Error('A domain must contain a registered name, not just a public suffix.')
  if (PUBLIC_SUFFIXES[value]) {
    throw new Error('A public suffix on its own cannot be used as a white-label domain.')
  }
  return value
}

/**
 * The exact DNS rows Ryne's registrar needs.
 *
 * The values are placeholders in the sense that real SES/Amplify values are
 * filled in after the domain is verified, but the record types and names are
 * deterministic for a given domain and app id.
 */
export function dnsRecordsFor(domain: string, appId: string): DnsRecord[] {
  const id = (appId ?? '').trim().toLowerCase() || 'app'
  return [
    { type: 'CNAME', name: domain, value: `${id}.amplifyapp.com` },
    { type: 'CNAME', name: `_dmarc.${domain}`, value: `_dmarc-${id}.amazonses.com` },
    { type: 'CNAME', name: `smtp._domainkey.${domain}`, value: `smtp-domainkey-${id}.amazonses.com` },
    { type: 'TXT', name: `_amplify.${domain}`, value: `amplify-verify=${id}` },
  ]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Build the stored white-label object. The caller supplies only the domain;
 * status, records and timestamps are computed here.
 */
export function whiteLabelPatch(
  existing: WhiteLabel | null | undefined,
  domain: string,
  who: string,
  now: string,
  appId?: string,
): WhiteLabel {
  const normalized = normalizeDomain(domain)
  const prior = existing ?? { domain: normalized, status: 'NOT_REQUESTED' as const, records: [] }
  const id = (appId ?? '').trim().toLowerCase() || 'app'
  return {
    domain: normalized,
    status: 'PENDING',
    records: dnsRecordsFor(normalized, id),
    requestedAt: now,
    requestedBy: who,
    checkedAt: prior.checkedAt ?? null,
    failureReason: null,
  }
}

/**
 * Validate a white-label value from a settings patch. Existing fields such as
 * checkedAt and failureReason are carried forward; status and records are
 * recomputed so a caller can never mint VERIFIED.
 */
export function validateWhiteLabel(
  value: unknown,
  existing: WhiteLabel | null | undefined,
  who: string,
  now: string,
  appId?: string,
): WhiteLabel | null {
  if (value === null || value === undefined) return null
  const row = asRecord(value)
  if (!row) throw new Error('White-label settings must be an object.')
  const domain = normalizeDomain(row.domain)
  return whiteLabelPatch(existing, domain, who, now, appId)
}
