import { describe, expect, it } from 'vitest'
import { PAY_EMAIL_CC, splitAddresses } from './payEmail'

describe('settlement email cc', () => {
  it('copies Ryne and Jenny by default', () => {
    expect(splitAddresses(PAY_EMAIL_CC)).toEqual(['ryne@bcatcorp.com', 'jenny@bcatcorp.com'])
  })
  it('splits on commas, semicolons and spaces, drops junk and duplicates', () => {
    expect(splitAddresses(' a@x.com; B@y.com ,a@x.com  c@z.com, nope ')).toEqual(['a@x.com', 'B@y.com', 'c@z.com'])
    expect(splitAddresses('')).toEqual([])
    expect(splitAddresses(undefined)).toEqual([])
  })
})
