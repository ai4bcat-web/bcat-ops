/**
 * Reconciling drafts with what the rep actually did in Gmail.
 */
import { describe, expect, it } from 'vitest'
import type { SpotRequestRecord } from '../../../src/types/tms'
import { reconcileDrafts } from './reconcile'
import { connectedRow, makeRig, REP_ID, type TestRig } from './testkit'

const id = `sr:${REP_ID}:zz-1`

async function draftedRig(): Promise<{ rig: TestRig; draftId: string }> {
  const rig = makeRig()
  rig.store.connections.set(REP_ID, connectedRow())
  const row: SpotRequestRecord = {
    id, userId: REP_ID, gmailMessageId: 'zz-1', gmailThreadId: 'thr-1', receivedAt: '2026-11-04T12:00:00Z',
    fromEmail: 'dana@zz-acme.test', subject: 'Rate request', status: 'DRAFTED', customerId: 'cust-1',
    contactEmail: 'dana@zz-acme.test', quoteId: 'q-1', thread: [], ttlEpoch: 4_000_000_000, version: 1,
    draftedAt: '2026-11-04T17:00:00Z',
  }
  const { draftId } = await rig.port.createDraft({ threadId: 'thr-1', to: 'dana@zz-acme.test', subject: 'Re: Rate request', inReplyTo: null, references: null, text: 'Our rate is $1,850' })
  rig.store.requests.set(id, { ...row, draftId })
  return { rig, draftId }
}

const run = (rig: TestRig) => reconcileDrafts(rig.deps, rig.store.connections.get(REP_ID)!, rig.port)

describe('reconcileDrafts', () => {
  it('leaves a draft alone while it still exists', async () => {
    const { rig } = await draftedRig()
    const out = await run(rig)
    expect(out).toEqual({ sent: 0, discarded: 0, released: 0 })
    expect(rig.store.requests.get(id)!.status).toBe('DRAFTED')
  })

  it('marks the request SENT by the rep when the draft left and a sent message follows in the thread', async () => {
    const { rig, draftId } = await draftedRig()
    rig.port.repSends(draftId, Date.parse('2026-11-04T17:30:00Z'))
    // repSends files the message under the draft's own thread
    const out = await run(rig)
    const row = rig.store.requests.get(id)!
    expect(out.sent).toBe(1)
    expect(row).toMatchObject({ status: 'SENT', sentVia: 'REP_GMAIL', sentAt: '2026-11-04T17:30:00.000Z' })
    expect(rig.crm.activities.map((a) => a.kind)).toEqual(['EMAIL_OUT'])
    expect(rig.store.audits.map((a) => a.action)).toContain('SPOT_SENT')
    expect(rig.port.sendCalls).toBe(0)
  })

  it('returns the request to NEW when the draft was deleted and nothing was sent', async () => {
    const { rig, draftId } = await draftedRig()
    rig.port.drafts.delete(draftId)
    const out = await run(rig)
    const row = rig.store.requests.get(id)!
    expect(out.discarded).toBe(1)
    expect(row.status).toBe('NEW')
    expect(row.draftId).toBeUndefined()
  })

  it('ignores a message the rep sent before the draft was made', async () => {
    const { rig, draftId } = await draftedRig()
    rig.port.repSends(draftId, Date.parse('2026-11-04T16:00:00Z'))
    await run(rig)
    expect(rig.store.requests.get(id)!.status).toBe('NEW')
  })

  it('does not double-count a reply the poller already attached', async () => {
    const { rig, draftId } = await draftedRig()
    rig.port.repSends(draftId, Date.parse('2026-11-04T17:30:00Z'))
    const sentId = [...rig.port.mails.values()].find((m) => m.meta.labelIds.includes('SENT'))!.meta.id
    const row = rig.store.requests.get(id)!
    rig.store.requests.set(id, { ...row, thread: [{ id: sentId, at: '2026-11-04T17:30:00.000Z', dir: 'OUT', snippet: 'x' }] })
    await run(rig)
    expect(rig.store.requests.get(id)!.status).toBe('SENT')
    expect(rig.crm.activities).toHaveLength(0)
  })
})
