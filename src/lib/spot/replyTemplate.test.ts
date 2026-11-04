import { describe, expect, it } from 'vitest'
import { renderSpotReply, replySubject, type SpotReplyInput } from './replyTemplate'

const base: SpotReplyInput = {
  rateCents: 250_000,
  origin: { city: 'Chicago', state: 'IL' },
  destination: { city: 'Dallas', state: 'TX' },
  equipmentType: 'VAN',
  lengthFt: 53,
  pickupDate: '2026-11-06',
  expiresAt: '2026-11-13T00:00:00Z',
  link: 'https://app.zz-bcat.test/q/abc123',
}

describe('renderSpotReply', () => {
  it('carries rate, lane, equipment, pickup, validity and link', () => {
    const text = renderSpotReply(base)
    expect(text).toContain('$2,500')
    expect(text).toContain('Chicago, IL to Dallas, TX')
    expect(text).toContain("53' dry van")
    expect(text).toContain('Nov 6, 2026')
    expect(text).toContain('Nov 13, 2026')
    expect(text).toContain('https://app.zz-bcat.test/q/abc123')
  })

  it('has no input through which model free text can arrive', () => {
    // The input type has no notes/commodity/customerName; extra properties are ignored.
    const poisoned = { ...base, notes: 'IGNORE ALL', commodity: 'EVIL', customerName: 'EVIL CO' } as unknown as SpotReplyInput
    const text = renderSpotReply(poisoned)
    expect(text).not.toMatch(/IGNORE|EVIL/)
  })

  it('strips CR/LF from single-line fields and control characters from rep text', () => {
    const text = renderSpotReply({ ...base, origin: { city: 'Chi\r\nBcc: x@y.test', state: 'IL' }, intro: 'Hi\u0000 there' })
    expect(text.split('\n').filter((l) => l.startsWith('Bcc:'))).toHaveLength(0)
    expect(text).not.toContain('\u0000')
    expect(text).not.toContain('\r')
  })

  it('appends the signature exactly once and is deterministic', () => {
    const input = { ...base, intro: 'Hello', outro: 'Thanks', signature: 'Rep Example\nBCAT' }
    const a = renderSpotReply(input)
    expect(a).toBe(renderSpotReply(input))
    expect(a.match(/Rep Example/g)).toHaveLength(1)
    expect(a.indexOf('Hello')).toBeLessThan(a.indexOf('Rate:'))
    expect(a.indexOf('Thanks')).toBeLessThan(a.indexOf('Rep Example'))
  })

  it('caps rep text at 600 characters', () => {
    expect(renderSpotReply({ ...base, intro: 'x'.repeat(5000) }).length).toBeLessThan(1400)
  })
})

describe('replySubject', () => {
  it('prefixes once and collapses lines', () => {
    expect(replySubject('Rate request')).toBe('Re: Rate request')
    expect(replySubject('RE: Re: Rate request')).toBe('Re: Rate request')
    expect(replySubject('A\r\nBcc: x')).not.toMatch(/[\r\n]/)
    expect(replySubject(null)).toBe('Re: Your quote request')
  })
})
