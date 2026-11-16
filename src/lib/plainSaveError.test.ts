import { describe, expect, it } from 'vitest'
import { plainSaveError } from '@/lib/apiClient'

describe('plainSaveError', () => {
  it('turns a raw "must be a string" validation message into a sentence', () => {
    const text = plainSaveError(new Error('name must be a string'), 'Could not save the customer')
    expect(text).toBe('Could not save the customer: a field was missing from the save. Reload the page and try again.')
    expect(text).not.toMatch(/must be a string/)
  })
  it('keeps a message that already reads as a sentence', () => {
    expect(plainSaveError(new Error('This customer was changed by someone else'), 'Could not save')).toBe('This customer was changed by someone else')
  })
  it('falls back when there is no message', () => {
    expect(plainSaveError(undefined, 'Could not save')).toBe('Could not save')
  })
})
