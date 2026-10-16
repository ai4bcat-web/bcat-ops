import { describe, it, expect } from 'vitest'
import { withoutNullIndexKeys } from './dispatchStore'

describe('withoutNullIndexKeys', () => {
  it('drops a null twilioSid so the indexed attribute is absent rather than NULL', () => {
    const out = withoutNullIndexKeys({ id: 'm1', kind: 'STATUS', twilioSid: null, body: 'On site at pickup' })
    expect('twilioSid' in out).toBe(false)
    expect(out.body).toBe('On site at pickup')
  })
  it('keeps a real twilioSid', () => {
    expect(withoutNullIndexKeys({ id: 'm2', twilioSid: 'SM123' }).twilioSid).toBe('SM123')
  })
})
