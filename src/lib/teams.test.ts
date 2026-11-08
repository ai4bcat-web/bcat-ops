import { describe, it, expect } from 'vitest'
import { TEAM_SENDER_SLOTS, senderFor, teamKeysFor, teamMembership, teamOf, validateTeams } from './teams'
import type { Team } from '../types/tms'

const team = (over: Partial<Team>): Team => ({
  key: 'EAST',
  name: 'East desk',
  memberIds: ['rep@bcatcorp.com'],
  active: true,
  ...over,
})

describe('validateTeams', () => {
  it('refuses anything that is not a list', () => {
    expect(() => validateTeams({ EAST: ['rep@bcatcorp.com'] })).toThrow('Teams must be a list.')
    expect(() => validateTeams(null)).toThrow('Teams must be a list.')
  })

  it('refuses two teams sharing a key, whatever the case', () => {
    expect(() => validateTeams([team({ key: 'east' }), team({ key: 'EAST' })]))
      .toThrow('Team key "EAST" is used twice.')
  })

  it('refuses a key that is not a key', () => {
    expect(() => validateTeams([team({ key: 'east desk' })])).toThrow(/may only use letters/)
    expect(() => validateTeams([team({ key: 'E'.repeat(25) })])).toThrow(/up to 24 characters/)
    expect(() => validateTeams([team({ key: '  ' })])).toThrow('Every team needs a key.')
  })

  it('refuses a team with nobody in it', () => {
    expect(() => validateTeams([team({ memberIds: [] })])).toThrow('Team EAST needs at least one member.')
    expect(() => validateTeams([team({ memberIds: ['  '] })])).toThrow('Team EAST has a blank member.')
  })

  it('refuses the same person listed twice on one team', () => {
    expect(() => validateTeams([team({ memberIds: ['Rep@bcatcorp.com', 'rep@bcatcorp.com'] })]))
      .toThrow('Team EAST lists rep@bcatcorp.com twice.')
  })

  it('refuses a sender address that is not an address', () => {
    expect(() => validateTeams([team({ senderAddresses: { rateCon: 'east-desk' } })]))
      .toThrow('"east-desk" is not an e-mail address (team EAST, Rate confirmations).')
  })

  it('refuses a nameless team and more teams than anyone has', () => {
    expect(() => validateTeams([team({ name: '  ' })])).toThrow('Team EAST needs a name.')
    const many = Array.from({ length: 51 }, (_, i) => team({ key: `T${i}` }))
    expect(() => validateTeams(many)).toThrow('At most 50 teams are allowed.')
  })

  it('trims, upper-cases the key, defaults active to true and drops unknown properties', () => {
    const [clean] = validateTeams([
      {
        key: ' east ',
        name: '  East desk  ',
        memberIds: [' rep@bcatcorp.com '],
        senderAddresses: { shipment: ' east@bcatcorp.com ', quoteReply: '  ' },
        secret: 'drop me',
      },
    ])
    expect(clean).toEqual({
      key: 'EAST',
      name: 'East desk',
      memberIds: ['rep@bcatcorp.com'],
      active: true,
      senderAddresses: { shipment: 'east@bcatcorp.com' },
    })
  })

  it('keeps an explicit active false and the tracking-contact flag', () => {
    const [clean] = validateTeams([team({ active: false, showContactOnTracking: true })])
    expect(clean.active).toBe(false)
    expect(clean.showContactOnTracking).toBe(true)
  })

  it('accepts an empty list', () => {
    expect(validateTeams([])).toEqual([])
  })
})

describe('teamOf', () => {
  const east = team({ key: 'EAST', memberIds: ['Rep@bcatcorp.com', 'sam@bcatcorp.com'] })
  const west = team({ key: 'WEST', name: 'West desk', memberIds: ['sam@bcatcorp.com'] })

  it('finds the user whatever case their id is stored in', () => {
    expect(teamOf([east, west], 'rep@bcatcorp.com')?.key).toBe('EAST')
    expect(teamOf([east, west], 'SAM@bcatcorp.com')?.key).toBe('EAST')
  })

  it('skips an inactive team and falls through to the active one', () => {
    const retired = team({ key: 'EAST', active: false, memberIds: ['sam@bcatcorp.com'] })
    expect(teamOf([retired, west], 'sam@bcatcorp.com')?.key).toBe('WEST')
    expect(teamOf([retired], 'sam@bcatcorp.com')).toBeNull()
  })

  it('returns null for a stranger, an empty id and no teams at all', () => {
    expect(teamOf([east], 'nobody@bcatcorp.com')).toBeNull()
    expect(teamOf([east], '  ')).toBeNull()
    expect(teamOf(null, 'rep@bcatcorp.com')).toBeNull()
  })
})

describe('teamKeysFor', () => {
  it('lists every active team the user is in', () => {
    const teams = [
      team({ key: 'EAST', memberIds: ['sam@bcatcorp.com'] }),
      team({ key: 'WEST', memberIds: ['SAM@bcatcorp.com'] }),
      team({ key: 'OLD', active: false, memberIds: ['sam@bcatcorp.com'] }),
    ]
    expect(teamKeysFor(teams, 'sam@bcatcorp.com')).toEqual(['EAST', 'WEST'])
    expect(teamKeysFor(teams, 'rep@bcatcorp.com')).toEqual([])
  })
})

describe('senderFor', () => {
  const east = team({ senderAddresses: { shipment: 'east@bcatcorp.com' } })

  it('uses the team address for the slot', () => {
    expect(senderFor([east], 'east', 'shipment', 'ops@bcatcorp.com')).toBe('east@bcatcorp.com')
  })

  it('falls back when the slot, the team or the key is missing', () => {
    expect(senderFor([east], 'EAST', 'rateCon', 'ops@bcatcorp.com')).toBe('ops@bcatcorp.com')
    expect(senderFor([east], 'WEST', 'shipment', 'ops@bcatcorp.com')).toBe('ops@bcatcorp.com')
    expect(senderFor([east], null, 'shipment', 'ops@bcatcorp.com')).toBe('ops@bcatcorp.com')
    expect(senderFor(null, 'EAST', 'shipment', 'ops@bcatcorp.com')).toBe('ops@bcatcorp.com')
  })

  it('still sends from a retired team that a record still names', () => {
    expect(senderFor([team({ ...east, active: false })], 'EAST', 'shipment', 'ops@bcatcorp.com'))
      .toBe('east@bcatcorp.com')
  })

  it('covers every stored slot', () => {
    const all = team({
      senderAddresses: {
        shipment: 'shipment@bcatcorp.com',
        rateCon: 'rateCon@bcatcorp.com',
        quoteReply: 'quoteReply@bcatcorp.com',
        customerInvoice: 'customerInvoice@bcatcorp.com',
        remittance: 'remittance@bcatcorp.com',
      },
    })
    for (const slot of TEAM_SENDER_SLOTS) {
      expect(senderFor([all], 'EAST', slot, 'ops@bcatcorp.com')).toBe(`${slot}@bcatcorp.com`)
    }
  })
})

describe('teamMembership', () => {
  it('maps every active member to their team keys, lower-cased', () => {
    const teams = [
      team({ key: 'EAST', memberIds: ['Sam@bcatcorp.com', 'rep@bcatcorp.com'] }),
      team({ key: 'WEST', memberIds: ['SAM@bcatcorp.com'] }),
      team({ key: 'OLD', active: false, memberIds: ['rep@bcatcorp.com'] }),
    ]
    expect(teamMembership(teams)).toEqual({
      'sam@bcatcorp.com': ['EAST', 'WEST'],
      'rep@bcatcorp.com': ['EAST'],
    })
  })

  it('is empty when there are no teams', () => {
    expect(teamMembership(null)).toEqual({})
  })
})
