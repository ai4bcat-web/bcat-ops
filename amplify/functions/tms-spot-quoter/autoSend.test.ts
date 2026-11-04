/**
 * Auto-send execution: the rep switch, the door, at-most-once, and what a failure leaves.
 * (The pure gate table is tested with `autoSendDecision` in src/lib/spot.)
 */
import { describe, expect, it } from 'vitest'
import { SPOT_FIXTURES } from '../../../src/lib/spot/fixtures'
import type { SpotAutoQuoteEvent, SpotAutoQuoteResult } from '../../../src/lib/spot/types'
import { resolveSpotSettings } from '../../../src/lib/spot/settings'
import { autoSendReply } from './autoSend'
import { pollAll } from './poll'
import { reconcileDrafts } from './reconcile'
import { connectedRow, makeRig, REP_ID, requestRaw, type TestRig } from './testkit'

const fx = SPOT_FIXTURES.find((f) => f.id === 'req-one-liner-known')!
const SENDER = (/<([^>]+)>/.exec(fx.meta.from)?.[1] ?? fx.meta.from).toLowerCase()
const requestId = `sr:${REP_ID}:${fx.meta.id}`

function doorOk(rig: TestRig) {
  return (e: SpotAutoQuoteEvent): SpotAutoQuoteResult => {
    rig.store.quotes.set('q-auto', {
      id: 'q-auto', side: 'SELL', status: 'QUOTED', spotRequestId: e.spotAutoQuote.requestId, amountCents: 175_000,
      quoteNumber: 'Q000900', linkToken: 'autotok', equipmentType: 'VAN',
    })
    return { ok: true, quoteId: 'q-auto', quoteNumber: 'Q000900', amountCents: 175_000, expiresAt: '2026-11-11T00:00:00Z', link: 'x', priceBasis: 'DAT_LIVE', stub: false }
  }
}

function armed(opts: { dev?: boolean; repSwitch?: boolean; customerOptIn?: boolean } = {}): TestRig {
  const rig = makeRig({ dev: opts.dev })
  rig.store.settings.value = { id: 'default', allowAutoSend: true }
  rig.store.connections.set(REP_ID, connectedRow({ historyId: null, settings: { autoSend: opts.repSwitch ?? true } as never }))
  rig.store.customers.set('cust-1', { id: 'cust-1', status: 'ACTIVE', defaultSalesRepId: REP_ID, accountOwnerIds: [REP_ID], quoteAutoReply: opts.customerOptIn ?? true })
  rig.crm.senders.set(SENDER, { how: 'EMAIL', customerId: 'cust-1', candidates: [] })
  rig.port.add(fx.meta, fx.body)
  rig.model.answer = () => requestRaw()
  rig.setDoor(doorOk(rig))
  return rig
}

describe('the rep switch', () => {
  it('with auto-send off the door is never invoked and nothing is decided', async () => {
    const rig = armed({ repSwitch: false })
    await pollAll(rig.deps)
    expect(rig.store.requests.get(requestId)!.status).toBe('NEW')
    expect(rig.store.requests.get(requestId)!.autoDecision).toBeUndefined()
    expect(rig.doorCalls).toHaveLength(0)
    expect(rig.port.sendCalls).toBe(0)
  })
})

describe('auto-send', () => {
  it('quotes through the door, sends once from the rep’s mailbox, and marks the request SENT by AUTO', async () => {
    const rig = armed()
    await pollAll(rig.deps)
    const row = rig.store.requests.get(requestId)!
    expect(rig.doorCalls).toHaveLength(1)
    expect(rig.doorCalls[0].spotAutoQuote).toMatchObject({ requestId, repId: REP_ID, customerId: 'cust-1', autoReplyAllowed: true })
    expect(rig.port.sentReplies).toHaveLength(1)
    expect(rig.port.sentReplies[0].text).toContain('https://ops.zz-bcat.test/quote/autotok')
    expect(rig.port.drafts.size).toBe(0)
    expect(row).toMatchObject({ status: 'SENT', sentVia: 'AUTO', quoteId: 'q-auto' })
    expect(row.autoDecision?.decision).toBe('SENT')
    expect(rig.store.connections.get(REP_ID)).toMatchObject({ autoSendCount: 1, autoSendDay: '2026-11-04' })
    expect(rig.store.audits.map((a) => a.action)).toContain('SPOT_AUTO_SENT')
  })

  it('records the door’s refusal reasons, creates nothing and sends nothing', async () => {
    const rig = armed()
    rig.setDoor(() => ({ ok: false, reasons: ['PRICE_STUB'] }))
    await pollAll(rig.deps)
    const row = rig.store.requests.get(requestId)!
    expect(row.status).toBe('NEW')
    expect(row.autoDecision).toMatchObject({ decision: 'SKIPPED', reasons: ['PRICE_STUB'] })
    expect(rig.port.sendCalls).toBe(0)
    expect(rig.port.drafts.size).toBe(0)
  })

  it('an unreachable door sends nothing and leaves the request for the rep', async () => {
    const rig = armed()
    rig.setDoor(() => new Error('lambda unavailable'))
    await pollAll(rig.deps)
    const row = rig.store.requests.get(requestId)!
    expect(row.status).toBe('NEW')
    expect(row.autoDecision?.decision).toBe('FAILED')
    expect(rig.port.sendCalls).toBe(0)
  })

  it('a send failure after the quote exists leaves a draft, never a retry', async () => {
    const rig = armed()
    rig.port.failSend = true
    await pollAll(rig.deps)
    const row = rig.store.requests.get(requestId)!
    expect(row.status).toBe('DRAFTED')
    expect(row.quoteId).toBe('q-auto')
    expect(row.autoDecision?.decision).toBe('FAILED')
    expect(rig.port.drafts.size).toBe(1)
    expect(rig.port.sentReplies).toHaveLength(0)
    await pollAll(rig.deps)
    expect(rig.doorCalls).toHaveLength(1)
  })

  it('skips with CUSTOMER_OPT_OUT before ever calling the door', async () => {
    const rig = armed({ customerOptIn: false })
    await pollAll(rig.deps)
    const row = rig.store.requests.get(requestId)!
    expect(row.autoDecision).toMatchObject({ decision: 'SKIPPED' })
    expect(row.autoDecision?.reasons).toContain('CUSTOMER_OPT_OUT')
    expect(rig.doorCalls).toHaveLength(0)
  })

  it('stops at the per-rep daily cap', async () => {
    const rig = armed()
    rig.store.connections.set(REP_ID, connectedRow({ historyId: null, settings: { autoSend: true } as never, autoSendDay: '2026-11-04', autoSendCount: 25 }))
    await pollAll(rig.deps)
    expect(rig.store.requests.get(requestId)!.autoDecision?.reasons).toContain('CAP_REP')
    expect(rig.doorCalls).toHaveLength(0)
  })

  it('on the dev stack decides but never quotes or sends', async () => {
    const rig = armed({ dev: true })
    await pollAll(rig.deps)
    const row = rig.store.requests.get(requestId)!
    expect(row.autoDecision).toMatchObject({ decision: 'DEV_SUPPRESSED', wouldSend: true })
    expect(rig.doorCalls).toHaveLength(0)
    expect(rig.port.sendCalls).toBe(0)
  })
})

describe('at-most-once', () => {
  it('a second claimant loses: an AUTO_PENDING request is not quoted or sent again', async () => {
    const rig = armed({ repSwitch: false })
    await pollAll(rig.deps)
    const row = rig.store.requests.get(requestId)!
    rig.store.requests.set(requestId, { ...row, status: 'AUTO_PENDING' })
    const conn = rig.store.connections.get(REP_ID)!
    await autoSendReply({ deps: rig.deps, conn, port: rig.port, settings: resolveSpotSettings(null), aiAgents: null }, rig.store.requests.get(requestId)!)
    expect(rig.doorCalls).toHaveLength(0)
    expect(rig.port.sendCalls).toBe(0)
  })

  it('a stale AUTO_PENDING is released by reconcile and is never re-sent', async () => {
    const rig = armed({ repSwitch: false })
    await pollAll(rig.deps)
    const row = rig.store.requests.get(requestId)!
    rig.store.requests.set(requestId, { ...row, status: 'AUTO_PENDING', updatedAt: '2026-11-04T17:00:00Z' })
    await reconcileDrafts(rig.deps, rig.store.connections.get(REP_ID)!, rig.port)
    const after = rig.store.requests.get(requestId)!
    expect(after.status).toBe('NEW')
    expect(after.autoDecision?.decision).toBe('FAILED')
    expect(rig.port.sendCalls).toBe(0)
    expect(rig.doorCalls).toHaveLength(0)
  })

  it('leaves a fresh AUTO_PENDING alone', async () => {
    const rig = armed({ repSwitch: false })
    await pollAll(rig.deps)
    const row = rig.store.requests.get(requestId)!
    rig.store.requests.set(requestId, { ...row, status: 'AUTO_PENDING', updatedAt: '2026-11-04T17:58:00Z' })
    await reconcileDrafts(rig.deps, rig.store.connections.get(REP_ID)!, rig.port)
    expect(rig.store.requests.get(requestId)!.status).toBe('AUTO_PENDING')
  })
})
