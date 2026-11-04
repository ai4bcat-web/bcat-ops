import { describe, expect, it } from 'vitest'
import { parseSearch } from '@/lib/integrations/mcpReview'
import { coverGate, coverRoute, findByNumber } from './coverModel'

describe('coverGate', () => {
  it('blocks an UNACCEPTABLE packet, however MyCarrierPackets spells the review', () => {
    expect(coverGate('UNACCEPTABLE').blocked).toMatch(/unacceptable/)
    expect(coverGate('unacceptable review').blocked).toMatch(/unacceptable/)
    expect(coverGate('Unacceptable-Review').blocked).toMatch(/unacceptable/)
  })

  it('MODERATE is allowed with a warning that needs acknowledging', () => {
    expect(coverGate('MODERATE')).toEqual({ blocked: null, warning: expect.stringMatching(/moderate risk/) })
  })

  it('a clean, unknown or missing status is neither blocked nor warned', () => {
    for (const s of ['ACCEPTABLE', 'INVITED', null, undefined]) expect(coverGate(s)).toEqual({ blocked: null, warning: null })
  })

  it('Do not use blocks regardless of the packet', () => {
    expect(coverGate('ACCEPTABLE', 'DO_NOT_USE').blocked).toMatch(/Do not use/)
  })
})

describe('coverRoute', () => {
  it('ACTIVE is assigned straight away: setup was confirmed by MyCarrierPackets', () => {
    expect(coverRoute({ status: 'ACTIVE' })).toBe('ASSIGN_NOW')
  })

  it('a non-active carrier is assigned only once its setup packet has been sent', () => {
    expect(coverRoute({ status: 'PENDING', mcpInvitedAt: '2026-11-01T00:00:00Z' })).toBe('ASSIGN_WAITING')
    expect(coverRoute({ status: 'PENDING', mcpInvitedAt: null })).toBe('INVITE_FIRST')
    expect(coverRoute({ status: 'INACTIVE' })).toBe('INVITE_FIRST')
  })

  it('a carrier that is not in the directory must be invited first', () => {
    expect(coverRoute(null)).toBe('INVITE_FIRST')
  })
})

describe('findByNumber', () => {
  const carriers = [
    { id: 'a', name: 'Alpha', mcNumber: 'MC123456', dotNumber: '777' },
    { id: 'b', name: 'Bravo', mcNumber: null, dotNumber: '888' },
  ]

  it('finds by MC with or without the prefix, and by DOT', () => {
    expect(findByNumber(carriers, parseSearch('MC 123456'))?.id).toBe('a')
    expect(findByNumber(carriers, parseSearch('123456'))?.id).toBe('a')
    expect(findByNumber(carriers, parseSearch('DOT 888'))?.id).toBe('b')
  })

  it('answers null for a miss and for a typed name', () => {
    expect(findByNumber(carriers, parseSearch('MC 999999'))).toBeNull()
    expect(findByNumber(carriers, parseSearch('Alpha'))).toBeNull()
  })
})
