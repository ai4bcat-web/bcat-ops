import { describe, expect, it } from 'vitest'
import { apEmailList, apEmailStorage, apEmailTokens, invalidApEmails, splitEmailText } from './apEmails'
import { customerBillingGaps, customerApEmailText } from './customerBillingReady'
import { allApEmails, validateBillingFields } from './billingMethod'

// 14815 WHIMSY INTERMODAL (2026-11-16): two addresses stored in one apEmail string.
const WHIMSY = { name: 'WHIMSY INTERMODAL', billingMethod: 'MANUAL', apEmail: 'gomara@whimsytrucking.com, jgudel@whimsytrucking.com' }

describe('apEmails', () => {
  it('splits commas, semicolons, spaces and newlines; lowercases and de-duplicates', () => {
    expect(splitEmailText(' A@x.com;b@x.com\nc@x.com  a@x.com ,')).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
  })

  it('reads a legacy comma list in apEmail as separate addresses, main first', () => {
    expect(apEmailList(WHIMSY)).toEqual(['gomara@whimsytrucking.com', 'jgudel@whimsytrucking.com'])
  })

  it('merges apEmail and apEmailsExtra without repeating the main one', () => {
    expect(apEmailList({ apEmail: 'a@x.com', apEmailsExtra: ['A@x.com', 'b@x.com; c@x.com'] })).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
  })

  it('keeps invalid tokens out of the list and reports them', () => {
    const c = { apEmail: 'a@x.com, not-an-email' }
    expect(apEmailList(c)).toEqual(['a@x.com'])
    expect(invalidApEmails(c)).toEqual(['not-an-email'])
    expect(apEmailTokens(c)).toEqual(['a@x.com', 'not-an-email'])
  })

  it('stores a list as apEmail + apEmailsExtra', () => {
    expect(apEmailStorage(['a@x.com', 'b@x.com'])).toEqual({ apEmail: 'a@x.com', apEmailsExtra: ['b@x.com'] })
    expect(apEmailStorage(['a@x.com'])).toEqual({ apEmail: 'a@x.com', apEmailsExtra: null })
    expect(apEmailStorage([])).toEqual({ apEmail: null, apEmailsExtra: null })
  })

  it('a WHIMSY-shaped customer passes the AP e-mail check and sends to both', () => {
    expect(customerBillingGaps(WHIMSY)).toEqual([])
    expect(customerApEmailText(WHIMSY)).toBe('gomara@whimsytrucking.com')
    expect(allApEmails(WHIMSY)).toEqual(['gomara@whimsytrucking.com', 'jgudel@whimsytrucking.com'])
  })

  it('validation accepts a legacy list and names a bad token', () => {
    expect(validateBillingFields({ billingMethod: 'MANUAL', apEmail: WHIMSY.apEmail })).toEqual({})
    expect(validateBillingFields({ billingMethod: 'MANUAL', apEmail: 'a@x.com, nope' }).apEmail).toContain('nope')
  })
})
