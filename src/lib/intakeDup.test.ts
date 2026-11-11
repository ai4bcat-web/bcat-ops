import { describe, expect, it } from 'vitest'
import { dupBodyKey, dupSubjectKey, isSameEmail } from './intakeDup'

const mail = (over: Record<string, unknown> = {}) => ({ subject: 'Fwd: Rate Confirmation for Load: 69902922', bodyText: 'Please see attached rate con.\n\nThanks', receivedAt: '2026-11-11T14:19:00Z', ...over })

describe('dupSubjectKey', () => {
  it('ignores Re:/Fwd: chains, quotes, case and spacing', () => {
    expect(dupSubjectKey('RE: Fwd:  "Truck  Request"')).toBe('truck request')
    expect(dupSubjectKey(null)).toBe('')
  })
})

describe('isSameEmail', () => {
  it('matches the same message arriving twice, including the group copy', () => {
    expect(isSameEmail(mail(), mail())).toBe(true)
    expect(isSameEmail(mail(), mail({ receivedAt: '2026-11-11T14:21:30Z', bodyText: 'Please see attached rate con.\n\nThanks\n\n-- \nYou received this via the BCAT Loads group' }))).toBe(true)
  })
  it('does not match another tender with the same subject, a far-apart time, or a different body', () => {
    expect(isSameEmail(mail(), mail({ bodyText: 'Different load, different lane' }))).toBe(false)
    expect(isSameEmail(mail(), mail({ receivedAt: '2026-11-11T15:19:00Z' }))).toBe(false)
    expect(isSameEmail(mail(), mail({ subject: 'Fwd: Rate Confirmation for Load: 11111111' }))).toBe(false)
  })
  it('never matches an empty body or a missing time', () => {
    expect(isSameEmail(mail({ bodyText: '' }), mail({ bodyText: '' }))).toBe(false)
    expect(isSameEmail(mail({ receivedAt: null }), mail())).toBe(false)
    expect(dupBodyKey('  A   b ')).toBe('a b')
  })
})
