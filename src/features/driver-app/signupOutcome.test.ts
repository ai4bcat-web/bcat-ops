import { describe, it, expect } from 'vitest'
import {
  errorName,
  isAlreadyRegistered,
  needsSignupConfirmInstead,
  codeSentMessage,
} from './signupOutcome'

/** How the auth context rethrows: a plain Error with the AWS error on `cause`. */
const wrapped = (name: string) =>
  new Error('User already exists', { cause: Object.assign(new Error('x'), { name }) })

describe('errorName', () => {
  it('reads a name straight off an AWS error', () => {
    expect(errorName(Object.assign(new Error('x'), { name: 'UsernameExistsException' })))
      .toBe('UsernameExistsException')
  })

  it('digs through the rethrown wrapper the auth context creates', () => {
    expect(errorName(wrapped('UsernameExistsException'))).toBe('UsernameExistsException')
  })

  it('falls back to the __type some Cognito responses use', () => {
    expect(errorName({ __type: 'NotAuthorizedException' })).toBe('NotAuthorizedException')
  })

  it('returns empty for anything that is not an error object', () => {
    expect(errorName('boom')).toBe('')
    expect(errorName(null)).toBe('')
    expect(errorName(undefined)).toBe('')
  })

  it('does not loop forever on a self-referencing cause', () => {
    const e = new Error('loop') as Error & { cause?: unknown }
    e.cause = e
    // Depth is bounded by the chain being the same object, which returns '' once reached.
    expect(() => errorName(e)).not.toThrow()
  })
})

describe('isAlreadyRegistered', () => {
  it('recognises the existing-account case, wrapped or raw', () => {
    expect(isAlreadyRegistered(wrapped('UsernameExistsException'))).toBe(true)
    expect(isAlreadyRegistered({ name: 'UsernameExistsException' })).toBe(true)
  })

  it('does not swallow a roster rejection', () => {
    // The PreSignUp gate refusing someone is a real failure and must still surface.
    expect(isAlreadyRegistered(new Error('No driver record matches this email. Contact dispatch.')))
      .toBe(false)
  })

  it('does not swallow a weak-password rejection', () => {
    expect(isAlreadyRegistered(wrapped('InvalidPasswordException'))).toBe(false)
  })
})

describe('needsSignupConfirmInstead', () => {
  it('recognises an account that never confirmed its email', () => {
    // Cognito refuses a reset for an unconfirmed user; they need the signup code resent.
    expect(needsSignupConfirmInstead(wrapped('InvalidParameterException'))).toBe(true)
    expect(needsSignupConfirmInstead(wrapped('UserNotConfirmedException'))).toBe(true)
  })

  it('leaves other reset failures alone', () => {
    expect(needsSignupConfirmInstead(wrapped('LimitExceededException'))).toBe(false)
  })
})

describe('codeSentMessage', () => {
  it('explains why an existing account still needs a code', () => {
    const msg = codeSentMessage('CONFIRM_RESET', 'roy@example.com')
    expect(msg).toContain('already have an account')
    expect(msg).toContain('roy@example.com')
  })

  it('keeps the new-account wording plain', () => {
    const msg = codeSentMessage('CONFIRM_SIGNUP', 'roy@example.com')
    expect(msg).toContain('finish setting up')
    expect(msg).not.toContain('already')
  })
})
