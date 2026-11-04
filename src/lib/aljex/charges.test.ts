import { describe, expect, it } from 'vitest'
import type { CanonicalCharge, CanonicalProjectedExpense } from './canonical'
import { classifyCharge, classifyProjected } from './charges'
import { DEFAULT_ALJEX_PROFILE as P } from './profile'

const line = (n: number, description: string, ext: number, extra: Partial<CanonicalCharge> = {}): CanonicalCharge => ({
  line: n, code: 'F', description, units: '', weight: '', rateCents: ext, extensionCents: ext, ...extra,
})

describe('classifyCharge', () => {
  it('line 1 is the line haul whatever its description says (the description is the commodity)', () => {
    expect(classifyCharge(line(1, 'PALLETS OF PAPER', 250000), P)).toMatchObject({ kind: 'CHARGE', code: 'LINEHAUL', isRate: true, amountCents: 250000 })
  })
  it('fuel descriptions are the fuel surcharge, including ones the map does not list', () => {
    expect(classifyCharge(line(7, 'FUEL SURCHARGE', 5000), P)).toMatchObject({ code: 'FSC', isRate: true })
    expect(classifyCharge(line(7, 'Fuel Adjustment Fee', 5000), P)).toMatchObject({ code: 'FSC', isRate: true })
  })
  it('known accessorials map through the profile; unknown ones stay ACCESSORIAL with their own label', () => {
    expect(classifyCharge(line(8, 'Truck Ordered & Not Used', 15000), P)).toMatchObject({ code: 'TONU', isRate: false })
    expect(classifyCharge(line(8, 'ZZ ODD ACCESSORIAL', 100), P)).toMatchObject({ code: 'ACCESSORIAL', label: 'ZZ ODD ACCESSORIAL' })
    expect(classifyCharge(line(9, '', 100), P)).toMatchObject({ code: 'ACCESSORIAL', label: 'Aljex charge' })
  })
  it('keeps negative amounts (never abs)', () => {
    expect(classifyCharge(line(9, 'LATE DELIVERY CHARGE', -1985), P)).toMatchObject({ code: 'LATE_DELIVERY', amountCents: -1985 })
  })
  it('description-only lines (lines 2..) are invoice notes, not charges; an empty line 1 is skipped', () => {
    expect(classifyCharge(line(2, 'CALL AHEAD', 0, { code: '' }), P).kind).toBe('NOTE')
    expect(classifyCharge(line(1, 'COMMODITY', 0), P).kind).toBe('SKIP')
  })
  it('uses units x rate only when it multiplies out exactly', () => {
    expect(classifyCharge(line(8, 'DETENTION', 30000, { units: '3', rateCents: 10000 }), P)).toMatchObject({ rateCents: 10000, count: 3 })
    expect(classifyCharge(line(8, 'DETENTION', 30001, { units: '3', rateCents: 10000 }), P)).toMatchObject({ rateCents: null, count: 1 })
  })
})

describe('classifyProjected', () => {
  const p = (n: number, type: string, payee = ''): CanonicalProjectedExpense => ({ n, payee, amountCents: 100, type })
  it('maps carrier expense type codes, with LINE as the carrier line haul', () => {
    expect(classifyProjected(p(1, 'LINE'), P)).toMatchObject({ code: 'LINEHAUL', isRate: true })
    expect(classifyProjected(p(2, 'FUE'), P)).toMatchObject({ code: 'FSC', isRate: true })
    expect(classifyProjected(p(3, 'DETN'), P).code).toBe('DETENTION')
    expect(classifyProjected(p(4, 'wxyz'), P)).toMatchObject({ code: 'ACCESSORIAL', label: 'WXYZ' })
  })
})
