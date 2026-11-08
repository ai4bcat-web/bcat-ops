import { describe, expect, it } from 'vitest'
import { dedupeEmails, isEmailAddress } from './emailAddress'

describe('isEmailAddress', () => {
  it('accepts an ordinary address', () => {
    expect(isEmailAddress('dispatch@swift.com')).toBe(true)
  })

  it.each([
    'a@b.com\r\nBcc: x@y.com',
    'a@b.com, c@d.com',
    '<a@b.com>',
    'a@b',
    `${'a'.repeat(195)}@b.com`,
  ])('rejects %j', (value) => {
    expect(isEmailAddress(value)).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isEmailAddress(null)).toBe(false)
  })
})

describe('dedupeEmails', () => {
  it('is case-insensitive, trims, and keeps the first spelling', () => {
    expect(dedupeEmails(['A@x.com', 'a@X.com ', ' b@y.com', '  '])).toEqual(['A@x.com', 'b@y.com'])
  })
})
