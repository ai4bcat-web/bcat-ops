import { describe, it, expect } from 'vitest'
import { parseGoogleVoiceEmail, extractVerificationCode, looksLikeVerification, slackMessage } from './twofa'

describe('parseGoogleVoiceEmail', () => {
  it('reads the sender from the subject and strips the Google Voice footer', () => {
    const r = parseGoogleVoiceEmail('New text message from (989) 601-2969', 'Your Chase verification code is 482913. It expires in 10 minutes.\n\nYOUR ACCOUNT <https://voice.google.com> HELP CENTER\nTo respond to this text message, reply to this email or visit Google Voice.')
    expect(r).toEqual({ from: '(989) 601-2969', text: 'Your Chase verification code is 482913. It expires in 10 minutes.' })
  })
  it('ignores mail that is not a text forward', () => {
    expect(parseGoogleVoiceEmail('New voicemail from (989) 601-2969', 'hi')).toBeNull()
  })
})

describe('extractVerificationCode', () => {
  it('finds the code next to the word code, in either order, including dashed and letter-prefixed codes', () => {
    expect(extractVerificationCode('Your verification code is 482913')).toBe('482913')
    expect(extractVerificationCode('482913 is your Amazon OTP')).toBe('482913')
    expect(extractVerificationCode('G-123456 is your Google verification code')).toBe('G-123456')
    expect(extractVerificationCode('Use code 123 456 to sign in')).toBe('123456')
    expect(extractVerificationCode('Your PIN: 7731')).toBe('7731')
  })
  it('falls back to a lone six-digit number and gives up gracefully', () => {
    expect(extractVerificationCode('Enter 553201 on the website')).toBe('553201')
    expect(extractVerificationCode('Thanks for your order')).toBeNull()
  })
})

describe('looksLikeVerification', () => {
  it('needs both a code-ish word and digits', () => {
    expect(looksLikeVerification('Your login code is 1234')).toBe(true)
    expect(looksLikeVerification('Running 10 minutes late')).toBe(false)
  })
})

describe('slackMessage', () => {
  it('leads with the code and quotes the text', () => {
    expect(slackMessage({ code: '482913', from: '(989) 601-2969', text: 'Your code is 482913', receivedAt: '2026-10-16T20:00:01Z' }))
      .toBe(':closed_lock_with_key: *Code 482913*  from (989) 601-2969 · 3:00 PM\n> Your code is 482913')
  })
})
