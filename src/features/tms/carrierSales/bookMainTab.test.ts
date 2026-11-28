import { describe, expect, it } from 'vitest'
import { chooseBookMainTab } from './bookMainTab'

const base = { capacityAllowed: true, mainParam: null, hasBrokerageParams: false, remembered: null } as const

describe('chooseBookMainTab', () => {
  it('opens on Assets by default', () => {
    expect(chooseBookMainTab(base)).toBe('assets')
  })
  it('keeps the tab the person last used', () => {
    expect(chooseBookMainTab({ ...base, remembered: 'brokerage' })).toBe('brokerage')
    expect(chooseBookMainTab({ ...base, remembered: 'assets' })).toBe('assets')
  })
  it('an older link made for the brokerage page lands on Brokerage', () => {
    expect(chooseBookMainTab({ ...base, hasBrokerageParams: true, remembered: 'assets' })).toBe('brokerage')
  })
  it('an explicit main wins over everything but access', () => {
    expect(chooseBookMainTab({ ...base, mainParam: 'assets', hasBrokerageParams: true, remembered: 'brokerage' })).toBe('assets')
    expect(chooseBookMainTab({ ...base, mainParam: 'brokerage' })).toBe('brokerage')
    expect(chooseBookMainTab({ ...base, mainParam: 'nonsense' })).toBe('assets')
  })
  it('someone without the Capacity board is always on Brokerage', () => {
    expect(chooseBookMainTab({ ...base, capacityAllowed: false })).toBe('brokerage')
    expect(chooseBookMainTab({ ...base, capacityAllowed: false, mainParam: 'assets', remembered: 'assets' })).toBe('brokerage')
  })
})
