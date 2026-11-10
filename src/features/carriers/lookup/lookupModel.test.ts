import { describe, expect, it } from 'vitest'
import { buildReviewCard, stubReviewCard } from '@/lib/integrations/mcpReview'
import type { McpReviewCard } from '@/lib/integrations/mcpReview'
import { chosenRecipients, defaultRecipients, lookupState } from './lookupModel'
import type { LookupDirectoryRow } from './lookupModel'

const NOW_MS = Date.parse('2026-11-05T12:00:00Z')
const NOW = '2026-11-05T12:00:00.000Z'

const BODY = {
  DotNumber: 7000001, DocketNumber: 'MC900001', CompanyName: 'Zephyr Test Freight LLC', Status: 'ACTIVE',
  Emails: [{ Description: 'Dispatch', Email: 'dispatch@zephyr.example' }, { Email: 'owner@zephyr.example' }],
  CertData: { Certificates: [{ Coverages: [{ Type: 'Cargo', ExpirationDate: '2099-01-01T00:00:00', CoverageLimit: '$100,000' }] }] },
}
const card = (extra: Record<string, unknown> = {}): McpReviewCard => buildReviewCard({ ...BODY, ...extra }, {}, 'preview', NOW_MS)!
const row = (over: Partial<LookupDirectoryRow> = {}): LookupDirectoryRow => ({ id: 'car-1', name: 'Zephyr', status: 'ACTIVE', mcpStatus: 'ACCEPTABLE', ...over })

describe('lookupState: directory × packet matrix', () => {
  const cases: Array<[string, Partial<LookupDirectoryRow> | null, 'LIVE' | 'STUB', string, boolean, boolean, boolean]> = [
    // label, directory row, mode, packet kind, activeReady, send enabled, cover enabled
    ['directory ACTIVE + packet complete', {}, 'LIVE', 'COMPLETE', true, true, true],
    ['directory ACTIVE + invited', { mcpStatus: 'INVITED', mcpInvitedAt: '2026-11-04T12:00:00Z' }, 'LIVE', 'INVITED', false, true, false],
    ['directory ACTIVE + no packet', { mcpStatus: null }, 'LIVE', 'NONE', false, true, false],
    ['directory INACTIVE + packet complete', { status: 'INACTIVE' }, 'LIVE', 'COMPLETE', false, true, false],
    ['directory PENDING + invited', { status: 'PENDING', mcpStatus: 'INVITED', mcpInvitedAt: '2026-11-04T12:00:00Z' }, 'LIVE', 'INVITED', false, true, false],
    ['directory INACTIVE + no packet', { status: 'INACTIVE', mcpStatus: 'NOT_INVITED' }, 'LIVE', 'NONE', false, true, false],
    ['not in directory + no packet', null, 'LIVE', 'NONE', false, true, false],
    ['stub, in directory with a packet on our record', {}, 'STUB', 'COMPLETE', true, false, true],
    ['stub, in directory with no packet on our record', { mcpStatus: null }, 'STUB', 'STUB', false, false, false],
    ['stub, not in directory', null, 'STUB', 'STUB', false, false, false],
  ]
  it.each(cases)('%s', (_label, dir, mode, packet, activeReady, send, cover) => {
    const state = lookupState({ card: mode === 'STUB' ? stubReviewCard({ mcNumber: 'MC900001' }, NOW_MS) : card(), mode, carrier: dir ? row(dir) : null, nowIso: NOW })
    expect(state.packet.kind).toBe(packet)
    expect(state.activeReady).toBe(activeReady)
    expect(state.send.enabled).toBe(send)
    expect(state.cover.enabled).toBe(cover)
    expect(state.directory.inDirectory).toBe(dir !== null)
  })

  it('Cover is primary only for an active, packet-complete carrier; Send is primary when there is no packet', () => {
    const active = lookupState({ card: card(), mode: 'LIVE', carrier: row(), nowIso: NOW })
    expect([active.cover.primary, active.send.primary]).toEqual([true, false])
    const none = lookupState({ card: card(), mode: 'LIVE', carrier: null, nowIso: NOW })
    expect([none.cover.primary, none.send.primary]).toEqual([false, true])
  })
})

describe('lookupState: send action', () => {
  it('is enabled whenever MCP is live and returns at least one e-mail, with no hand-typed address involved', () => {
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: null, nowIso: NOW }).send).toMatchObject({ enabled: true, label: 'Send setup packet' })
  })

  it('is disabled with the reason when MCP returns no e-mail, there is no MCP record, the carrier is Do not use, or MCP is a stub', () => {
    const noEmail = lookupState({ card: card({ Emails: [] }), mode: 'LIVE', carrier: null, nowIso: NOW }).send
    expect(noEmail).toMatchObject({ enabled: false, reason: expect.stringMatching(/no e-mail address/) })
    expect(lookupState({ card: null, mode: 'LIVE', carrier: null, nowIso: NOW }).send.reason).toMatch(/no record/)
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: row({ status: 'DO_NOT_USE' }), nowIso: NOW }).send.reason).toMatch(/Do not use/)
    expect(lookupState({ card: stubReviewCard({}, NOW_MS), mode: 'STUB', carrier: null, nowIso: NOW }).send.reason).toMatch(/^Stub, no MCP call/)
  })

  it('becomes Re-send packet only when INVITED for more than 3 days', () => {
    const invited = (at: string) => lookupState({ card: card(), mode: 'LIVE', carrier: row({ status: 'PENDING', mcpStatus: 'INVITED', mcpInvitedAt: at }), nowIso: NOW })
    expect(invited('2026-11-02T11:59:00Z').send).toMatchObject({ label: 'Re-send packet', primary: true })
    expect(invited('2026-11-02T12:01:00Z').send).toMatchObject({ label: 'Send setup packet', primary: false })
  })

  it('names the cover blocker in the hover title', () => {
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: null, nowIso: NOW }).cover.reason).toMatch(/send the setup packet first/)
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: row({ status: 'INACTIVE' }), nowIso: NOW }).cover.reason).toMatch(/Inactive/)
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: row({ status: 'DO_NOT_USE' }), nowIso: NOW }).cover.reason).toMatch(/Do not use/)
  })

  it('offers Open carrier for a directory hit and Add to directory (live, with an MCP record only) for none', () => {
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: row(), nowIso: NOW }).directoryAction).toEqual({ kind: 'open', enabled: true })
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: null, nowIso: NOW }).directoryAction).toEqual({ kind: 'add', enabled: true })
    expect(lookupState({ card: null, mode: 'LIVE', carrier: null, nowIso: NOW }).directoryAction.enabled).toBe(false)
    expect(lookupState({ card: stubReviewCard({}, NOW_MS), mode: 'STUB', carrier: null, nowIso: NOW }).directoryAction.enabled).toBe(false)
  })

  it('flags failing MCP vetting: expired cover, inactive authority', () => {
    const expired = card({ CertData: { Certificates: [{ Coverages: [{ Type: 'Cargo', ExpirationDate: '2020-01-01T00:00:00' }] }] } })
    expect(lookupState({ card: expired, mode: 'LIVE', carrier: null, nowIso: NOW }).vetting.failing).toContain('Cargo expired')
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: null, nowIso: NOW }).vetting.failing).toEqual([])
  })
})

describe('recipients', () => {
  it('default is every MCP address; an unticked one is dropped; a typed one is additive; nothing ticked is an empty list', () => {
    const emails = card().emails
    expect(defaultRecipients(emails)).toEqual(['dispatch@zephyr.example', 'owner@zephyr.example'])
    expect(chosenRecipients(['dispatch@zephyr.example'], [])).toEqual(['dispatch@zephyr.example'])
    expect(chosenRecipients(['dispatch@zephyr.example', 'owner@zephyr.example'], [' New@Carrier.com ', 'dispatch@zephyr.example'])).toEqual(['dispatch@zephyr.example', 'owner@zephyr.example', 'new@carrier.com'])
    expect(chosenRecipients([], [])).toEqual([])
  })
})

describe('lookupState: active with us, own fleet and the risk limit', () => {
  it('answers "active with us?" with the reason', () => {
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: row(), nowIso: NOW }).activeWithUs).toEqual({ active: true, label: 'Active with us', why: 'Setup complete in MyCarrierPackets' })
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: null, nowIso: NOW }).activeWithUs).toMatchObject({ active: false, why: 'Not in our directory yet' })
    const inactive = lookupState({ card: card(), mode: 'LIVE', carrier: row({ status: 'INACTIVE', statusReason: 'EXPIRED_INSURANCE', statusNote: 'cargo lapsed 10/31' }), nowIso: NOW }).activeWithUs
    expect(inactive.active).toBe(false)
    expect(inactive.why).toBe('Expired insurance: cargo lapsed 10/31')
    expect(lookupState({ card: card(), mode: 'LIVE', carrier: row({ status: 'PENDING', mcpStatus: 'INVITED', mcpInvitedAt: '2026-11-04T12:00:00Z' }), nowIso: NOW }).activeWithUs.why).toBe('Waiting for the carrier to finish its setup packet')
  })
  it('Ivan Cartage (MC 274623) is our own fleet: Active, no vetting flags, no packet, not coverable as a carrier', () => {
    const ivan = card({ DocketNumber: 'MC274623', CompanyName: 'IVAN CARTAGE COMPANY' })
    const s = lookupState({ card: ivan, mode: 'LIVE', carrier: null, nowIso: NOW })
    expect(s.ownFleet).toBe(true)
    expect(s.activeWithUs).toMatchObject({ active: true, why: 'Ivan Cartage is our own fleet' })
    expect(s.vetting.failing).toEqual([])
    expect(s.send.enabled).toBe(false)
    expect(s.cover.enabled).toBe(false)
  })
})
