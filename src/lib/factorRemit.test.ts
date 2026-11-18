import { describe, expect, it } from 'vitest'
import { applyFactorRemit, canonicalFactorName, effectivePayeeEmail, factorNameIndex, factorKeyOf, parseFactorRemitMap, payeeEmailFor, payToNameFor, summarizeFactors, summarizePayees } from './factorRemit'

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

describe('canonicalFactorName', () => {
  const infos = [
    { carrierId: 'a', recipientType: 'FACTOR', factorName: 'OTR CAPITAL', payeeEmail: null },
    { carrierId: 'b', recipientType: 'FACTOR', factorName: 'OTR CAPITAL LLC', payeeEmail: null },
    { carrierId: 'c', recipientType: 'FACTOR', factorName: 'OTR CAPITAL LLC', payeeEmail: null },
  ]
  it('spells every variant the way the table does: the most used spelling', () => {
    const index = factorNameIndex(summarizeFactors(infos, {}))
    expect(canonicalFactorName(index, 'OTR Capital')).toBe('OTR CAPITAL LLC')
    expect(canonicalFactorName(index, 'otr capital llc')).toBe('OTR CAPITAL LLC')
  })
  it('meets spellings that differ only by a space', () => {
    const index = factorNameIndex(summarizeFactors([{ carrierId: 'a', recipientType: 'FACTOR', factorName: 'FIRSTLINE FUNDING GROUP', payeeEmail: null }], {}))
    expect(canonicalFactorName(index, 'FIRST LINE FUNDING GROUP')).toBe('FIRSTLINE FUNDING GROUP')
  })
  it('lets the name filed on the factor win, and shows an unknown factor as typed', () => {
    const index = factorNameIndex(summarizeFactors(infos, { 'OTR CAPITAL': { name: 'OTR Capital', email: 'r@otr.test' } }))
    expect(canonicalFactorName(index, 'OTR CAPITAL LLC')).toBe('OTR Capital')
    expect(canonicalFactorName(index, 'Somebody Else')).toBe('Somebody Else')
    expect(canonicalFactorName(index, '  ')).toBe('')
    expect(canonicalFactorName(null, ' Typed ')).toBe('Typed')
  })
})

describe('the remit e-mail belongs to the pay to (Ryne 2026-11-19)', () => {
  const carriers = [
    { id: 'a', name: 'Blue Line Trucking Inc' },
    { id: 'b', name: 'Red Line Express LLC' },
    { id: 'c', name: 'Green Haul Inc' },
    { id: 'd', name: 'No Method Inc' },
  ]
  const infos = [
    { carrierId: 'a', recipientType: 'FACTOR', factorName: 'RTS Financial', payeeEmail: 'cash@rts.test', isPreferred: true },
    { carrierId: 'b', recipientType: 'FACTOR', factorName: 'RTS FINANCIAL', payeeEmail: 'cash@rts.test', isPreferred: true },
    { carrierId: 'c', recipientType: 'CARRIER', payeeEmail: 'ap@green.test', isPreferred: true },
  ]

  it('files a direct payee under its own name, the same key a factor uses', () => {
    const m = parseFactorRemitMap({ 'GREEN HAUL': { name: 'Green Haul Inc', email: 'filed@green.test' } })
    expect(payeeEmailFor(m, 'GREEN HAUL INC')).toBe('filed@green.test')
    expect(payeeEmailFor(m, 'RTS Financial')).toBe('')
  })

  it('names the pay to: the factor, else the carrier', () => {
    expect(payToNameFor(infos[0], 'Blue Line Trucking Inc')).toBe('RTS Financial')
    expect(payToNameFor(infos[2], 'Green Haul Inc')).toBe('Green Haul Inc')
  })

  it('lists factors and direct payees in one table, one row per pay to, and skips carriers with no method', () => {
    const rows = summarizePayees(carriers, infos, {})
    expect(rows.map((r) => [r.name, r.kind, r.carrierCount])).toEqual([
      ['RTS Financial', 'FACTOR', 2],
      ['Green Haul Inc', 'DIRECT', 1],
    ])
    expect(rows.find((r) => r.name === 'No Method Inc')).toBeUndefined()
  })

  it('counts a missing address once per payee, however many carriers it funds', () => {
    const rows = summarizePayees(carriers, [
      { carrierId: 'a', recipientType: 'FACTOR', factorName: 'Outgo Inc', payeeEmail: null },
      { carrierId: 'b', recipientType: 'FACTOR', factorName: 'Outgo Inc', payeeEmail: null },
      { carrierId: 'c', recipientType: 'CARRIER', payeeEmail: null },
    ], {})
    expect(rows.filter((r) => r.source === 'NONE').map((r) => r.name).sort()).toEqual(['Green Haul Inc', 'Outgo Inc'])
  })

  it('reads an address filed for a direct payee as Set, over the carrier\'s own copy', () => {
    const rows = summarizePayees(carriers, infos, parseFactorRemitMap({ 'GREEN HAUL': { name: 'Green Haul Inc', email: 'filed@green.test' } }))
    expect(rows.find((r) => r.name === 'Green Haul Inc')).toMatchObject({ source: 'SET', email: 'filed@green.test' })
  })

  it('flags carriers paid to one name with different addresses as a conflict', () => {
    const rows = summarizePayees(
      [{ id: 'x', name: 'Twin Haul Inc' }, { id: 'y', name: 'Twin Haul LLC' }],
      [
        { carrierId: 'x', recipientType: 'CARRIER', payeeEmail: 'a@twin.test', isPreferred: true },
        { carrierId: 'y', recipientType: 'CARRIER', payeeEmail: 'b@twin.test', isPreferred: true },
      ],
      {},
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'DIRECT', carrierCount: 2, source: 'CONFLICT', email: '' })
    expect(rows[0]!.conflicting.sort()).toEqual(['a@twin.test', 'b@twin.test'])
  })
})
