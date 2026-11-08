import { describe, expect, it } from 'vitest'
import { buildDuplicateIndex, duplicateTooltip, normalizeCustomerName } from './customerDuplicates'

describe('normalizeCustomerName', () => {
  it('ignores case, punctuation and legal suffixes', () => {
    const forms = ['ACME, Inc.', 'Acme LLC', 'acme co', 'The Acme Corporation', 'Acme L.L.C.']
    for (const f of forms) expect(normalizeCustomerName(f)).toBe('acme')
  })
  it('keeps distinguishing words and a name that is only a suffix', () => {
    expect(normalizeCustomerName('Acme Foods Inc')).toBe('acme foods')
    expect(normalizeCustomerName('Acme & Sons')).toBe('acme and sons')
    expect(normalizeCustomerName('INC')).toBe('inc')
  })
})

describe('buildDuplicateIndex', () => {
  const c = (id: string, name: string, aljexCode?: string, extra: object = {}) => ({ id, name, aljexCode, ...extra })

  it('groups same-name customers of different accounts and names the others', () => {
    const idx = buildDuplicateIndex([c('1', 'Traffix Inc.', '100'), c('2', 'TRAFFIX LLC', '200'), c('3', 'Traffix Co', '300'), c('4', 'Other Co', '400')])
    expect(idx.get('1')?.count).toBe(2)
    expect(idx.get('1')?.others.map((o) => o.aljexCode)).toEqual(['200', '300'])
    expect(idx.has('4')).toBe(false)
    expect(duplicateTooltip(idx.get('2')!)).toMatch(/^2 other accounts/)
  })

  it('does not flag rows that share one Aljex account number', () => {
    expect(buildDuplicateIndex([c('1', 'Acme Inc', '100'), c('2', 'Acme LLC', '100')]).size).toBe(0)
  })

  it('counts customers without an account number as distinct accounts, and skips merged-away ones', () => {
    const idx = buildDuplicateIndex([c('1', 'Acme'), c('2', 'Acme Inc'), c('3', 'Acme LLC', '9', { mergedIntoId: '1' })])
    expect(idx.get('1')?.count).toBe(1)
    expect(idx.has('3')).toBe(false)
  })

  it('uses singular wording for one other account', () => {
    const idx = buildDuplicateIndex([c('1', 'Acme', '1'), c('2', 'Acme', '2')])
    expect(duplicateTooltip(idx.get('1')!)).toMatch(/^1 other account share/)
  })
})
