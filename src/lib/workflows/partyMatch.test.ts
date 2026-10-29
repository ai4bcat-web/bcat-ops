/**
 * The matcher decides whose freight an e-mail is about. Everything here is a refusal
 * except the first case: a shared domain, a familiar name and a consumer mailbox all
 * have to stop at "candidate", because promoting one of them puts a stranger's load on
 * a customer's account.
 */
import { describe, it, expect } from 'vitest'
import { FREEMAIL_DOMAINS, domainOf, matchParty, type PartyDirectory } from './partyMatch'

function directory(over: Partial<PartyDirectory> = {}): PartyDirectory {
  return {
    customers: [
      {
        id: 'cus-batory',
        name: 'Batory Foods',
        aliases: ['Batory Foods Inc'],
        contacts: [
          { id: 'c1', email: 'mronczkowski@batoryfoods.com' },
          { id: 'c2', email: 'ap@batoryfoods.com' },
        ],
      },
      { id: 'cus-acme', name: 'Acme Distribution', contacts: [{ id: 'c3', email: 'orders@acme-dist.com' }] },
    ],
    carriers: [{ id: 'car-ivan', name: 'Ivan Cartage Company', email: 'dispatch@ivancartage.com' }],
    carrierContacts: [{ id: 'cc1', carrierId: 'car-ivan', name: 'Ryne', email: 'ryne@ivancartage.com' }],
    ...over,
  }
}

describe('domainOf', () => {
  it('reads the domain out of a bare address and a header address', () => {
    expect(domainOf('Mark <MRonczkowski@BatoryFoods.com>')).toBe('batoryfoods.com')
    expect(domainOf('nobody')).toBe('')
    expect(domainOf(null)).toBe('')
  })
})

describe('matchParty', () => {
  it('matches an exact contact address', () => {
    const result = matchParty({ fromEmail: ' MRonczkowski@BatoryFoods.com ' }, directory())
    expect(result.match).toEqual({ kind: 'CUSTOMER', id: 'cus-batory', name: 'Batory Foods', how: 'EMAIL' })
  })

  it('matches a carrier contact address to the carrier', () => {
    const result = matchParty({ fromEmail: 'ryne@ivancartage.com' }, directory())
    expect(result.match).toEqual({ kind: 'CARRIER', id: 'car-ivan', name: 'Ivan Cartage Company', how: 'EMAIL' })
  })

  it('keeps the exact match when the sending domain passed SPF or DKIM', () => {
    const spf = matchParty(
      {
        fromEmail: 'mronczkowski@batoryfoods.com',
        authResult: 'mx.google.com; dkim=none; spf=pass (google.com: domain of mronczkowski@batoryfoods.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=mronczkowski@batoryfoods.com; dmarc=pass',
      },
      directory(),
    )
    expect(spf.match).toEqual({ kind: 'CUSTOMER', id: 'cus-batory', name: 'Batory Foods', how: 'EMAIL' })
    expect(spf.authDowngrade).toBeUndefined()

    // A subdomain signature is still the same organisation (relaxed alignment).
    const dkim = matchParty(
      { fromEmail: 'mronczkowski@batoryfoods.com', authResult: 'mx.google.com; spf=softfail; dkim=pass header.i=@mail.batoryfoods.com header.s=k1' },
      directory(),
    )
    expect(dkim.match?.how).toBe('EMAIL')
  })

  it('downgrades an exact match to a candidate when the verdict does not vouch for the domain', () => {
    const failed = matchParty(
      { fromEmail: 'mronczkowski@batoryfoods.com', authResult: 'mx.google.com; spf=fail smtp.mailfrom=batoryfoods.com; dkim=none; dmarc=fail' },
      directory(),
    )
    expect(failed.match).toBeNull()
    expect(failed.candidates).toEqual([{ kind: 'CUSTOMER', id: 'cus-batory', name: 'Batory Foods', how: 'DOMAIN' }])
    expect(failed.authDowngrade).toMatch(/authentication/)

    // A forwarder that signed its own mail proves nothing about the From domain.
    const elsewhere = matchParty(
      { fromEmail: 'mronczkowski@batoryfoods.com', authResult: 'mx.google.com; dkim=pass header.i=@relay.example.net; spf=pass smtp.mailfrom=bounce@relay.example.net' },
      directory(),
    )
    expect(elsewhere.match).toBeNull()
    expect(elsewhere.candidates[0].how).toBe('DOMAIN')
  })

  it('leaves a message with no verdict exactly as it was', () => {
    // Slack, the driver app and vendor-ap are internal bridges: they carry no
    // header to check, and inventing a refusal for them would break them.
    expect(matchParty({ fromEmail: 'mronczkowski@batoryfoods.com', authResult: '' }, directory()).match?.how).toBe('EMAIL')
    expect(matchParty({ fromEmail: 'mronczkowski@batoryfoods.com', authResult: null }, directory()).match?.how).toBe('EMAIL')
  })

  it('never matches on a freemail domain', () => {
    const dir = directory({
      customers: [{ id: 'cus-g', name: 'Gmail Customer', contacts: [{ id: 'c', email: 'buyer@gmail.com' }] }],
    })
    const result = matchParty({ fromEmail: 'someone.else@gmail.com' }, dir)
    expect(FREEMAIL_DOMAINS.has('gmail.com')).toBe(true)
    expect(result.match).toBeNull()
    expect(result.candidates).toEqual([])
  })

  it('offers a corporate domain as a candidate, never as a match', () => {
    const result = matchParty({ fromEmail: 'newhire@batoryfoods.com' }, directory())
    expect(result.match).toBeNull()
    expect(result.candidates).toEqual([
      { kind: 'CUSTOMER', id: 'cus-batory', name: 'Batory Foods', how: 'DOMAIN' },
    ])
  })

  it('offers a name as a candidate, never as a match', () => {
    const result = matchParty({ fromEmail: 'someone@unknown-broker.com', fromName: 'BATORY FOODS, INC.' }, directory())
    expect(result.match).toBeNull()
    expect(result.candidates).toEqual([{ kind: 'CUSTOMER', id: 'cus-batory', name: 'Batory Foods', how: 'NAME' }])
  })

  it('reads the signature line when the display name says nothing', () => {
    const result = matchParty(
      { fromEmail: 'someone@unknown-broker.com', bodyTail: 'Thanks\n\nIvan Cartage Company\n' },
      directory(),
    )
    expect(result.candidates.map((c) => c.id)).toEqual(['car-ivan'])
  })

  it('refuses when one address is on two parties', () => {
    const dir = directory({
      customers: [
        { id: 'cus-a', name: 'Alpha', contacts: [{ id: 'c', email: 'shared@logistics.com' }] },
        { id: 'cus-b', name: 'Beta', contacts: [{ id: 'c', email: 'shared@logistics.com' }] },
      ],
    })
    const result = matchParty({ fromEmail: 'shared@logistics.com' }, dir)
    expect(result.match).toBeNull()
    expect(result.candidates.map((c) => c.id)).toEqual(['cus-a', 'cus-b'])
  })

  it('yields nothing at all for a blank From', () => {
    expect(matchParty({ fromEmail: '  ', fromName: 'Batory Foods' }, directory())).toEqual({
      match: null,
      candidates: [],
    })
  })

  it('floats the preferred kind to the front and caps the list at three', () => {
    const dir = directory({
      customers: [
        { id: 'cus-1', name: 'One', contacts: [{ id: 'a', email: 'a@shared.com' }] },
        { id: 'cus-2', name: 'Two', contacts: [{ id: 'b', email: 'b@shared.com' }] },
        { id: 'cus-3', name: 'Three', contacts: [{ id: 'c', email: 'c@shared.com' }] },
      ],
      carriers: [{ id: 'car-1', name: 'Carrier One', email: 'd@shared.com' }],
      carrierContacts: [],
    })
    const result = matchParty({ fromEmail: 'new@shared.com' }, dir, 'CARRIER')
    expect(result.candidates).toHaveLength(3)
    expect(result.candidates[0].kind).toBe('CARRIER')
  })
})
