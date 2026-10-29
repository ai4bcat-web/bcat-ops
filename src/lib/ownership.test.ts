import { describe, it, expect } from 'vitest'
import {
  OWN_FLEET_CARRIER_CODE,
  SEED_DIVISIONS,
  SEED_RULES,
  divisionTree,
  matchesCondition,
  resolveDivision,
  shipmentContextFor,
  topLevelOf,
  validateDivisions,
  validateRules,
} from './ownership'
import type { ResolveContext } from './ownership'
import type { OwnershipDivisionRecord, OwnershipRuleRecord } from '../types/tms'

const AUDIT = { createdBy: 'seed', updatedBy: 'seed', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }

const divisions: OwnershipDivisionRecord[] = SEED_DIVISIONS.map((d) => ({ ...d, ...AUDIT }))
const rules: OwnershipRuleRecord[] = SEED_RULES.map((r) => ({ ...r, ...AUDIT }))

const ctx = (patch: Partial<ResolveContext> = {}): ResolveContext => ({
  carrierId: null,
  driverFleetGroup: null,
  driverType: null,
  driverProgram: null,
  customerId: null,
  equipment: null,
  mode: null,
  loadSource: null,
  references: [],
  ...patch,
})

describe('resolveDivision with the seed rules', () => {
  it('tags an owner-operator own-fleet load to the Owner Operators subsidiary', () => {
    expect(resolveDivision(divisions, rules, ctx({
      carrierId: OWN_FLEET_CARRIER_CODE,
      driverFleetGroup: 'OWNER_OPERATOR',
      driverType: 'OWNER_OPERATOR',
      driverProgram: 'SETTLEMENT',
    }))).toEqual({ revDivision: 'ASSETS', revSubdivision: 'OWNER_OPERATOR', ruleId: 'rule-seed-1' })
  })

  it('tags an owner operator known only by driverType', () => {
    expect(resolveDivision(divisions, rules, ctx({
      carrierId: OWN_FLEET_CARRIER_CODE,
      driverType: 'OWNER_OPERATOR',
    }))).toEqual({ revDivision: 'ASSETS', revSubdivision: 'OWNER_OPERATOR', ruleId: 'rule-seed-2' })
  })

  it('tags a box-truck driver to Box Trucks', () => {
    expect(resolveDivision(divisions, rules, ctx({
      carrierId: OWN_FLEET_CARRIER_CODE,
      driverFleetGroup: 'BOX_TRUCK',
      driverProgram: 'PAPERWORK',
    }))).toEqual({ revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK', ruleId: 'rule-seed-3' })
  })

  it('tags a local driver to Local Drivers', () => {
    expect(resolveDivision(divisions, rules, ctx({
      carrierId: OWN_FLEET_CARRIER_CODE,
      driverFleetGroup: 'LOCAL',
      driverProgram: 'PAPERWORK',
    }))).toEqual({ revDivision: 'ASSETS', revSubdivision: 'LOCAL', ruleId: 'rule-seed-4' })
  })

  it('leaves an Amazon driver in Ivan Cartage with no subsidiary', () => {
    expect(resolveDivision(divisions, rules, ctx({
      carrierId: OWN_FLEET_CARRIER_CODE,
      driverFleetGroup: 'AMAZON',
      driverProgram: 'SETTLEMENT',
    }))).toEqual({ revDivision: 'ASSETS', revSubdivision: null, ruleId: 'rule-seed-5' })
  })

  it('reads a vehicle reference on an outside carrier as car shipping', () => {
    expect(resolveDivision(divisions, rules, ctx({
      carrierId: 'carrier-9',
      references: ['PO 55120', 'VEHICLE 2019 HONDA'],
    }))).toEqual({ revDivision: 'CAR_SHIPPING', revSubdivision: null, ruleId: 'rule-seed-6' })
  })

  it('falls through to Brokerage for a plain outside carrier', () => {
    expect(resolveDivision(divisions, rules, ctx({
      carrierId: 'carrier-9',
      references: ['PO 55120'],
    }))).toEqual({ revDivision: 'BROKERAGE', revSubdivision: null, ruleId: 'rule-seed-7' })
  })

  it('takes the first matching rule, not the most specific one', () => {
    // An own-fleet box-truck driver matches both rule 3 and rule 5; order decides.
    const reordered = rules.map((r) => (r.id === 'rule-seed-5' ? { ...r, sortOrder: 0 } : r))
    expect(resolveDivision(divisions, reordered, ctx({
      carrierId: OWN_FLEET_CARRIER_CODE,
      driverFleetGroup: 'BOX_TRUCK',
    }))).toEqual({ revDivision: 'ASSETS', revSubdivision: null, ruleId: 'rule-seed-5' })
  })

  it('skips an inactive rule', () => {
    const withoutBoxTrucks = rules.map((r) => (r.id === 'rule-seed-3' ? { ...r, active: false } : r))
    expect(resolveDivision(divisions, withoutBoxTrucks, ctx({
      carrierId: OWN_FLEET_CARRIER_CODE,
      driverFleetGroup: 'BOX_TRUCK',
    }))).toEqual({ revDivision: 'ASSETS', revSubdivision: null, ruleId: 'rule-seed-5' })
  })

  it('skips a rule whose division has been archived', () => {
    const archived = divisions.map((d) => (d.code === 'BOX_TRUCK' ? { ...d, active: false } : d))
    expect(resolveDivision(archived, rules, ctx({
      carrierId: OWN_FLEET_CARRIER_CODE,
      driverFleetGroup: 'BOX_TRUCK',
    }))).toEqual({ revDivision: 'ASSETS', revSubdivision: null, ruleId: 'rule-seed-5' })
  })

  it('leaves a shipment untagged when nothing matches', () => {
    const noCatchAll = rules.filter((r) => r.id !== 'rule-seed-7')
    expect(resolveDivision(divisions, noCatchAll, ctx({ carrierId: 'carrier-9' })))
      .toEqual({ revDivision: null, revSubdivision: null, ruleId: null })
  })

  it('rolls a subdivision of any depth up to its top-level ancestor', () => {
    const deep: OwnershipDivisionRecord[] = [
      ...divisions,
      { ...AUDIT, id: 'BOX_TRUCK_NIGHT', code: 'BOX_TRUCK_NIGHT', name: 'Box Trucks — nights', brand: null, parentId: 'BOX_TRUCK', color: null, sortOrder: 1, active: true, owners: null, flows: null },
    ]
    const deepRule: OwnershipRuleRecord = {
      ...AUDIT,
      id: 'rule-night',
      name: 'Night box trucks',
      sortOrder: 0,
      active: true,
      condition: { kind: 'DRIVER_PROGRAM_IS', value: 'PAPERWORK' },
      divisionCode: 'BOX_TRUCK_NIGHT',
    }
    expect(resolveDivision(deep, [deepRule, ...rules], ctx({ driverProgram: 'PAPERWORK' })))
      .toEqual({ revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK_NIGHT', ruleId: 'rule-night' })
  })
})

describe('matchesCondition', () => {
  it('matches free-text equipment and mode case-insensitively', () => {
    expect(matchesCondition({ kind: 'EQUIPMENT_IS', value: 'reefer' }, ctx({ equipment: 'REEFER' }))).toBe(true)
    expect(matchesCondition({ kind: 'MODE_IS', value: 'FTL' }, ctx({ mode: 'ftl' }))).toBe(true)
    expect(matchesCondition({ kind: 'LOAD_SOURCE_IS', value: 'BACKFILL' }, ctx({ loadSource: 'MANUAL' }))).toBe(false)
  })

  it('never matches a condition with no value, except ALWAYS', () => {
    expect(matchesCondition({ kind: 'CARRIER_IS', value: null }, ctx({ carrierId: 'c1' }))).toBe(false)
    expect(matchesCondition({ kind: 'REFERENCE_MATCHES', value: '' }, ctx({ references: ['x'] }))).toBe(false)
    expect(matchesCondition({ kind: 'ALWAYS', value: null }, ctx())).toBe(true)
  })

  it('refuses a broken reference pattern instead of throwing', () => {
    expect(matchesCondition({ kind: 'REFERENCE_MATCHES', value: '([' }, ctx({ references: ['anything'] }))).toBe(false)
  })
})

describe('topLevelOf and divisionTree', () => {
  it('walks any depth up to the top-level business', () => {
    expect(topLevelOf(divisions, 'BOX_TRUCK')).toBe('ASSETS')
    expect(topLevelOf(divisions, 'ASSETS')).toBe('ASSETS')
    expect(topLevelOf(divisions, 'NOPE')).toBeNull()
  })

  it('returns null rather than looping on a broken parent chain', () => {
    const looped: OwnershipDivisionRecord[] = [
      { ...AUDIT, id: 'A', code: 'A', name: 'A', brand: null, parentId: 'B', color: null, sortOrder: 1, active: true, owners: null, flows: null },
      { ...AUDIT, id: 'B', code: 'B', name: 'B', brand: null, parentId: 'A', color: null, sortOrder: 2, active: true, owners: null, flows: null },
    ]
    expect(topLevelOf(looped, 'A')).toBeNull()
  })

  it('nests the three Ivan subsidiaries under Ivan Cartage in sort order', () => {
    const tree = divisionTree(divisions)
    expect(tree.map((n) => n.division.code)).toEqual(['BROKERAGE', 'ASSETS', 'CAR_SHIPPING', 'COMPANY'])
    const assets = tree.find((n) => n.division.code === 'ASSETS')
    expect(assets?.children.map((c) => c.division.code)).toEqual(['OWNER_OPERATOR', 'BOX_TRUCK', 'LOCAL'])
  })
})

describe('validateDivisions', () => {
  it('passes the seed tree', () => {
    expect(validateDivisions(divisions)).toEqual([])
  })

  it('refuses a cycle', () => {
    const looped: OwnershipDivisionRecord[] = [
      { ...AUDIT, id: 'A', code: 'A', name: 'A', brand: null, parentId: 'B', color: null, sortOrder: 1, active: true, owners: null, flows: null },
      { ...AUDIT, id: 'B', code: 'B', name: 'B', brand: null, parentId: 'A', color: null, sortOrder: 2, active: true, owners: null, flows: null },
    ]
    expect(validateDivisions(looped)).toEqual([
      'Division "A" is its own ancestor.',
      'Division "B" is its own ancestor.',
    ])
  })

  it('reports duplicate codes, unknown parents and blank names', () => {
    const broken: OwnershipDivisionRecord[] = [
      { ...AUDIT, id: 'X', code: 'X', name: 'X', brand: null, parentId: null, color: null, sortOrder: 1, active: true, owners: null, flows: null },
      { ...AUDIT, id: 'X2', code: 'X', name: '  ', brand: null, parentId: 'GHOST', color: null, sortOrder: 2, active: true, owners: null, flows: null },
    ]
    expect(validateDivisions(broken)).toEqual([
      'Duplicate division code "X".',
      'Division "X" has no name.',
      'Division "X" has an unknown parent "GHOST".',
    ])
  })
})

describe('validateRules', () => {
  it('passes the seed rules against the seed divisions', () => {
    expect(validateRules(rules, divisions)).toEqual([])
  })

  it('reports an unknown division, a missing value and a broken pattern', () => {
    const broken: OwnershipRuleRecord[] = [
      { ...AUDIT, id: 'r1', name: 'Ghost', sortOrder: 1, active: true, condition: { kind: 'ALWAYS', value: null }, divisionCode: 'GHOST' },
      { ...AUDIT, id: 'r2', name: 'Blank', sortOrder: 2, active: true, condition: { kind: 'CUSTOMER_IS', value: '' }, divisionCode: 'BROKERAGE' },
      { ...AUDIT, id: 'r3', name: 'Bad regex', sortOrder: 3, active: true, condition: { kind: 'REFERENCE_MATCHES', value: '([' }, divisionCode: 'BROKERAGE' },
    ]
    expect(validateRules(broken, divisions)).toEqual([
      'Rule "Ghost" points at an unknown division "GHOST".',
      'Rule "Blank" needs a value for CUSTOMER_IS.',
      'Rule "Bad regex" has an invalid reference pattern.',
    ])
  })
})

describe('shipmentContextFor', () => {
  it('maps an own-asset leg onto the reserved OWN_FLEET carrier', () => {
    const context = shipmentContextFor({
      shipment: { customerId: 'cust-1', mode: 'FTL', source: 'MANUAL' },
      order: { references: [{ code: 'PO', value: 'VEHICLE 2019 HONDA' }], equipmentType: 'VAN' },
      loadCarrier: { kind: 'OWN_ASSET', carrierId: null },
      driver: { fleetGroup: 'BOX_TRUCK', driverType: 'COMPANY' },
    })
    expect(context).toEqual({
      carrierId: 'OWN_FLEET',
      driverFleetGroup: 'BOX_TRUCK',
      driverType: 'COMPANY',
      driverProgram: 'PAPERWORK',
      customerId: 'cust-1',
      equipment: 'VAN',
      mode: 'FTL',
      loadSource: 'MANUAL',
      references: ['VEHICLE 2019 HONDA'],
    })
  })

  it('carries an outside carrier through and drops blank references', () => {
    const context = shipmentContextFor({
      shipment: { customerId: 'cust-2', mode: 'LTL', source: 'TENDER' },
      order: { references: [{ code: 'PO', value: '  ' }, { code: 'BOL', value: '7781' }] },
      loadCarrier: { kind: 'CARRIER', carrierId: 'carrier-3' },
      driver: null,
    })
    expect(context.carrierId).toBe('carrier-3')
    expect(context.driverProgram).toBeNull()
    expect(context.references).toEqual(['7781'])
  })
})
