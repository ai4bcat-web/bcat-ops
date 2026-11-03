import { describe, expect, it } from 'vitest'
import { composeRateConCc } from './rateConRecipients'

const TRACKING = 'ai4bcat+tracking@gmail.com'
const compose = (over: Partial<Parameters<typeof composeRateConCc>[0]> = {}) =>
  composeRateConCc({ to: ['carrier@swift.com'], extraCc: [], tracking: TRACKING, sender: 'me@bcat.com', ...over })

describe('composeRateConCc', () => {
  it('orders tracking, typed cc, then the sender', () => {
    const r = compose({ extraCc: ['x@y.com', 'z@y.com'] })
    expect(r.cc).toEqual([TRACKING, 'x@y.com', 'z@y.com', 'me@bcat.com'])
    expect(r.senderCopied).toBe(true)
  })

  it('lists an address once whatever its case', () => {
    const r = compose({ extraCc: ['AI4BCAT+tracking@gmail.com', 'ME@bcat.com', 'x@y.com'] })
    expect(r.cc).toEqual([TRACKING, 'ME@bcat.com', 'x@y.com'])
  })

  it('drops from cc anything already in to, including the sender', () => {
    const r = compose({ to: ['Me@bcat.com', 'carrier@swift.com'], extraCc: ['CARRIER@swift.com'] })
    expect(r.cc).toEqual([TRACKING])
    expect(r.senderCopied).toBe(false)
  })

  it('omits a null or malformed sender', () => {
    expect(compose({ sender: null }).cc).toEqual([TRACKING])
    const bad = compose({ sender: 'ops@localhost' })
    expect(bad.cc).toEqual([TRACKING])
    expect(bad.senderCopied).toBe(false)
  })

  it('collapses duplicate to entries', () => {
    expect(compose({ to: ['a@b.com', 'A@B.com'] }).to).toEqual(['a@b.com'])
  })
})
