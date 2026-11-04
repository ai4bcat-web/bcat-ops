/**
 * Find & Invite server actions. The LIVE gate and the mcp-sync invoke are the only seams mocked
 * (they need SSM and Lambda); everything MyCarrierPackets sees goes through a mock `fetch`, so
 * nothing here can reach api.mycarrierpackets.com. Credentials are fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

const gate = vi.hoisted(() => vi.fn())
const invoke = vi.hoisted(() => vi.fn())

vi.mock('./integrations', () => ({ mcpFindGate: gate, invokeMcpSync: invoke }))

import { clearMcpTokenCache } from '../../../src/lib/integrations/mcpAdapter'
import { mcpAddCarrier, mcpGetCarrier, mcpPreviewCarrier, mcpSendInvite, type McpFindDeps } from './mcpFind'

const CREDS = { username: 'fake-user', password: 'fake-pass-123' }
const LIVE = { live: true as const, credentials: CREDS }
const STUB = { live: false as const, reason: 'MyCarrierPackets credentials are not configured.' }
const CALLER = { email: 'rep@bcat.example', sub: 's1', groups: ['page-carriers'] }

interface Sent { type: string; input: Record<string, unknown> }

function harness(opts: { failFirstCarrierUpdate?: boolean } = {}) {
  const sent: Sent[] = []
  const audits: Array<{ entityType: string; entityId: string; action: string; changes: Record<string, unknown> }> = []
  let updates = 0
  const dynamo = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ type: cmd.constructor.name, input: cmd.input })
      if (cmd.constructor.name === 'UpdateItemCommand' && opts.failFirstCarrierUpdate && updates++ === 0) {
        const err = new Error('conditional')
        err.name = 'ConditionalCheckFailedException'
        throw err
      }
      return {}
    }),
  }
  const calls: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url)
    if (url.includes('/token')) return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 })
    if (url.includes('EmailPacketInvitation')) return new Response(JSON.stringify({ Success: true, Message: 'queued' }), { status: 200 })
    if (url.includes('PreviewCarrier')) return new Response(JSON.stringify([{ DotNumber: 7000001, DocketNumber: 'MC900001', CompanyName: 'Zephyr Test Freight LLC', Status: 'ACTIVE', Emails: [{ Email: 'dispatch@zephyr.example' }] }]), { status: 200 })
    if (url.includes('GetCarrierData')) return new Response(JSON.stringify({ DOTNumber: 7000001, MCNumber: 'MC900001', LegalName: 'Zephyr Test Freight LLC', CarrierCustomerPacketStatuses: [{ CarrierPacketStatus: 'Invited' }] }), { status: 200 })
    return new Response('[]', { status: 200 })
  })
  const deps: McpFindDeps = {
    dynamo: dynamo as unknown as McpFindDeps['dynamo'],
    integrationTableName: 'Integration-test',
    carrierTableName: 'Carrier-test',
    shipmentMessageTableName: 'ShipmentMessage-test',
    writeAudit: async (entityType, entityId, action, _caller, changes) => { audits.push({ entityType, entityId, action, changes }) },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => '2026-11-04T10:00:00.000Z',
  }
  return { deps, sent, audits, calls, fetchImpl: fetchImpl as unknown as Mock }
}

beforeEach(() => {
  clearMcpTokenCache()
  gate.mockReset()
  invoke.mockReset()
})

describe('MCP_PREVIEW_CARRIER / MCP_GET_CARRIER', () => {
  it('LIVE: calls PreviewCarrier with the number asked about and answers a card; no credential in the reply or the audit', async () => {
    gate.mockResolvedValue(LIVE)
    const h = harness()
    const out = await mcpPreviewCarrier(h.deps, { mcNumber: '900001' }, CALLER)

    expect(out).toMatchObject({ mode: 'LIVE', reason: null, notFound: false, card: { source: 'LIVE', identity: { legalName: 'Zephyr Test Freight LLC', dotNumber: '7000001' }, approvedEmails: [{ email: 'dispatch@zephyr.example' }], fetched: { preview: true, data: false } } })
    const lookups = h.calls.filter((u) => !u.includes('/token'))
    expect(lookups).toHaveLength(1)
    expect(lookups[0]).toContain('/api/v1/Carrier/PreviewCarrier')
    expect(lookups[0]).toContain('docketNumber=MC900001')
    expect(JSON.stringify([out, h.audits])).not.toMatch(/fake-pass-123|fake-user|tok-1/)
    expect(h.audits).toEqual([{ entityType: 'INTEGRATION', entityId: 'MYCARRIERPACKETS', action: 'MCP_PREVIEW_CARRIER', changes: { mcNumber: 'MC900001', dotNumber: null, mode: 'LIVE', found: true } }])
  })

  it('LIVE: GetCarrierData is its own call and answers the packet stage', async () => {
    gate.mockResolvedValue(LIVE)
    const h = harness()
    const out = (await mcpGetCarrier(h.deps, { dotNumber: 'DOT 7000001' }, CALLER)) as { card: { packet: { status: string }; fetched: unknown } }
    expect(out.card.packet.status).toBe('INVITED')
    expect(out.card.fetched).toEqual({ preview: false, data: true })
    expect(h.calls.some((u) => u.includes('GetCarrierData') && u.includes('DOTNumber=7000001'))).toBe(true)
  })

  it('LIVE: an unknown carrier is notFound with no card', async () => {
    gate.mockResolvedValue(LIVE)
    const h = harness()
    h.fetchImpl.mockImplementation(async (url: string) =>
      url.includes('/token') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }) : new Response('[]', { status: 200 }))
    expect(await mcpPreviewCarrier(h.deps, { mcNumber: '1' }, CALLER)).toMatchObject({ mode: 'LIVE', card: null, notFound: true })
  })

  it('STUB: a labelled fixture comes back and MyCarrierPackets is never called', async () => {
    gate.mockResolvedValue(STUB)
    const h = harness()
    const out = (await mcpPreviewCarrier(h.deps, { mcNumber: 'MC274623' }, CALLER)) as { mode: string; reason: string; card: { source: string; identity: { mcNumber: string } } }
    expect(out).toMatchObject({ mode: 'STUB', reason: STUB.reason, card: { source: 'STUB', identity: { mcNumber: 'MC274623' } } })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a lookup with no MC or DOT before touching anything', async () => {
    const h = harness()
    await expect(mcpPreviewCarrier(h.deps, { mcNumber: '  ' }, CALLER)).rejects.toThrow(/MC or DOT/)
    expect(gate).not.toHaveBeenCalled()
  })
})

describe('MCP_SEND_INVITE', () => {
  it('LIVE: sends EmailPacketInvitation as the integration user, stamps the carrier row, notes the load thread, audits key names only', async () => {
    gate.mockResolvedValue(LIVE)
    const h = harness()
    const out = await mcpSendInvite(h.deps, { mcNumber: 'MC900001', dotNumber: '7000001', email: ' Dispatch@Zephyr.Example ', carrierId: 'car-1', carrierName: 'Zephyr Test Freight LLC', shipmentId: 'ship-1', loadId: 'load-1' }, CALLER)

    const invite = h.calls.find((u) => u.includes('EmailPacketInvitation'))!
    expect(invite).toContain('dotNumber=7000001')
    expect(invite).toContain('docketNumber=MC900001')
    expect(invite).toContain('carrierEmail=dispatch%40zephyr.example')
    expect(invite).toContain('username=fake-user')
    expect(out).toMatchObject({ mode: 'LIVE', sent: true, carrierLogged: true, threadLogged: true, mcpResponse: { status: 200, bodyKeys: ['Message', 'Success'], message: 'queued' } })

    const update = h.sent.find((s) => s.type === 'UpdateItemCommand')!
    expect(update.input).toMatchObject({ TableName: 'Carrier-test' })
    expect(JSON.stringify(update.input)).toContain('mcpInvitedAt')
    expect(JSON.stringify(update.input)).toContain('rep@bcat.example')
    const put = h.sent.find((s) => s.type === 'PutItemCommand')!
    expect(put.input).toMatchObject({ TableName: 'ShipmentMessage-test' })
    expect(JSON.stringify(put.input)).toContain('tracking+ship-1')
    expect(JSON.stringify(put.input)).toContain('dispatch@zephyr.example')

    expect(h.audits).toEqual([{ entityType: 'CARRIER', entityId: 'car-1', action: 'MCP_SEND_INVITE', changes: expect.objectContaining({ email: 'dispatch@zephyr.example', mode: 'LIVE', sent: true, mcpStatus: 200, mcpBodyKeys: ['Message', 'Success'], shipmentId: 'ship-1' }) }])
    expect(JSON.stringify([out, h.audits, h.sent])).not.toMatch(/fake-pass-123|tok-1/)
  })

  it('ensureCarrier: the invitation goes first, then mcp-sync makes the PENDING row from MCP and the invite is stamped on it', async () => {
    gate.mockResolvedValue(LIVE)
    invoke.mockResolvedValue({ ready: true, result: 'CREATED', carrierId: 'car-new' })
    const h = harness()
    const out = await mcpSendInvite(h.deps, { mcNumber: 'MC900001', dotNumber: '7000001', email: 'a@zephyr.example', shipmentId: 'ship-1', ensureCarrier: true }, CALLER)
    expect(out).toMatchObject({ sent: true, carrierId: 'car-new', carrierCreated: true, carrierError: null, carrierLogged: true })
    expect(invoke).toHaveBeenCalledWith({ kind: 'ADD_CARRIER', mcNumber: 'MC900001', dotNumber: '7000001' }, 'sync')
    expect(h.calls.findIndex((u) => u.includes('EmailPacketInvitation'))).toBeGreaterThan(-1)
    const stamp = h.sent.find((s) => s.type === 'UpdateItemCommand')!
    expect(JSON.stringify(stamp.input)).toContain('car-new')
    expect(h.audits.map((a) => a.action)).toEqual(['MCP_ADD_CARRIER', 'MCP_SEND_INVITE'])
  })

  it('ensureCarrier: a row that cannot be made is reported, never thrown, so a retry cannot invite twice', async () => {
    gate.mockResolvedValue(LIVE)
    invoke.mockResolvedValue({ ready: true, result: 'NO_MCP_RECORD' })
    const out = await mcpSendInvite(harness().deps, { mcNumber: 'MC900001', email: 'a@zephyr.example', ensureCarrier: true }, CALLER)
    expect(out).toMatchObject({ sent: true, carrierId: null, carrierLogged: false })
    expect(String(out.carrierError)).toMatch(/No carrier row/)
  })

  it('ensureCarrier in STUB mode creates nothing and calls nothing', async () => {
    gate.mockResolvedValue(STUB)
    const out = await mcpSendInvite(harness().deps, { mcNumber: 'MC900001', email: 'a@zephyr.example', ensureCarrier: true }, CALLER)
    expect(out).toMatchObject({ mode: 'STUB', sent: false })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('LIVE from a load but not in the directory: no carrier row to stamp, the audit lands on the integration, the thread is still noted', async () => {
    gate.mockResolvedValue(LIVE)
    const h = harness()
    const out = await mcpSendInvite(h.deps, { mcNumber: 'MC900001', email: 'a@zephyr.example', shipmentId: 'ship-1' }, CALLER)
    expect(out).toMatchObject({ sent: true, carrierLogged: false, threadLogged: true })
    expect(h.sent.map((s) => s.type)).toEqual(['PutItemCommand'])
    expect(h.audits[0]).toMatchObject({ entityType: 'INTEGRATION', entityId: 'MYCARRIERPACKETS' })
  })

  it('does not move a packet that has already started: a failed INVITED stamp falls back to the invitation stamp alone', async () => {
    gate.mockResolvedValue(LIVE)
    const h = harness({ failFirstCarrierUpdate: true })
    const out = await mcpSendInvite(h.deps, { mcNumber: 'MC900001', email: 'a@zephyr.example', carrierId: 'car-1' }, CALLER)
    expect(out).toMatchObject({ sent: true, carrierLogged: true })
    const updates = h.sent.filter((s) => s.type === 'UpdateItemCommand')
    expect(updates).toHaveLength(2)
    expect(String(updates[0]!.input.UpdateExpression)).toContain('mcpStatus')
    expect(String(updates[1]!.input.UpdateExpression)).not.toContain('mcpStatus')
  })

  it('STUB: nothing is sent, stamped or noted, and the reply says so', async () => {
    gate.mockResolvedValue(STUB)
    const h = harness()
    const out = (await mcpSendInvite(h.deps, { mcNumber: 'MC900001', email: 'a@zephyr.example', carrierId: 'car-1', shipmentId: 'ship-1' }, CALLER)) as { sent: boolean; mode: string; message: string }
    expect(out).toMatchObject({ mode: 'STUB', sent: false, carrierLogged: false, threadLogged: false })
    expect(out.message).toMatch(/^STUB/)
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.sent).toEqual([])
    expect(h.audits[0]).toMatchObject({ action: 'MCP_SEND_INVITE', changes: { mode: 'STUB', sent: false } })
  })

  it.each(['', 'nope', 'a@b', 'x@y.com, z@y.com'])('refuses the recipient %j before any call', async (email) => {
    const h = harness()
    await expect(mcpSendInvite(h.deps, { mcNumber: 'MC900001', email }, CALLER)).rejects.toThrow()
    expect(gate).not.toHaveBeenCalled()
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('MCP_ADD_CARRIER', () => {
  it('LIVE: asks mcp-sync to create the row, and audits who asked', async () => {
    gate.mockResolvedValue(LIVE)
    invoke.mockResolvedValue({ ready: true, result: 'CREATED', carrierId: 'car-new' })
    const h = harness()
    const out = await mcpAddCarrier(h.deps, { mcNumber: '900001', dotNumber: '7000001' }, CALLER)
    expect(invoke).toHaveBeenCalledWith({ kind: 'ADD_CARRIER', mcNumber: 'MC900001', dotNumber: '7000001' }, 'sync')
    expect(out).toEqual({ carrierId: 'car-new', created: true, matchedBy: null })
    expect(h.audits).toEqual([{ entityType: 'CARRIER', entityId: 'car-new', action: 'MCP_ADD_CARRIER', changes: { mcNumber: 'MC900001', dotNumber: '7000001', source: 'MYCARRIERPACKETS', result: 'CREATED', matchedBy: null } }])
  })

  it('a carrier that is already there is returned, not re-created', async () => {
    gate.mockResolvedValue(LIVE)
    invoke.mockResolvedValue({ ready: true, result: 'EXISTS', carrierId: 'car-1', matchedBy: 'DOT' })
    const out = await mcpAddCarrier(harness().deps, { dotNumber: '7000001' }, CALLER)
    expect(out).toEqual({ carrierId: 'car-1', created: false, matchedBy: 'DOT' })
  })

  it('STUB data is never added to the directory', async () => {
    gate.mockResolvedValue(STUB)
    const h = harness()
    await expect(mcpAddCarrier(h.deps, { mcNumber: 'MC900001' }, CALLER)).rejects.toThrow(/STUB data is never added/)
    expect(invoke).not.toHaveBeenCalled()
    expect(h.audits).toEqual([])
  })

  it.each([
    [{ ready: true, result: 'NO_MCP_RECORD' }, /no record/i],
    [{ ready: true, result: 'NO_NAME' }, /legal name/i],
    [{ ready: false, reason: 'MyCarrierPackets does not report LIVE.' }, /does not report LIVE/],
  ])('surfaces %j as an error and audits nothing', async (reply, message) => {
    gate.mockResolvedValue(LIVE)
    invoke.mockResolvedValue(reply)
    const h = harness()
    await expect(mcpAddCarrier(h.deps, { mcNumber: 'MC900001' }, CALLER)).rejects.toThrow(message)
    expect(h.audits).toEqual([])
  })
})
