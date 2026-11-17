import { describe, expect, it } from 'vitest'
import { applyFactorRemit, effectivePayeeEmail, factorKeyOf, parseFactorRemitMap, summarizeFactors } from './factorRemit'

const map = parseFactorRemitMap({ 'OTR CAPITAL': { name: 'OTR Capital LLC', email: 'remit@otr.test' } })

describe('factorKeyOf', () => {
  it('ignores case, punctuation and legal suffixes but keeps offices apart', () => {
    expect(factorKeyOf('OTR CAPITAL LLC')).toBe('OTR CAPITAL')
    expect(factorKeyOf('otr capital, L.L.C.')).toBe('OTR CAPITAL')
    expect(factorKeyOf('Love\'s Solutions, LLC - Oklahoma City Office')).not.toBe(factorKeyOf('Love\'s Solutions, LLC - Cincinnati Office'))
    expect(factorKeyOf('')).toBe('')
    expect(factorKeyOf(null)).toBe('')
  })
})

describe('parseFactorRemitMap', () => {
  it('reads the string AppSync returns and drops entries with no address', () => {
    const parsed = parseFactorRemitMap(JSON.stringify({ A: { name: 'A', email: ' a@x.test ' }, B: { name: 'B', email: '' }, C: 4 }))
    expect(Object.keys(parsed)).toEqual(['A'])
    expect(parsed.A?.email).toBe('a@x.test')
    expect(parseFactorRemitMap('not json')).toEqual({})
    expect(parseFactorRemitMap(null)).toEqual({})
  })
})

describe('effectivePayeeEmail', () => {
  it('gives a factor-paid method the factor address over its own copy', () => {
    expect(effectivePayeeEmail({ recipientType: 'FACTOR', factorName: 'OTR Capital', payeeEmail: 'old@x.test' }, map)).toBe('remit@otr.test')
  })
  it('falls back to the method copy when the factor has no address', () => {
    expect(effectivePayeeEmail({ recipientType: 'FACTOR', factorName: 'Other', payeeEmail: 'old@x.test' }, map)).toBe('old@x.test')
  })
  it('never lets a factor address reach a direct-paid carrier', () => {
    expect(effectivePayeeEmail({ recipientType: 'CARRIER', factorName: 'OTR Capital', payeeEmail: 'ap@carrier.test' }, map)).toBe('ap@carrier.test')
  })
})

describe('applyFactorRemit', () => {
  it('overlays the factor address on every method that pays through it', () => {
    const rows = applyFactorRemit([
      { id: '1', recipientType: 'FACTOR', factorName: 'OTR CAPITAL LLC', payeeEmail: null },
      { id: '2', recipientType: 'CARRIER', factorName: null, payeeEmail: 'me@x.test' },
    ], map)
    expect(rows.map((r) => r.payeeEmail)).toEqual(['remit@otr.test', 'me@x.test'])
  })
})

describe('summarizeFactors', () => {
  const infos = [
    { carrierId: 'c1', recipientType: 'FACTOR', factorName: 'RTS Financial', payeeEmail: 'cash@rts.test' },
    { carrierId: 'c2', recipientType: 'FACTOR', factorName: 'RTS FINANCIAL', payeeEmail: 'CASH@rts.test' },
    { carrierId: 'c3', recipientType: 'FACTOR', factorName: 'Split Co', payeeEmail: 'a@split.test' },
    { carrierId: 'c4', recipientType: 'FACTOR', factorName: 'Split Co', payeeEmail: 'b@split.test' },
    { carrierId: 'c5', recipientType: 'FACTOR', factorName: 'Nobody Capital', payeeEmail: null },
    { carrierId: 'c6', recipientType: 'FACTOR', factorName: 'OTR Capital LLC', payeeEmail: 'old@otr.test' },
    { carrierId: 'c7', recipientType: 'CARRIER', factorName: null, payeeEmail: 'x@x.test' },
  ]
  const rows = summarizeFactors(infos, map)
  const by = (name: string) => rows.find((r) => r.name === name || r.otherNames.includes(name))!
  it('groups spellings of one factor and reads the address the carriers share', () => {
    expect(by('RTS Financial')).toMatchObject({ carrierCount: 2, email: 'cash@rts.test', source: 'CARRIERS' })
  })
  it('flags carriers that disagree and factors with nothing', () => {
    expect(by('Split Co')).toMatchObject({ source: 'CONFLICT', email: '', conflicting: ['a@split.test', 'b@split.test'] })
    expect(by('Nobody Capital')).toMatchObject({ source: 'NONE', email: '' })
  })
  it('prefers the address set on the factor', () => {
    expect(by('OTR Capital LLC')).toMatchObject({ source: 'SET', email: 'remit@otr.test' })
  })
  it('lists no direct-paid carriers', () => {
    expect(rows).toHaveLength(4)
  })
})
