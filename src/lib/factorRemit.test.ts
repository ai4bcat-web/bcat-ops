import { describe, expect, it } from 'vitest'
import { applyFactorRemit, canonicalFactorName, effectivePayeeEmail, factorEmailFor, factorNameIndex, factorKeyOf, linkedCarriers, parseFactorRemitMap, payeeEmailFor, payToDisplayName, payToKeyFor, payToNameFor, payToProfileFor, summarizeFactors, summarizePayees } from './factorRemit'

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


describe('pay-to profiles: one resolver for name and alias', () => {
  const map = parseFactorRemitMap({
    'TRIUMPH CAPITAL': {
      name: 'Triumph Capital', email: 'ap@triumph.test', aliases: ['Triumph Capital Funding LLC', 'TRIUMPH CAP'],
      remitAddress: ' 1 Main St, Dallas TX ', paymentMethod: 'ACH',
    },
    'RTS FINANCIAL': { name: 'RTS Financial', email: 'cash@rts.test' },
    'ALIAS ONLY': { name: 'Alias Only', email: '', aliases: ['AO'] },
    JUNK: { name: 'Junk', email: '' },
  })

  it('keeps entries that have a profile but no e-mail, and drops empty ones', () => {
    expect(Object.keys(map).sort()).toEqual(['ALIAS ONLY', 'RTS FINANCIAL', 'TRIUMPH CAPITAL'])
    expect(map['TRIUMPH CAPITAL']).toMatchObject({ remitAddress: '1 Main St, Dallas TX', paymentMethod: 'ACH' })
  })

  it('resolves a name, an alias and a differently punctuated spelling to the same key', () => {
    for (const name of ['Triumph Capital', 'TRIUMPH CAPITAL, INC.', 'triumph capital funding', 'Triumph Cap']) {
      expect(payToKeyFor(map, name)).toBe('TRIUMPH CAPITAL')
    }
    expect(payToKeyFor(map, 'Somebody Else')).toBe('SOMEBODY ELSE')
    expect(payToKeyFor(null, 'Triumph Capital Funding')).toBe('TRIUMPH CAPITAL FUNDING')
    expect(payToKeyFor(map, '  ')).toBe('')
  })

  it('reads the profile\'s e-mail and name through any of its spellings', () => {
    expect(factorEmailFor(map, 'Triumph Capital Funding LLC')).toBe('ap@triumph.test')
    expect(payeeEmailFor(map, 'TRIUMPH CAP')).toBe('ap@triumph.test')
    expect(payToDisplayName(map, 'triumph cap')).toBe('Triumph Capital')
    expect(payToDisplayName(map, 'Unfiled Payee')).toBe('Unfiled Payee')
    expect(payToProfileFor(map, 'AO')?.key).toBe('ALIAS ONLY')
    expect(factorEmailFor(map, 'AO')).toBe('')
  })

  it('lays the profile address over a carrier typed with an alias, and leaves other carriers alone', () => {
    const methods = [
      { carrierId: 'c1', recipientType: 'FACTOR', factorName: 'Triumph Capital Funding LLC', payeeEmail: 'old@a.test' },
      { carrierId: 'c2', recipientType: 'FACTOR', factorName: 'Elsewhere Finance', payeeEmail: 'old@b.test' },
    ]
    const out = applyFactorRemit(methods, map)
    expect(out[0]!.payeeEmail).toBe('ap@triumph.test')
    expect(out[1]!.payeeEmail).toBe('old@b.test')
  })

  it('rolls carriers typed under an alias into one row, with the profile attached', () => {
    const infos = [
      { carrierId: 'c1', recipientType: 'FACTOR', factorName: 'Triumph Capital', payeeEmail: '', status: 'ACTIVE' },
      { carrierId: 'c2', recipientType: 'FACTOR', factorName: 'Triumph Capital Funding LLC', payeeEmail: '', status: 'ACTIVE' },
    ]
    const rows = summarizeFactors(infos, map)
    const triumph = rows.filter((r) => r.key === 'TRIUMPH CAPITAL')
    expect(triumph).toHaveLength(1)
    expect(triumph[0]).toMatchObject({ carrierCount: 2, email: 'ap@triumph.test', source: 'SET' })
    expect(triumph[0]!.profile?.remitAddress).toBe('1 Main St, Dallas TX')
    expect(canonicalFactorName(factorNameIndex(rows), 'TRIUMPH CAP')).toBe('Triumph Capital')
  })

  it('lists the carriers paid to a profile, through a factor or directly, by name or alias', () => {
    const carriers = [{ id: 'c1', name: 'Wheeler' }, { id: 'c2', name: 'Second Haul' }, { id: 'c3', name: 'Triumph Cap' }, { id: 'c4', name: 'Nobody' }]
    const infos = [
      { carrierId: 'c1', recipientType: 'FACTOR', factorName: 'Triumph Capital', status: 'ACTIVE', isPreferred: true },
      { carrierId: 'c2', recipientType: 'FACTOR', factorName: 'Triumph Capital Funding LLC', status: 'ACTIVE', isPreferred: true },
      { carrierId: 'c3', recipientType: 'CARRIER', status: 'ACTIVE', isPreferred: true },
      { carrierId: 'c4', recipientType: 'CARRIER', status: 'INACTIVE' },
    ]
    const linked = linkedCarriers('TRIUMPH CAPITAL', carriers, infos, map)
    expect(linked.map((c) => [c.name, c.via])).toEqual([['Second Haul', 'FACTOR'], ['Triumph Cap', 'DIRECT'], ['Wheeler', 'FACTOR']])
    expect(linked[0]!.typedName).toBe('Triumph Capital Funding LLC')
  })
})
