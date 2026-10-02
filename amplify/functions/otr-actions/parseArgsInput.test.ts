/**
 * Reading the action's input.
 *
 * AWSJSON reaches a Lambda resolver as a JSON STRING or as an already-parsed OBJECT,
 * depending on how the value was serialised on the way in. This Lambda assumed the string
 * form and called JSON.parse on it unconditionally — and JSON.parse stringifies an object
 * first, so every call from the browser died with `"[object Object]" is not valid JSON`.
 *
 * It was invisible because the queue's rows are prepared server-side by the email intake,
 * so the data looked right while every button a person pressed was failing.
 */
import { describe, it, expect } from 'vitest'
import { parseArgsInput } from './handler'

describe('parseArgsInput', () => {
  it('takes the object form AppSync sometimes delivers', () => {
    // The case that was broken. Everything below it already worked.
    expect(parseArgsInput({ id: '14538', mcNumber: '123456' })).toEqual({
      id: '14538',
      mcNumber: '123456',
    })
  })

  it('takes the string form', () => {
    expect(parseArgsInput('{"id":"14538"}')).toEqual({ id: '14538' })
  })

  it('treats nothing at all as an empty input', () => {
    expect(parseArgsInput(null)).toEqual({})
    expect(parseArgsInput(undefined)).toEqual({})
    expect(parseArgsInput('   ')).toEqual({})
  })

  it('refuses a payload that is not an object, in either form', () => {
    // An array or a bare value would read as an action with no arguments and act on the
    // wrong row, or on every row.
    expect(() => parseArgsInput('[1,2,3]')).toThrow(/must be a JSON object/)
    expect(() => parseArgsInput('"just a string"')).toThrow(/must be a JSON object/)
    expect(() => parseArgsInput([] as unknown as Record<string, unknown>)).toThrow(/must be an object/)
  })

  it('still rejects a string that is not JSON', () => {
    expect(() => parseArgsInput('{nope')).toThrow()
  })
})
