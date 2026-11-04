import { describe, expect, it } from 'vitest'
import {
  LIVE_INVITE_ALLOW_LIST, assertLiveCardIsIvan, assertLiveCarrierAllowed, assertLiveInviteAllowed, assertNoSecret,
  createInviteBudget, liveLogSection,
} from './adLive.mjs'

describe('--live invitation allow-list', () => {
  it('allows exactly ai4bcat@gmail.com, any case, trimmed', () => {
    expect(LIVE_INVITE_ALLOW_LIST).toEqual(['ai4bcat@gmail.com'])
    expect(assertLiveInviteAllowed('  AI4BCAT@gmail.com ')).toBe('ai4bcat@gmail.com')
  })

  it.each(['', '  ', 'ryne@bcatcorp.com', 'ai4bcat+tracking@gmail.com', 'ai4bcat@gmail.com.evil.test', 'x@ai4bcat@gmail.com', 'ai4bcat@gmail.com, other@x.com', 'dispatch@carrier.com'])('refuses %j', (email) => {
    expect(() => assertLiveInviteAllowed(email)).toThrow(/--live refuses/)
  })

  it('sends at most one invitation per run', () => {
    const budget = createInviteBudget()
    budget.take()
    expect(() => budget.take()).toThrow(/exactly 1 invitation/)
    expect(budget.used).toBe(1)
  })
})

describe('--live carrier guard', () => {
  it('names MC 274623 in any spelling and nothing else', () => {
    expect(assertLiveCarrierAllowed({ mcNumber: 'mc-0274623' })).toEqual({ mcNumber: 'MC274623' })
    expect(assertLiveCarrierAllowed({ mcNumber: '274623' })).toEqual({ mcNumber: 'MC274623' })
    for (const ref of [{ mcNumber: 'MC274624' }, { dotNumber: '274623' }, { mcNumber: 'MC274623', dotNumber: '1' }, {}, undefined]) {
      expect(() => assertLiveCarrierAllowed(ref)).toThrow(/--live refuses carrier/)
    }
  })

  it('stops before the invitation when the card behind MC 274623 is not Ivan Cartage', () => {
    expect(assertLiveCardIsIvan({ identity: { legalName: 'IVAN CARTAGE INC', mcNumber: 'MC274623' } })).toBeTruthy()
    expect(() => assertLiveCardIsIvan({ identity: { legalName: 'SOMEBODY ELSE LLC', mcNumber: 'MC274623' } })).toThrow(/not Ivan Cartage/)
    expect(() => assertLiveCardIsIvan({ identity: { legalName: 'IVAN CARTAGE INC', mcNumber: 'MC111' } })).toThrow(/MC 274623/)
    expect(() => assertLiveCardIsIvan(null)).toThrow(/not Ivan Cartage/)
  })
})

describe('MCP_LIVE_TEST.md section', () => {
  const lookup = { preview: { found: true, cardKeys: ['identity', 'risk'] }, data: { found: true, packetStatus: 'INVITED' }, risk: 450, insuranceRows: 2, approvedEmails: 1 }

  it('carries status and key names only', () => {
    const md = liveLogSection({ at: '2026-11-04T18:00:00Z', mode: 'LIVE', lookup, invite: { to: 'ai4bcat@gmail.com', sent: true, mode: 'LIVE', status: 200, bodyKeys: ['Message', 'Success'], carrierLogged: false } })
    expect(md).toContain('MCP HTTP status 200, response keys: Message, Success')
    expect(md).toContain('EmailPacketInvitation to ai4bcat@gmail.com')
  })

  it('refuses to write anything that looks like a credential', () => {
    expect(() => assertNoSecret('Authorization: Bearer abcdefgh12345678')).toThrow()
    expect(() => assertNoSecret('password=hunter2')).toThrow()
    expect(() => assertNoSecret('plain status text')).not.toThrow()
  })
})
