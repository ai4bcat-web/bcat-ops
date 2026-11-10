import { describe, expect, it, vi } from 'vitest'
import { mcpCarrierStatusPatch, mcpLapseOf } from './mcpCarrierStatus'
import { advanceAfterCarrierActive, type LadderDeps } from './mcpLadder'

const NOW = '2026-11-03T12:00:00.000Z'
const GOOD_POLICIES = [
  { type: 'CARGO', expiresAt: '2027-01-01T00:00:00.000Z' },
  { type: 'AUTO_LIABILITY', expiresAt: '2027-06-30T00:00:00.000Z' },
]

describe('mcpCarrierStatusPatch: MyCarrierPackets drives Carrier.status', () => {
  it.each(['PENDING_REVIEW', 'ACCEPTABLE', 'MODERATE'])('a %s packet activates a PENDING or REVIEW carrier', (mcpStatus) => {
    for (const status of ['PENDING', 'REVIEW']) {
      expect(mcpCarrierStatusPatch({ status, mcpStatus, insurancePolicies: GOOD_POLICIES }, NOW)).toMatchObject({ status: 'ACTIVE', statusReason: null, statusChangedBy: 'mcp-sync' })
    }
  })

  it.each([null, 'NOT_INVITED', 'INVITED', 'IN_PROGRESS'])('an incomplete packet (%s) never activates', (mcpStatus) => {
    expect(mcpCarrierStatusPatch({ status: 'PENDING', mcpStatus }, NOW)).toEqual({})
  })

  it('a finished packet activates whatever its rating, and an UNACCEPTABLE rating never switches an Active carrier off (the rating gates assignment instead)', () => {
    expect(mcpCarrierStatusPatch({ status: 'PENDING', mcpStatus: 'UNACCEPTABLE', insurancePolicies: GOOD_POLICIES }, NOW)).toMatchObject({ status: 'ACTIVE' })
    expect(mcpCarrierStatusPatch({ status: 'PENDING', mcpStatus: 'UNACCEPTABLE_REVIEW', insurancePolicies: GOOD_POLICIES }, NOW)).toMatchObject({ status: 'ACTIVE' })
    expect(mcpCarrierStatusPatch({ status: 'ACTIVE', mcpStatus: 'UNACCEPTABLE_REVIEW', insurancePolicies: GOOD_POLICIES }, NOW)).toEqual({})
  })

  it('a lapse flips an ACTIVE carrier INACTIVE with the reason: insurance, authority', () => {
    const lapsed = [{ type: 'CARGO', expiresAt: '2026-10-01T00:00:00.000Z' }]
    expect(mcpCarrierStatusPatch({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE', insurancePolicies: lapsed }, NOW)).toMatchObject({ status: 'INACTIVE', statusReason: 'EXPIRED_INSURANCE', statusChangedBy: 'mcp-sync' })
    expect(mcpCarrierStatusPatch({ status: 'ACTIVE', mcpStatus: 'ACCEPTABLE', authorityStatus: 'INACTIVE', insurancePolicies: GOOD_POLICIES }, NOW)).toMatchObject({ status: 'INACTIVE', statusReason: 'INACTIVE_AUTHORITY' })
    expect(mcpLapseOf({ authorityStatus: 'ACTIVE', insurancePolicies: GOOD_POLICIES }, NOW)).toBeNull()
  })

  it('a complete packet with a lapse is not activated', () => {
    expect(mcpCarrierStatusPatch({ status: 'PENDING', mcpStatus: 'ACCEPTABLE', authorityStatus: 'INACTIVE' }, NOW)).toEqual({})
  })

  it('reactivates only a carrier MCP itself turned off, never one a person turned off', () => {
    const base = { mcpStatus: 'ACCEPTABLE', insurancePolicies: GOOD_POLICIES }
    expect(mcpCarrierStatusPatch({ ...base, status: 'INACTIVE', statusChangedBy: 'mcp-sync' }, NOW)).toMatchObject({ status: 'ACTIVE' })
    expect(mcpCarrierStatusPatch({ ...base, status: 'INACTIVE', statusChangedBy: 'ops@example.com' }, NOW)).toEqual({})
    // On MCP's monitored list, a person's Inactive does not hold it off (Ryne 2026-11-10) ...
    expect(mcpCarrierStatusPatch({ ...base, status: 'INACTIVE', statusChangedBy: 'ops@example.com' }, NOW, { monitored: true })).toMatchObject({ status: 'ACTIVE' })
    // ... but Do not use is a human judgement, and a lapse still wins.
    expect(mcpCarrierStatusPatch({ ...base, status: 'DO_NOT_USE' }, NOW, { monitored: true })).toEqual({})
    expect(mcpCarrierStatusPatch({ ...base, status: 'INACTIVE', statusChangedBy: 'ops@example.com', authorityStatus: 'INACTIVE' }, NOW, { monitored: true })).toEqual({})
  })

  it('never touches DO_NOT_USE, and leaves a carrier with no MCP data (Aljex-imported) alone', () => {
    expect(mcpCarrierStatusPatch({ status: 'DO_NOT_USE', mcpStatus: 'ACCEPTABLE', insurancePolicies: GOOD_POLICIES }, NOW)).toEqual({})
    expect(mcpCarrierStatusPatch({ status: 'ACTIVE', mcpStatus: 'NOT_INVITED' }, NOW)).toEqual({})
  })
})

describe('advanceAfterCarrierActive: assignments waiting on setup advance when MCP activates the carrier', () => {
  function harness(rows: Array<Record<string, unknown>>) {
    const advance = vi.fn(async () => 'WRITTEN' as const)
    const mirror = vi.fn(async () => undefined)
    const audit = vi.fn(async () => undefined)
    const deps: LadderDeps = { assignmentsOf: async () => rows, advance, mirror, audit }
    return { deps, advance, mirror, audit }
  }
  const waiting = { id: 'lc-1', kind: 'CARRIER', status: 'ACTIVE', loadId: 'l1', shipmentId: 's1', assignmentStatus: 'ASSIGNED_SETUP_PENDING', rateConStatus: 'NOT_SENT' }

  it('moves a waiting assignment to ASSIGNED_SETUP_COMPLETE, mirrors it and audits it', async () => {
    const h = harness([waiting])
    expect(await advanceAfterCarrierActive(h.deps, { id: 'car-1' }, NOW)).toEqual(['lc-1'])
    expect(h.advance).toHaveBeenCalledWith(waiting, expect.objectContaining({ assignmentStatus: 'ASSIGNED_SETUP_COMPLETE', updatedBy: 'mcp-sync' }))
    expect(h.mirror).toHaveBeenCalledWith(waiting, 'ASSIGNED_SETUP_COMPLETE')
    expect(h.audit).toHaveBeenCalledWith('lc-1', 'ASSIGNMENT_ADVANCED', expect.objectContaining({ from: 'ASSIGNED_SETUP_PENDING', to: 'ASSIGNED_SETUP_COMPLETE', source: 'MCP_SYNC' }))
  })

  it('never walks a further rung back, skips removed rows and rows from before the ladder', async () => {
    const h = harness([
      { ...waiting, id: 'lc-2', assignmentStatus: 'RATE_CON_SIGNED', rateConStatus: 'SIGNED' },
      { ...waiting, id: 'lc-3', status: 'BOUNCED' },
      { ...waiting, id: 'lc-4', assignmentStatus: undefined },
    ])
    expect(await advanceAfterCarrierActive(h.deps, { id: 'car-1' }, NOW)).toEqual([])
    expect(h.advance).not.toHaveBeenCalled()
  })

  it('a conflicting write leaves no mirror or audit behind', async () => {
    const h = harness([waiting])
    h.advance.mockResolvedValueOnce('CONFLICT' as never)
    expect(await advanceAfterCarrierActive(h.deps, { id: 'car-1' }, NOW)).toEqual([])
    expect(h.mirror).not.toHaveBeenCalled()
  })
})

describe('our own fleet', () => {
  const NOW = '2026-11-10T12:00:00.000Z'
  const fresh = [{ type: 'CARGO', active: true, expiresAt: '2027-08-21T00:00:00.000Z' }]
  it('Ivan Cartage is Active from its MyCarrierPackets profile alone, with no setup packet', () => {
    const patch = mcpCarrierStatusPatch({ mcNumber: 'MC274623', status: 'PENDING', mcpStatus: 'NOT_INVITED', authorityStatus: 'ACTIVE', insurancePolicies: fresh }, NOW)
    expect(patch).toMatchObject({ status: 'ACTIVE', statusNote: 'Ivan Cartage is our own fleet.', statusChangedBy: 'mcp-sync' })
  })
  it('a lapse (authority off) still keeps it from Active, and another carrier with no packet stays Pending', () => {
    expect(mcpCarrierStatusPatch({ mcNumber: '274623', status: 'PENDING', mcpStatus: 'NOT_INVITED', authorityStatus: 'INACTIVE', insurancePolicies: fresh }, NOW)).toEqual({})
    expect(mcpCarrierStatusPatch({ mcNumber: '111111', status: 'PENDING', mcpStatus: 'NOT_INVITED', authorityStatus: 'ACTIVE', insurancePolicies: fresh }, NOW)).toEqual({})
  })
})

