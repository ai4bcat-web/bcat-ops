import { describe, expect, it } from 'vitest'
import { assertInviteInputSafe, candidateMcs, isAllowedInviteAddress, maskPii, planInvite } from './asLive.mjs'

describe('one-invite guard', () => {
  it('allows ai4bcat@gmail.com and +tags only', () => {
    expect(isAllowedInviteAddress('AI4BCAT@gmail.com')).toBe(true)
    expect(isAllowedInviteAddress('ai4bcat+as@gmail.com')).toBe(true)
    expect(isAllowedInviteAddress('ai4bcat@gmail.com.evil.example')).toBe(false)
    expect(isAllowedInviteAddress('dispatch@carrier.example')).toBe(false)
  })

  it('uses MCP’s default list only when the whole list is allowed; otherwise names ai4bcat@gmail.com explicitly', () => {
    expect(planInvite(['ai4bcat@gmail.com', 'ai4bcat+x@gmail.com'])).toMatchObject({ mode: 'DEFAULT_LIST', emails: undefined })
    expect(planInvite(['ai4bcat@gmail.com', 'ops@real-carrier.example'])).toEqual({ mode: 'EXPLICIT', emails: ['ai4bcat@gmail.com'], recipients: ['ai4bcat@gmail.com'] })
    expect(planInvite([]).mode).toBe('EXPLICIT')
  })

  it('refuses a call that could reach anyone else, including through the default list', () => {
    expect(() => assertInviteInputSafe({ emails: ['ai4bcat@gmail.com'] }, ['ops@real.example'])).not.toThrow()
    expect(() => assertInviteInputSafe({ emails: ['ops@real.example'] }, [])).toThrow(/not ai4bcat/)
    expect(() => assertInviteInputSafe({}, ['ai4bcat@gmail.com', 'ops@real.example'])).toThrow(/not ai4bcat/)
    expect(() => assertInviteInputSafe({}, [])).toThrow(/no recipient/)
  })
})

describe('screenshot masking and candidates', () => {
  it('hides e-mails and phone numbers', () => {
    expect(maskPii('Reach dee@carrier.example or (555) 010-0101 / 555-010-0102')).toBe('Reach [e-mail hidden] or [phone hidden] / [phone hidden]')
  })
  it('is deterministic', () => {
    expect(candidateMcs(3)).toEqual(['MC1000003', 'MC1007922', 'MC1015841'])
  })
})
