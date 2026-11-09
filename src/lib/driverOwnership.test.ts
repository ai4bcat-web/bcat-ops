import { describe, expect, it } from 'vitest'
import { driverOwnershipKind, effectiveDriverType, isOwnerOperator } from './driverOwnership'
import { driverProgramOf } from './driverProgram'
import { driverGroupOf } from './driverFilter'
import { fleetBucketOf } from './revenueByFleet'
import { appLabel } from './podReview'
import { resolveDivision, shipmentContextFor, SEED_DIVISIONS, SEED_RULES } from './ownership'
import type { Driver } from '../types'

/** The roster as production holds it (2026-11-09): fleetGroup is right, driverType drifted. */
const ROSTER = {
  chad: { fleetGroup: 'OWNER_OPERATOR', driverType: 'COMPANY' },
  michael: { fleetGroup: 'OWNER_OPERATOR', driverType: null },
  lee: { fleetGroup: 'OWNER_OPERATOR', driverType: 'OWNER_OPERATOR' },
  zak: { fleetGroup: 'BOX_TRUCK', driverType: null },
  jason: { fleetGroup: 'LOCAL', driverType: 'COMPANY' },
  joshua: { fleetGroup: 'LOCAL', driverType: null },
} as const

const divisionOf = (driver: { fleetGroup?: string | null; driverType?: string | null }) => {
  const ctx = shipmentContextFor({ loadCarrier: { kind: 'OWN_ASSET' }, driver })
  const r = resolveDivision(
    SEED_DIVISIONS.map((d) => ({ ...d, active: d.active !== false })),
    SEED_RULES,
    ctx,
  )
  return `${r.revDivision}/${r.revSubdivision ?? '-'}`
}

describe('driverOwnershipKind: the fleet group is the truth, driverType only fills a blank fleet', () => {
  it.each([
    ['chad', 'OWNER_OPERATOR', 'SETTLEMENT', 'ASSETS/OWNER_OPERATOR', 'OWNER_OP'],
    ['michael', 'OWNER_OPERATOR', 'SETTLEMENT', 'ASSETS/OWNER_OPERATOR', 'OWNER_OP'],
    ['lee', 'OWNER_OPERATOR', 'SETTLEMENT', 'ASSETS/OWNER_OPERATOR', 'OWNER_OP'],
    ['zak', 'BOX_TRUCK', 'PAPERWORK', 'ASSETS/BOX_TRUCK', 'IVAN'],
    ['jason', 'LOCAL', 'PAPERWORK', 'ASSETS/LOCAL', 'IVAN'],
    ['joshua', 'LOCAL', 'PAPERWORK', 'ASSETS/LOCAL', 'IVAN'],
  ] as const)('%s', (name, kind, program, division, group) => {
    const d = ROSTER[name]
    expect(driverOwnershipKind(d)).toBe(kind)
    expect(driverProgramOf(d)).toBe(program)
    expect(divisionOf(d)).toBe(division)
    expect(driverGroupOf({ ...d, type: 'driver' } as unknown as Driver)).toBe(group)
    expect(fleetBucketOf({ id: name, ...d, type: 'driver' } as unknown as Driver)).toBe(kind === 'BOX_TRUCK' ? 'BOX_TRUCK' : group)
    expect(appLabel(d as unknown as Driver)).toBe(group === 'OWNER_OP' ? 'Owner operator app' : 'Ivan driver app')
  })

  it('treats the legacy AMAZON fleet as owner operator', () => {
    expect(isOwnerOperator({ fleetGroup: 'AMAZON', driverType: 'COMPANY' })).toBe(true)
    expect(divisionOf({ fleetGroup: 'AMAZON', driverType: 'COMPANY' })).toBe('ASSETS/OWNER_OPERATOR')
  })

  it('a stale driverType never overrides the fleet', () => {
    for (const fleetGroup of ['LOCAL', 'BOX_TRUCK'] as const) {
      const d = { fleetGroup, driverType: 'OWNER_OPERATOR' }
      expect(isOwnerOperator(d)).toBe(false)
      expect(effectiveDriverType(d)).toBe('COMPANY')
      expect(driverProgramOf(d)).toBe('PAPERWORK')
      expect(divisionOf(d)).toBe(`ASSETS/${fleetGroup}`)
      expect(driverGroupOf({ ...d, type: 'driver' } as unknown as Driver)).toBe('IVAN')
    }
  })

  it('reads driverType only when the fleet is empty', () => {
    expect(driverOwnershipKind({ driverType: 'OWNER_OPERATOR' })).toBe('OWNER_OPERATOR')
    expect(divisionOf({ fleetGroup: null, driverType: 'OWNER_OPERATOR' })).toBe('ASSETS/OWNER_OPERATOR')
    expect(driverOwnershipKind({ driverType: 'COMPANY' })).toBe('COMPANY')
    expect(driverOwnershipKind({})).toBeNull()
    expect(effectiveDriverType({})).toBeNull()
  })
})
