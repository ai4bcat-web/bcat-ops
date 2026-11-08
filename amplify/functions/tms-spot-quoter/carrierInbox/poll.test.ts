import { describe, expect, it, vi } from 'vitest'
import { FIXTURE_DISTRIBUTION_ADDRESS, CARRIER_INBOX_MAIL_FIXTURES } from '../../../../src/lib/carrierInbox/fixtures'
import type { GmailMessageMeta } from '../../../../src/lib/spot/port'
import type { AiAgentsSettings } from '../../../../src/types/tms'
import { chicagoDay } from '../../../../src/lib/spot/chicagoDay'
import { NeedsReconnect } from '../../_shared/gmail/errors'
import type { FakePort } from '../testkit'
import { pollCarrierInbox } from './poll'
import { MAX_HELD_RUNS } from '../poll'
import { makeCsRig, offerRaw } from './testkit'

const MAILBOX = { addresses: [FIXTURE_DISTRIBUTION_ADDRESS] }
const AT = String(Date.parse('2026-11-04T17:00:00Z'))

function meta(id: string, over: Partial<GmailMessageMeta> = {}): GmailMessageMeta {
  return {
    id, threadId: `t-${id}`, internalDate: AT, from: 'Dispatch <dispatch@carrier.example.invalid>',
    to: [FIXTURE_DISTRIBUTION_ADDRESS], cc: [], replyTo: null, subject: 'Load ZZAL1001 - truck available',
    messageId: `<${id}@carrier.example.invalid>`, inReplyTo: null, references: null, snippet: '', labelIds: ['INBOX'],
    headers: { 'authentication-results': 'mx; spf=pass smtp.mailfrom=carrier.example.invalid; dkim=pass header.d=carrier.example.invalid' },
    ...over,
  }
}

const OFFER_BODY = 'We can haul load ZZAL1001 for $1,850 all in. MC 9900001, ZZ Carrier.'

function addOffer(port: FakePort, id: string, over: Partial<GmailMessageMeta> = {}, body = OFFER_BODY): void {
  port.add(meta(id, over), body)
}

const run = (rig: ReturnType<typeof makeCsRig>) => pollCarrierInbox(rig.deps, { trigger: 'MANUAL', budgetMs: 60_000 })
const mailboxState = (rig: ReturnType<typeof makeCsRig>) => rig.store.state.value.mailboxes.m1

describe('carrier inbox funnel', () => {
  it('never fetches the body of a stage-1 reject, never calls the model for a stage-2 reject, and stores nothing for either', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX })
    const newsletter = CARRIER_INBOX_MAIL_FIXTURES.find((f) => f.id === 'zz-al-f08')!.message
    rig.port.add(meta('news', { from: newsletter.from, subject: newsletter.subject, headers: newsletter.headers }), newsletter.body)
    rig.port.add(meta('chat', { subject: 'Thanks' }), 'Thanks for the call yesterday, talk soon.')
    rig.port.add(meta('other', { to: ['someone-else@example.invalid'] }), OFFER_BODY)

    const result = await run(rig)

    expect(rig.port.bodyCalls).toEqual(['chat'])
    expect(rig.model.calls).toHaveLength(0)
    expect(rig.files.calls).toHaveLength(0)
    expect(result.stats).toMatchObject({ listed: 3, stage1Rejected: 1, wrongMailbox: 1, stage2Rejected: 1, modelCalls: 0 })
    // The cursor moved: a settled batch is not read twice.
    expect(mailboxState(rig).historyId).toBe('100')
  })

  it('hands an offer-bearing mail to the router with the normalized extraction and a stable dedupe key', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX })
    addOffer(rig.port, 'a1', {}, `${OFFER_BODY}\n\nOn Tue, Nov 3, Bob wrote:\n> old quoted text with $9,999`)

    const result = await run(rig)

    expect(rig.model.calls).toHaveLength(1)
    expect(rig.model.calls[0].body).not.toContain('old quoted text')
    expect(rig.files.calls).toHaveLength(1)
    const sent = rig.files.calls[0]
    expect(sent).toMatchObject({ source: 'EMAIL', mailboxId: 'm1', authOk: true, fromEmail: 'dispatch@carrier.example.invalid', messageId: '<a1@carrier.example.invalid>' })
    expect(sent.sourceKey).toMatch(/^[0-9a-f]{20}$/)
    expect(sent.extraction).toMatchObject({ kind: 'OFFER', rateCents: 185000, loadRefs: ['ZZAL1001'], carrier: { mc: '9900001' } })
    expect(result.stats).toMatchObject({ filed: 1, modelCalls: 1 })
    expect(rig.store.state.value.runs[0]).toMatchObject({ ok: true, stats: { filed: 1 } })
    expect(rig.store.state.value.modelCallsToday).toBe(1)
  })

  it('counts and drops NOT_RELEVANT without filing', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX })
    addOffer(rig.port, 'inv', { subject: 'Invoice for ZZAL1001' })
    rig.model.answer = () => offerRaw({ kind: 'NOT_RELEVANT' })
    const result = await run(rig)
    expect(result.stats).toMatchObject({ notOffer: 1, filed: 0 })
    expect(rig.files.calls).toHaveLength(0)
  })

  it('files in arrival order even when a later message classifies first', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX })
    addOffer(rig.port, 'first', { subject: 'Load ZZAL1001 first' })
    addOffer(rig.port, 'second', { subject: 'Load ZZAL1001 second' })
    addOffer(rig.port, 'third', { subject: 'Load ZZAL1001 third' })
    const classify = rig.model.classify.bind(rig.model)
    rig.model.classify = async (input) => {
      if (input.subject?.includes('first')) await new Promise((r) => setTimeout(r, 40))
      return classify(input)
    }
    await run(rig)
    expect(rig.files.calls.map((c) => c.subject)).toEqual(['Load ZZAL1001 first', 'Load ZZAL1001 second', 'Load ZZAL1001 third'])
  })

  it('re-polling the same mail files nothing twice', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX })
    addOffer(rig.port, 'a1')
    expect((await run(rig)).stats.filed).toBe(1)
    const again = await run(rig)
    expect(again.stats).toMatchObject({ filed: 0, duplicate: 1 })
  })
})

describe('carrier inbox cursor and kill switches', () => {
  it('holds the cursor on a model error for 3 runs, files nothing, then abandons and moves on', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX })
    addOffer(rig.port, 'a1')
    rig.model.answer = () => new Error('model down')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let held = 1; held <= MAX_HELD_RUNS; held += 1) {
      const r = await run(rig)
      expect(r.stats.errors).toBe(1)
      expect(mailboxState(rig)).toMatchObject({ held, historyId: '50', lastPollOk: false })
    }
    const last = await run(rig)
    expect(last.stats.abandoned).toBe(1)
    expect(mailboxState(rig)).toMatchObject({ held: 0, historyId: '100' })
    expect(rig.files.calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith('[carrier-inbox] one message failed:', expect.stringContaining('model down'))
    warn.mockRestore()
  })

  it('holds the cursor when the router hand-over fails, and replays idempotently', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX })
    addOffer(rig.port, 'a1')
    await run(rig)
    const key = rig.files.calls[0].sourceKey
    rig.files.calls.length = 0
    // Fresh rig state, router throttles the first attempt.
    const rig2 = makeCsRig({ mailbox: MAILBOX })
    addOffer(rig2.port, 'a1')
    rig2.files.failKeys.add(key)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failed = await run(rig2)
    expect(failed.stats.errors).toBe(1)
    expect(warn).toHaveBeenCalledWith('[carrier-inbox] hand-over failed:', expect.stringContaining('router throttled'))
    warn.mockRestore()
    expect(mailboxState(rig2).historyId).toBe('50')
    rig2.files.failKeys.clear()
    const retried = await run(rig2)
    expect(retried.stats.filed).toBe(1)
    expect(mailboxState(rig2).historyId).toBe('100')
  })

  it('flips the mailbox to NEEDS_RECONNECT on a revoked grant and leaves the cursor', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX })
    addOffer(rig.port, 'a1')
    rig.port.getMetadata = async () => { throw new NeedsReconnect() }
    await run(rig)
    expect(mailboxState(rig)).toMatchObject({ status: 'NEEDS_RECONNECT', historyId: '50' })
    // A mailbox that needs reconnecting is not polled again.
    const again = await run(rig)
    expect(again.polled).toBe(0)
  })

  it('reads nothing when the daily model-call cap is used, and says why', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX, cfg: { modelCallsPerDay: 5 } })
    rig.store.state.value.modelCallsDay = chicagoDay(rig.clock.now.toISOString())
    rig.store.state.value.modelCallsToday = 5
    addOffer(rig.port, 'a1')
    const result = await run(rig)
    expect(rig.port.sinceCalls).toBe(0)
    expect(rig.model.calls).toHaveLength(0)
    expect(result).toMatchObject({ polled: 0, reason: 'MODEL_CAP', done: false })
    expect(rig.store.state.value.runs[0].skipped).toBe('MODEL_CAP')
    expect(mailboxState(rig).historyId).toBe('50')
  })

  it('reads nothing when the CAPACITY agent is switched off', async () => {
    const aiAgents = { CAPACITY: { enabled: false } } as unknown as AiAgentsSettings
    const rig = makeCsRig({ mailbox: MAILBOX, aiAgents })
    addOffer(rig.port, 'a1')
    expect(await run(rig)).toMatchObject({ polled: 0, reason: 'MODEL_OFF' })
    expect(rig.port.sinceCalls).toBe(0)
  })

  it('does nothing, and leaves no digest, on the schedule while the feature is switched off', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX, cfg: { enabled: false } })
    addOffer(rig.port, 'a1')
    const result = await pollCarrierInbox(rig.deps, { trigger: 'SCHEDULE', budgetMs: 60_000 })
    expect(result.reason).toBe('DISABLED')
    expect(rig.store.state.value.runs).toHaveLength(0)
    expect(rig.port.sinceCalls).toBe(0)
  })

  it('does not poll a paused mailbox or a mailbox that is not connected', async () => {
    const paused = makeCsRig({ mailbox: { ...MAILBOX, paused: true } })
    addOffer(paused.port, 'a1')
    expect((await run(paused)).polled).toBe(0)
    const unconnected = makeCsRig({ mailbox: MAILBOX, connected: false })
    expect((await run(unconnected)).polled).toBe(0)
  })

  it('skips a mailbox another run holds', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX })
    rig.store.state.value.mailboxes.m1.runningAt = new Date(rig.clock.now.getTime() - 60_000).toISOString()
    addOffer(rig.port, 'a1')
    expect(await run(rig)).toMatchObject({ polled: 0, skipped: 1 })
    expect(rig.model.calls).toHaveLength(0)
  })

  it('a first poll reads the look-back window and records the cursor', async () => {
    const rig = makeCsRig({ mailbox: MAILBOX })
    rig.store.state.value.mailboxes.m1.historyId = null
    addOffer(rig.port, 'a1')
    await run(rig)
    expect(rig.port.recentCalls).toBe(1)
    expect(rig.port.sinceCalls).toBe(0)
    expect(mailboxState(rig).historyId).toBe('100')
  })
})
