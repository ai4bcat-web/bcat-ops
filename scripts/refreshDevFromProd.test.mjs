import { describe, it, expect } from 'vitest'
import {
  INCLUDE,
  EXCLUDE,
  DEV_ONLY_PROTECTED,
  BACKFILLS,
  PROD_SUFFIX,
  DEV_SUFFIX,
  resolveTables,
  assertDevTarget,
  assertWritableTable,
  amplifyBusyReason,
  diffCounts,
  planBlocker,
  parseArgv,
  backfillCommands,
} from './refreshDevFromProd.mjs'

describe('include / exclude lists', () => {
  it('never put one table on two lists, and never copy a dev-only TMS model', () => {
    const excluded = Object.keys(EXCLUDE)
    expect(INCLUDE.filter((m) => excluded.includes(m))).toEqual([])
    expect(INCLUDE.filter((m) => DEV_ONLY_PROTECTED.includes(m))).toEqual([])
    expect(excluded.filter((m) => DEV_ONLY_PROTECTED.includes(m))).toEqual([])
    expect(new Set(INCLUDE).size).toBe(INCLUDE.length)
  })

  it('keeps the dev-owned config and the real-world-facing state out of the copy', () => {
    for (const m of ['TmsSettings', 'DispatchSettings', 'AuditLog', 'TruckMileage']) expect(INCLUDE).not.toContain(m)
    for (const m of ['Integration', 'OwnershipDivision', 'UserProfile', 'ProClaim', 'Shipment']) expect(INCLUDE).not.toContain(m)
    expect(INCLUDE).toContain('Load')
  })
})

describe('resolveTables', () => {
  const prodModels = ['Load', 'Customer', 'AuditLog', 'TmsSettings', 'BrandNewProdTable']
  const devModels = ['Load', 'Customer', 'AuditLog', 'TmsSettings', 'Shipment']

  it('copies only included tables that exist on both sides and flags what nobody classified', () => {
    const r = resolveTables({ prodModels, devModels })
    expect(r.copy).toEqual(['Customer', 'Load'])
    expect(r.excluded.map((e) => e.model)).toEqual(['AuditLog', 'TmsSettings'])
    expect(r.unclassified).toEqual(['BrandNewProdTable'])
  })

  it('reports an included table the dev schema does not have instead of silently skipping it', () => {
    const r = resolveTables({ prodModels: ['Load', 'Customer'], devModels: ['Load'] })
    expect(r.copy).toEqual(['Load'])
    expect(r.missingInDev).toEqual(['Customer'])
  })

  it('--tables is a subset of INCLUDE: an excluded table asked for by name is not copied', () => {
    const r = resolveTables({ prodModels, devModels, only: ['Load', 'AuditLog'] })
    expect(r.copy).toEqual(['Load'])
    expect(r.notOnIncludeList).toEqual(['AuditLog'])
  })

  it('surfaces a prod table that suddenly shares a name with a dev-only TMS model', () => {
    const r = resolveTables({ prodModels: ['Load', 'Shipment'], devModels: ['Load', 'Shipment'] })
    expect(r.copy).toEqual(['Load'])
    expect(r.protectedHit).toEqual(['Shipment'])
  })
})

describe('guards', () => {
  it('only the dev suffix is a valid target', () => {
    expect(assertDevTarget({})).toBe(DEV_SUFFIX)
    expect(assertDevTarget({ to: DEV_SUFFIX })).toBe(DEV_SUFFIX)
    expect(() => assertDevTarget({ to: PROD_SUFFIX })).toThrow(/production/)
    expect(() => assertDevTarget({ to: `x${PROD_SUFFIX}` })).toThrow(/production/)
    expect(() => assertDevTarget({ to: '77mgrracnrcflguidiahp2vq34-NONE' })).toThrow(/only/)
  })

  it('refuses to back up or write a production table, or any non-dev one', () => {
    expect(assertWritableTable(`Load-${DEV_SUFFIX}`)).toBe(`Load-${DEV_SUFFIX}`)
    expect(() => assertWritableTable(`Load-${PROD_SUFFIX}`)).toThrow(/production/)
    expect(() => assertWritableTable('Load-77mgrracnrcflguidiahp2vq34-NONE')).toThrow(/non-dev/)
  })

  it('treats a RUNNING, PENDING or PROVISIONING Amplify job as busy and finished ones as idle', () => {
    expect(amplifyBusyReason({ jobSummaries: [{ jobId: '9', status: 'SUCCEED' }, { jobId: '8', status: 'FAILED' }] })).toBeNull()
    expect(amplifyBusyReason({ jobSummaries: [] })).toBeNull()
    expect(amplifyBusyReason({})).toBeNull()
    expect(amplifyBusyReason({ jobSummaries: [{ jobId: '10', status: 'RUNNING' }] })).toMatch(/10:RUNNING/)
    expect(amplifyBusyReason({ jobSummaries: [{ jobId: '11', status: 'PENDING' }] })).toMatch(/11:PENDING/)
  })

  it('--backfills requires --apply and --summary must stay under /tmp', () => {
    expect(() => parseArgv(['--backfills'])).toThrow(/--apply/)
    expect(parseArgv(['--apply', '--backfills']).backfills).toBe(true)
    expect(parseArgv(['--backfills-only']).apply).toBe(true)
    expect(() => parseArgv(['--summary', '/Users/x/out.json'])).toThrow(/\/tmp/)
    expect(() => parseArgv(['--summary', '/tmp/../etc/x.json'])).toThrow(/\/tmp/)
    expect(() => parseArgv(['--nope'])).toThrow(/unknown/)
    expect(parseArgv([]).apply).toBe(false)
  })
})

describe('diffCounts', () => {
  it('reports deltas and flags a table that shrank or ended short of prod', () => {
    const rows = diffCounts({
      prod: { Load: 932, Customer: 121, Driver: 16, Equipment: 22 },
      devBefore: { Load: 3539, Customer: 368, Driver: 16, Equipment: 21 },
      devAfter: { Load: 3580, Customer: 373, Driver: 16, Equipment: 20 },
    })
    const by = Object.fromEntries(rows.map((r) => [r.model, r]))
    expect(by.Load).toMatchObject({ delta: 41, flags: [] })
    expect(by.Customer).toMatchObject({ delta: 5, flags: [] })
    expect(by.Driver).toMatchObject({ delta: 0, flags: [] })
    expect(by.Equipment.flags).toEqual(['SHRANK', 'SHORT_OF_PROD'])
  })

  it('a before-only diff has no after, delta or flags', () => {
    const [r] = diffCounts({ prod: { Load: 5 }, devBefore: { Load: 9 } })
    expect(r).toEqual({ model: 'Load', prod: 5, devBefore: 9, devAfter: null, delta: null, flags: [] })
  })
})

describe('backfills', () => {
  it('run in dependency order: claims before shipments, shipments before the revenue and AR passes', () => {
    const order = BACKFILLS.map((b) => b.name)
    const at = (n) => order.indexOf(n)
    expect(at('proClaims')).toBeLessThan(at('shipments'))
    expect(at('customers')).toBeLessThan(at('shipments'))
    expect(at('locations')).toBeLessThan(at('shipments'))
    expect(at('shipments')).toBeLessThan(at('revDivision'))
    expect(at('shipments')).toBeLessThan(at('legacyAr'))
    expect(at('shipments')).toBeLessThan(at('apOpen'))
  })

  it('every apply replays the same plan file its dry run wrote, and never points at the production outputs', () => {
    for (const c of backfillCommands({ outputsPath: '/tmp/w/dev-outputs.json', planDir: '/tmp/w' })) {
      const plan = c.dryRun.match(/--plan (\S+)/)[1]
      expect(c.apply).toContain(`--plan ${plan}`)
      expect(c.apply).toContain('--apply')
      expect(c.dryRun).not.toContain('--apply')
      expect(c.dryRun).not.toContain('amplify_outputs.json')
    }
  })

  it('stops the chain on PRO collisions only for the claims step', () => {
    expect(planBlocker('proClaims', { summary: { collisions: 2 } })).toMatch(/2 PRO collision/)
    expect(planBlocker('proClaims', { summary: { collisions: 0 } })).toBeNull()
    expect(planBlocker('proClaims', null)).toBeNull()
    expect(planBlocker('shipments', { summary: { collisions: 3 } })).toBeNull()
  })
})
