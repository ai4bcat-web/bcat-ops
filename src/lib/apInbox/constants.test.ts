import { describe, expect, it } from 'vitest'
import { resolveApInboxConfig } from './constants'

describe('resolveApInboxConfig', () => {
  it('enforces the 0.85 auto-apply floor and review <= auto - 0.10 whatever is posted', () => {
    const c = resolveApInboxConfig({ autoApplyMinScore: 0.5, reviewMinScore: 0.95 })
    expect(c.autoApplyMinScore).toBe(0.85)
    expect(c.reviewMinScore).toBe(0.75)
  })
  it('falls back to defaults for junk and drops unknown keys', () => {
    const c = resolveApInboxConfig({ runHourChicago: 99, mailbox: 'nope', evil: 1, ignoreSenders: ['A@X.com', 3] })
    expect(c).toMatchObject({ runHourChicago: 23, mailbox: 'ai4bcat@gmail.com', ignoreSenders: ['a@x.com'], enabled: false, autoApply: true })
    expect('evil' in c).toBe(false)
  })
})
