import { describe, expect, it } from 'vitest'
import { assertAllowed, allInMailbox, isMailbox, isDevStackEnv } from './devVerifyEmail.mjs'

describe('devVerifyEmail allow-list', () => {
  it('only the bare mailbox may be supplied by the script', () => {
    expect(() => assertAllowed(['ai4bcat@gmail.com'])).not.toThrow()
    expect(() => assertAllowed(['AI4BCAT@gmail.com'])).not.toThrow()
    for (const bad of ['ai4bcat+x@gmail.com', 'ryne@bcatcorp.com', 'ai4bcat@gmail.com.evil.io', '']) {
      expect(() => assertAllowed(['ai4bcat@gmail.com', bad])).toThrow(/refusing/)
    }
  })

  it('recorded recipients must all be the mailbox or its aliases', () => {
    expect(allInMailbox('ai4bcat@gmail.com, ai4bcat+tracking@gmail.com')).toBe(true)
    expect(allInMailbox('ai4bcat@gmail.com, someone@example.com')).toBe(false)
    expect(isMailbox('xai4bcat@gmail.com')).toBe(false)
  })
})

describe('dev stack detection', () => {
  it('needs the dev flag and a non-production table suffix', () => {
    expect(isDevStackEnv({ BCAT_DEV_STACK: 'true', DATA_TABLE_SUFFIX: 'nc3jsnxdmjhkpequimypiatkma-NONE' })).toBe(true)
    expect(isDevStackEnv({ BCAT_DEV_STACK: 'true', DATA_TABLE_SUFFIX: '5ucwdyvwivelbo4k4jomvrwel4-NONE' })).toBe(false)
    expect(isDevStackEnv({ DATA_TABLE_SUFFIX: 'nc3jsnxdmjhkpequimypiatkma-NONE' })).toBe(false)
    expect(isDevStackEnv({ BCAT_DEV_STACK: 'true' })).toBe(false)
  })
})
