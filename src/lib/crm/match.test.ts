import { describe, expect, it } from 'vitest'
import { isClaimableDomain, registrableDomain } from './domains'
import { authAlignment, matchSender } from './match'
import type { CrmContactRecord, CrmDomainRecord } from './types'

const contact = (id: string, customerId = 'c1', extra: Partial<CrmContactRecord> = {}): CrmContactRecord => ({
  id,
  customerId,
  status: 'ACTIVE',
  ...extra,
})
const claim = (id: string, extra: Partial<CrmDomainRecord> = {}): CrmDomainRecord => ({ id, customerId: 'c2', conflict: false, ...extra })

describe('registrableDomain', () => {
  it('collapses subdomains and honours two-level suffixes', () => {
    expect(registrableDomain('jane@mail.zz-acme.test')).toBe('zz-acme.test')
    expect(registrableDomain('buyer@shop.acme.co.uk')).toBe('acme.co.uk')
    expect(registrableDomain('https://www.acme.com/about')).toBe('acme.com')
    expect(registrableDomain('nonsense')).toBe('')
  })

  it('refuses to claim free-mail, shared-service and our own domains', () => {
    for (const d of ['gmail.com', 'att.net', 'hey.com', 'coupa.com', 'ediserv.com', 'bcatcorp.com']) {
      expect(isClaimableDomain(d)).toBe(false)
    }
    expect(isClaimableDomain('zz-acme.test')).toBe(true)
  })
})

describe('matchSender', () => {
  it('prefers the exact contact over a domain claim for a different customer', () => {
    const m = matchSender('jane@zz-acme.test', null, { contact: contact('jane@zz-acme.test'), domain: claim('zz-acme.test') })
    expect(m).toMatchObject({ how: 'EMAIL', customerId: 'c1' })
  })

  it('matches by domain, including from a subdomain', () => {
    const m = matchSender('Bob <bob@mail.zz-acme.test>', null, { domain: claim('zz-acme.test') })
    expect(m).toMatchObject({ how: 'DOMAIN', customerId: 'c2' })
  })

  it.each(['gmail.com', 'yahoo.com', 'outlook.com', 'att.net', 'hey.com'])('never matches %s by domain, only by contact', (host) => {
    const rows = { domain: claim(host) }
    expect(matchSender(`x@${host}`, null, rows).how).toBe('NONE')
    expect(matchSender(`x@${host}`, null, { ...rows, contact: contact(`x@${host}`) }).how).toBe('EMAIL')
  })

  it('reports a domain held by two customers as ambiguous with at most three candidates', () => {
    const m = matchSender('a@x.test', null, { domain: claim('x.test', { customerId: null, conflict: true, conflictCustomerIds: ['a', 'b', 'c', 'd'] }) })
    expect(m.how).toBe('AMBIGUOUS')
    expect(m.candidates.map((c) => c.customerId)).toEqual(['a', 'b', 'c'])
  })

  it('never matches our own domain by domain', () => {
    expect(matchSender('ryne@bcatcorp.com', null, { domain: claim('bcatcorp.com') }).how).toBe('NONE')
  })

  it('ignores archived contacts', () => {
    expect(matchSender('a@x.test', null, { contact: contact('a@x.test', 'c1', { status: 'ARCHIVED' }) }).how).toBe('NONE')
  })

  it('downgrades to a candidate when SPF and DKIM both fail, but not when no verdict exists', () => {
    const rows = { contact: contact('a@x.test') }
    const failed = 'mx.google.com; dkim=fail header.d=x.test; spf=fail smtp.mailfrom=a@x.test'
    const m = matchSender('a@x.test', failed, rows)
    expect(m).toMatchObject({ how: 'NONE', authDowngrade: true })
    expect(m.candidates).toEqual([{ customerId: 'c1', how: 'EMAIL' }])
    expect(matchSender('a@x.test', undefined, rows).how).toBe('EMAIL')
    expect(matchSender('a@x.test', 'mx; dkim=pass header.d=x.test', rows).how).toBe('EMAIL')
  })

  it('does not count a pass for somebody else\'s domain as aligned', () => {
    expect(authAlignment('dkim=pass header.d=relay.example; spf=fail smtp.mailfrom=a@x.test', 'x.test')).toBe(false)
  })
})
