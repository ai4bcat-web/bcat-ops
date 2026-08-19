import { describe, it, expect } from 'vitest'
import { graphqlErrorMessage } from './apiClient'

describe('graphqlErrorMessage', () => {
  it('unwraps the Amplify { errors: [...] } rejection', () => {
    // This is the shape that produced "[object Object]" on the screenshot import: a plain
    // object, so `instanceof Error` is false and String(err) is useless.
    const err = { data: null, errors: [{ message: 'Resolver failed: something broke' }] }
    expect(graphqlErrorMessage(err)).toBe('Resolver failed: something broke')
  })

  it('never returns [object Object] for an object rejection', () => {
    expect(graphqlErrorMessage({ data: null, errors: [] })).not.toContain('[object Object]')
    expect(graphqlErrorMessage({})).not.toContain('[object Object]')
    expect(graphqlErrorMessage(null)).not.toContain('[object Object]')
  })

  it('turns a resolver timeout into advice the user can act on', () => {
    const err = { errors: [{ message: 'Execution timed out' }] }
    expect(graphqlErrorMessage(err)).toMatch(/took too long/i)
    expect(graphqlErrorMessage(err)).toMatch(/crop/i)
  })

  it('joins several GraphQL errors rather than dropping all but one', () => {
    const err = { errors: [{ message: 'first' }, { message: 'second' }] }
    expect(graphqlErrorMessage(err)).toBe('first; second')
  })

  it('passes a real Error through unchanged', () => {
    expect(graphqlErrorMessage(new Error('plain failure'))).toBe('plain failure')
  })

  it('falls back to something readable when there is nothing to unwrap', () => {
    expect(graphqlErrorMessage(undefined)).toMatch(/went wrong/i)
  })
})
