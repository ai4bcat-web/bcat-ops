/**
 * The polling pipeline: what is stored, what is never stored, and what survives a retry.
 * Doubles come from testkit.ts; the mail corpus is the shared fixture set.
 */
import { describe, expect, it } from 'vitest'
import { SPOT_FIXTURES, type SpotFixture } from '../../../src/lib/spot/fixtures'
import { NeedsReconnect } from '../_shared/gmail/errors'
import { pollAll } from './poll'
import { connectedRow, emptyRaw, makeRig, REP_ID, requestRaw, type TestRig } from './testkit'

function seed(rig: TestRig, fixtures: SpotFixture[]): void {
  for (const fx of fixtures) {
    rig.port.add(fx.meta, fx.body)
    if (fx.knownContact) {
      const email = /<([^>]+)>/.exec(fx.meta.from)?.[1] ?? fx.meta.from
      rig.crm.senders.set(email.toLowerCase(), { how: 'EMAIL', customerId: 'cust-known', candidates: [] })
    }
  }
}

function labelBySubject(fixtures: SpotFixture[]) {
  return ({ subject }: { subject: string | null }) => {
    const fx = fixtures.find((f) => f.meta.subject === subject)
    return fx?.label === 'REQUEST' ? requestRaw() : emptyRaw()
  }
}

function rigWithRep(opts?: Parameters<typeof makeRig>[0]): TestRig {
  const rig = makeRig(opts)
  rig.store.connections.set(REP_ID, connectedRow({ historyId: null }))
  return rig
}

const fresh = SPOT_FIXTURES.filter((f) => !f.trackedThread)

describe('quote-request-only retention', () => {
  it('stores exactly the requests and leaves no trace of any other mail', async () => {
    const rig = rigWithRep()
    seed(rig, fresh)
    rig.model.answer = labelBySubject(fresh)
    const { stats } = await pollAll(rig.deps)

    const storedIds = [...rig.store.requests.keys()].sort()
    const expected = fresh.filter((f) => f.expectStage === 'STORE').map((f) => `sr:${REP_ID}:${f.meta.id}`).sort()
    expect(storedIds).toEqual(expected)

    const negatives = fresh.filter((f) => f.label === 'NOT_REQUEST')
    const requestWrites = rig.store.writes.filter((w) => w.table === 'request')
    for (const fx of negatives) {
      expect(requestWrites.some((w) => w.id.includes(fx.meta.id))).toBe(false)
    }
    // No negative's body or subject was persisted anywhere we write.
    const dump = JSON.stringify(rig.store.writes) + JSON.stringify(rig.crm.activities)
    for (const fx of negatives) expect(dump).not.toContain(fx.meta.subject)
    expect(rig.crm.activities.every((a) => a.kind === 'EMAIL_IN')).toBe(true)
    expect(rig.crm.activities).toHaveLength(expected.length)

    // Counters add up: every listed mail is accounted for exactly once.
    const s1 = fresh.filter((f) => f.expectStage === 1).length
    const s2 = fresh.filter((f) => f.expectStage === 2).length
    expect(stats.listed).toBe(fresh.length)
    expect(stats.stage1Rejected).toBe(s1)
    expect(stats.stage2Rejected).toBe(s2)
    expect(stats.stored).toBe(expected.length)
    expect(stats.modelCalls).toBe(fresh.length - s1 - s2)
    expect(stats.errors).toBe(0)
  })

  it('never fetches a body for a stage-1 reject and never calls the model for a stage-2 reject', async () => {
    const rig = rigWithRep()
    const stage1 = fresh.filter((f) => f.expectStage === 1)
    const stage2 = fresh.filter((f) => f.expectStage === 2)
    seed(rig, [...stage1, ...stage2])
    await pollAll(rig.deps)
    for (const fx of stage1) expect(rig.port.bodyCalls).not.toContain(fx.meta.id)
    for (const fx of stage2) expect(rig.port.bodyCalls).toContain(fx.meta.id)
    expect(rig.model.classifyCalls).toHaveLength(0)
    expect(rig.store.requests.size).toBe(0)
  })

  it('stores the request row with the retention TTL and the exact-sender match', async () => {
    const rig = rigWithRep()
    const fx = fresh.find((f) => f.meta.id === 'zz-req-one-liner-known')!
    seed(rig, [fx])
    rig.model.answer = () => requestRaw()
    await pollAll(rig.deps)
    const row = rig.store.requests.get(`sr:${REP_ID}:${fx.meta.id}`)!
    expect(row.ttlEpoch).toBe(Math.floor(Number(fx.meta.internalDate) / 1000) + 90 * 86_400)
    expect(row.matchHow).toBe('EMAIL')
    expect(row.customerId).toBe('cust-known')
    expect(row.status).toBe('NEW')
  })
})

describe('idempotency and retries', () => {
  it('a re-poll and an overlapping run store one row and call the model once per mail', async () => {
    const rig = rigWithRep()
    const fx = fresh.find((f) => f.meta.id === 'zz-req-van-clear')!
    seed(rig, [fx])
    await pollAll(rig.deps)
    await pollAll(rig.deps)
    expect(rig.store.requests.size).toBe(1)
    expect(rig.crm.activities).toHaveLength(1)
    expect(rig.model.classifyCalls).toHaveLength(1)
  })

  it('a poll that starts while another holds the connection does nothing', async () => {
    const rig = rigWithRep()
    seed(rig, [fresh[0]])
    rig.store.connections.set(REP_ID, connectedRow({ historyId: null, lastPollStartedAt: rig.clock.now.toISOString() }))
    const result = await pollAll(rig.deps)
    expect(result.polled).toBe(0)
    expect(result.skipped).toBe(1)
    expect(rig.model.classifyCalls).toHaveLength(0)
  })

  it('a model error leaves the mail unstored, holds the cursor and is retried next run', async () => {
    const rig = rigWithRep()
    rig.store.connections.set(REP_ID, connectedRow({ historyId: '50' }))
    const fx = fresh.find((f) => f.meta.id === 'zz-req-van-clear')!
    seed(rig, [fx])
    rig.port.history = '77'
    rig.model.answer = () => new Error('anthropic down')
    const first = await pollAll(rig.deps)
    expect(first.stats.errors).toBe(1)
    expect(rig.store.requests.size).toBe(0)
    expect(rig.store.connections.get(REP_ID)!.historyId).toBe('50')

    rig.model.answer = () => requestRaw()
    await pollAll(rig.deps)
    expect(rig.store.requests.size).toBe(1)
    expect(rig.store.connections.get(REP_ID)!.historyId).toBe('77')
  })

  it('gives up holding the cursor after three failing runs so one bad mail cannot wedge the inbox', async () => {
    const rig = rigWithRep()
    rig.store.connections.set(REP_ID, connectedRow({ historyId: '50' }))
    seed(rig, [fresh.find((f) => f.meta.id === 'zz-req-van-clear')!])
    rig.port.history = '77'
    rig.model.answer = () => new Error('anthropic down')
    for (let i = 0; i < 4; i++) {
      rig.clock.now = new Date(rig.clock.now.getTime() + 10 * 60_000)
      await pollAll(rig.deps)
    }
    expect(rig.store.connections.get(REP_ID)!.historyId).toBe('77')
    expect(rig.store.requests.size).toBe(0)
  })

  it('falls back to a recent listing when Gmail has expired the history cursor', async () => {
    const rig = rigWithRep()
    rig.store.connections.set(REP_ID, connectedRow({ historyId: '1', lastPollAt: '2026-11-03T18:00:00Z' }))
    seed(rig, [fresh.find((f) => f.meta.id === 'zz-req-van-clear')!])
    rig.port.expired = true
    await pollAll(rig.deps)
    expect(rig.port.recentCalls).toBe(1)
    expect(rig.store.requests.size).toBe(1)
  })

  it('a revoked grant flips the connection to NEEDS_RECONNECT and is not polled again', async () => {
    const rig = rigWithRep()
    rig.port.listRecent = async () => {
      throw new NeedsReconnect('revoked')
    }
    await pollAll(rig.deps)
    expect(rig.store.connections.get(REP_ID)!.status).toBe('NEEDS_RECONNECT')
    const again = await pollAll(rig.deps)
    expect(again.polled).toBe(0)
  })

  it('a message that fails to fetch does not stop the rest of the batch', async () => {
    const rig = rigWithRep()
    const [a, b] = fresh.filter((f) => f.expectStage === 'STORE').slice(0, 2)
    seed(rig, [a, b])
    rig.port.failBody.add(a.meta.id)
    const { stats } = await pollAll(rig.deps)
    expect(stats.errors).toBe(1)
    expect(rig.store.requests.has(`sr:${REP_ID}:${b.meta.id}`)).toBe(true)
  })
})

describe('model kill switches', () => {
  it('stops calling the model once the per-rep daily cap is reached and defers the rest', async () => {
    const rig = rigWithRep()
    rig.store.settings.value = { id: 'default', modelCallsPerRepPerDay: 1 }
    const requests = fresh.filter((f) => f.expectStage === 'STORE').slice(0, 3)
    seed(rig, requests)
    await pollAll(rig.deps)
    expect(rig.model.classifyCalls).toHaveLength(1)
    expect(rig.store.requests.size).toBe(1)
    expect(rig.store.connections.get(REP_ID)!.modelCallsToday).toBe(1)
  })

  it('makes no model call when the QUOTE agent is switched off', async () => {
    const rig = rigWithRep({ aiAgents: { QUOTE: { enabled: false } } as never })
    seed(rig, fresh.filter((f) => f.expectStage === 'STORE').slice(0, 2))
    await pollAll(rig.deps)
    expect(rig.model.classifyCalls).toHaveLength(0)
    expect(rig.store.requests.size).toBe(0)
  })

  it('does nothing at all when the org has switched the spot quoter off', async () => {
    const rig = rigWithRep()
    rig.store.settings.value = { id: 'default', enabled: false }
    seed(rig, fresh.slice(0, 3))
    const result = await pollAll(rig.deps)
    expect(result.reason).toBe('DISABLED')
    expect(rig.port.bodyCalls).toHaveLength(0)
  })

  it('does not poll a paused connection', async () => {
    const rig = rigWithRep()
    rig.store.connections.set(REP_ID, connectedRow({ status: 'PAUSED' }))
    seed(rig, fresh.slice(0, 3))
    const result = await pollAll(rig.deps)
    expect(result.polled).toBe(0)
    expect(rig.port.inbox.length).toBeGreaterThan(0)
    expect(rig.port.recentCalls + rig.port.sinceCalls).toBe(0)
  })
})

describe('threads', () => {
  function tracked(rig: TestRig, fx: SpotFixture): string {
    const id = `sr:${REP_ID}:zz-original`
    rig.store.requests.set(id, {
      id, userId: REP_ID, gmailMessageId: 'zz-original', gmailThreadId: fx.meta.threadId,
      receivedAt: '2026-11-03T12:00:00Z', status: 'DRAFTED', subject: 'Rate request', fromEmail: 'dana@zz-acme.test',
      thread: [], ttlEpoch: 4_000_000_000, version: 1,
    })
    return id
  }

  it('attaches a customer reply to the tracked request without creating a new one', async () => {
    const rig = rigWithRep()
    const fx = SPOT_FIXTURES.find((f) => f.id === 'fu-accept')!
    const id = tracked(rig, fx)
    seed(rig, [fx])
    rig.model.intent = () => 'ACCEPT'
    const { stats } = await pollAll(rig.deps)
    const row = rig.store.requests.get(id)!
    expect(rig.store.requests.size).toBe(1)
    expect(stats.attached).toBe(1)
    expect(row.replyIntent).toBe('ACCEPT')
    expect(row.needsAttention).toBe(true)
    expect(row.customerReplyAt).toBeTruthy()
    expect(row.thread).toHaveLength(1)
    // Nothing converts or sends because a customer said yes.
    expect(row.status).toBe('DRAFTED')
    expect(rig.port.sendCalls).toBe(0)
    expect(rig.model.classifyCalls).toHaveLength(0)
  })

  it('does not attach the same message twice', async () => {
    const rig = rigWithRep()
    const fx = SPOT_FIXTURES.find((f) => f.id === 'fu-accept')!
    const id = tracked(rig, fx)
    seed(rig, [fx])
    await pollAll(rig.deps)
    await pollAll(rig.deps)
    expect(rig.store.requests.get(id)!.thread).toHaveLength(1)
    expect(rig.crm.activities).toHaveLength(1)
  })

  it('keeps the reply attached even when the intent call fails', async () => {
    const rig = rigWithRep()
    const fx = SPOT_FIXTURES.find((f) => f.id === 'fu-question')!
    const id = tracked(rig, fx)
    seed(rig, [fx])
    rig.model.intent = () => new Error('down')
    await pollAll(rig.deps)
    const row = rig.store.requests.get(id)!
    expect(row.thread).toHaveLength(1)
    expect(row.replyIntent).toBeUndefined()
  })
})

describe('simulated and Google connections share one code path', () => {
  it('produces identical rows for mode SIMULATED and GOOGLE', async () => {
    const results: unknown[] = []
    for (const mode of ['GOOGLE', 'SIMULATED'] as const) {
      const rig = makeRig()
      rig.store.connections.set(REP_ID, connectedRow({ mode, historyId: null }))
      const fx = fresh.find((f) => f.meta.id === 'zz-req-van-clear')!
      seed(rig, [fx])
      await pollAll(rig.deps)
      const row = { ...rig.store.requests.get(`sr:${REP_ID}:${fx.meta.id}`)! }
      expect(row.mode).toBe(mode)
      delete row.mode
      delete row.updatedAt
      results.push(row)
    }
    expect(results[0]).toEqual(results[1])
  })
})

describe('slow or failing model', () => {
  it('a model call that never answers times out: nothing is stored, the poll still completes and retries later', async () => {
    const rig = rigWithRep()
    rig.deps.modelTimeoutMs = 20
    rig.model.classify = () => new Promise(() => {})
    seed(rig, fresh.filter((f) => f.expectStage === 'STORE').slice(0, 2))
    const { stats } = await pollAll(rig.deps)
    expect(stats.errors).toBe(2)
    expect(rig.store.requests.size).toBe(0)
    const conn = rig.store.connections.get(REP_ID)!
    expect(conn.lastPollOk).toBe(false)
    expect(conn.lastError).toMatch(/could not be classified/)
    expect(conn.lastError).not.toContain('Rate request')
    expect(conn.historyId ?? null).toBeNull()
  })

  it('a poll that runs out of time returns partial progress and a later poll finishes the rest', async () => {
    const rig = rigWithRep()
    seed(rig, fresh.filter((f) => f.expectStage === 'STORE'))
    // Each call to the model advances the clock past the (tiny) budget.
    const inner = rig.model.classify.bind(rig.model)
    rig.model.classify = async (input) => {
      rig.clock.now = new Date(rig.clock.now.getTime() + 600)
      return inner(input)
    }
    const first = await pollAll(rig.deps, {}, 1000, 0)
    const partial = rig.store.requests.size
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(fresh.filter((f) => f.expectStage === 'STORE').length)
    expect(first.stats.deferred).toBe(1)
    for (let i = 0; i < 40 && rig.store.requests.size < fresh.filter((f) => f.expectStage === 'STORE').length; i++) {
      await pollAll(rig.deps, {}, 1000, 0)
    }
    expect(rig.store.requests.size).toBe(fresh.filter((f) => f.expectStage === 'STORE').length)
  })

  it('classifies several messages at once without exceeding the concurrency cap', async () => {
    const rig = rigWithRep()
    seed(rig, fresh.filter((f) => f.expectStage === 'STORE'))
    let live = 0
    let peak = 0
    const inner = rig.model.classify.bind(rig.model)
    rig.model.classify = async (input) => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live -= 1
      return inner(input)
    }
    await pollAll(rig.deps)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(6)
  })
})
