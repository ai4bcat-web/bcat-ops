/**
 * The owner-operator settlements showed a red box reading "[object Object]" when its data
 * load failed — no information at all, on the page someone was using to work out why
 * nobody was being paid. AppSync rejects with a plain object carrying an `errors` array,
 * so the shape that matters most was the one `String(err)` printed worst.
 */
import { describe, it, expect } from 'vitest'
import { errorText } from './errorText'

describe('errorText', () => {
  it('reads an AppSync rejection, which is not an Error at all', () => {
    expect(errorText({ errors: [{ message: 'Not Authorized to access listLoads' }] }))
      .toBe('Not Authorized to access listLoads')
  })

  it('joins several GraphQL errors rather than picking one', () => {
    expect(errorText({ errors: [{ message: 'first' }, { message: 'second' }] }))
      .toBe('first; second')
  })

  it('takes an ordinary Error message', () => {
    expect(errorText(new Error('Network request failed'))).toBe('Network request failed')
  })

  it('takes a message off a non-Error that carries one', () => {
    expect(errorText({ message: 'Token expired' })).toBe('Token expired')
  })

  it('takes a thrown string', () => {
    expect(errorText('plain failure')).toBe('plain failure')
  })

  it('never returns "[object Object]" for an object it cannot read', () => {
    // The whole point. Something concrete, so a person can report it.
    const out = errorText({ statusCode: 502, detail: 'bad gateway' })
    expect(out).not.toBe('[object Object]')
    expect(out).toContain('502')
  })

  it('falls back to words when there is nothing to show', () => {
    // A blank error box is the same problem in different clothes.
    expect(errorText(null)).toBe('Something went wrong')
    expect(errorText(undefined, 'Could not load settlements')).toBe('Could not load settlements')
    expect(errorText({})).toBe('Something went wrong')
  })

  it('survives something circular', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => errorText(circular)).not.toThrow()
  })
})
