import { describe, expect, it, vi } from 'vitest'
import { handleIntakeThreadStream, tableOf, type IntakeThreadDeps, type StreamRecord } from './intakeThread'

type Row = Record<string, unknown>

const RECEIVED = '2026-11-12T21:38:48.000Z'
const STAMP = Date.parse(RECEIVED) / 1000
const SUBJECT = 'Fwd: Landstar Load Tender 4828693'

function fakeDeps(over: Partial<IntakeThreadDeps> = {}, rows: { intake?: Row; shipment?: Row; load?: Row } = {}) {
  const intake: Row = rows.intake ?? { id: 'il:1', subject: SUBJECT, fromEmail: 'ruben@bcatcorp.com', receivedAt: RECEIVED, status: 'OPEN' }
  const posts: { channel: string; ts: string; text: string }[] = []
  const claimed = new Set<string>()
  const deps: IntakeThreadDeps = {
    getIntake: async (id) => (id === intake.id ? intake : null),
    getShipment: async (id) => (rows.shipment && rows.shipment.id === id ? rows.shipment : null),
    getLoad: async (id) => (rows.load && rows.load.id === id ? rows.load : null),
    saveThread: vi.fn(async (_id, channel, ts) => { intake.slackChannelId = channel; intake.slackThreadTs = ts }),
    copyThreadToShipment: vi.fn(async () => {}),
    claim: async (_id, key) => (claimed.has(key) ? false : (claimed.add(key), true)),
    release: vi.fn(async (_id, key) => { claimed.delete(key) }),
    audit: vi.fn(async () => {}),
    history: vi.fn(async (channel: string) => (channel === 'C_BCAT'
      ? [{ ts: '1794519549.86', files: [{ filetype: 'email', subject: SUBJECT, timestamp: STAMP, from: [{ address: 'ruben@bcatcorp.com' }] }] }]
      : [])),
    replies: vi.fn(async () => posts.map((p) => ({ text: p.text, user: 'UBOT' }))),
    post: vi.fn(async (channel, ts, text) => { posts.push({ channel, ts, text }) }),
    botUserId: async () => 'UBOT',
    channels: ['C_IVAN', 'C_BCAT'],
    portalOrigin: 'https://ops.bcatcorp.com',
    sleep: vi.fn(async () => {}),
    dryRun: false,
    log: () => {},
    ...over,
  }
  return { deps, posts, intake, claimed }
}

const rec = (table: string, oldImg: Row | null, newImg: Row | null): StreamRecord => ({
  eventName: oldImg ? 'MODIFY' : 'INSERT',
  eventSourceARN: `arn:aws:dynamodb:us-east-1:1:table/${table}-abc-NONE/stream/2026`,
  dynamodb: { ...(oldImg ? { OldImage: oldImg } : {}), ...(newImg ? { NewImage: newImg } : {}) },
})
const id = (r: Row) => r

describe('tableOf', () => {
  it('reads the model name off the stream ARN', () => {
    expect(tableOf('arn:aws:dynamodb:us-east-1:1:table/ShipmentDocument-5ucw-NONE/stream/x')).toBe('ShipmentDocument')
  })
})

describe('handleIntakeThreadStream', () => {
  it('finds the thread, stores it, posts "Shipment created" with the PRO and copies the thread to the shipment', async () => {
    const { deps, posts, intake } = fakeDeps({}, { shipment: { id: 's9', number: '20101' } })
    const out = await handleIntakeThreadStream(deps, [rec('IntakeLoad',
      { ...intake, status: 'PROMOTING' },
      { ...intake, status: 'MOVED', shipmentId: 's9', shipmentNumber: '20101', updatedBy: 'ruben@bcatcorp.com' })], id)
    expect(out.posted).toBe(1)
    expect(posts).toEqual([{ channel: 'C_BCAT', ts: '1794519549.86', text: ':white_check_mark: Shipment created: PRO *20101* by Ruben · <https://ops.bcatcorp.com/tms/shipments/s9|Open in BCAT Ops>' }])
    expect(deps.saveThread).toHaveBeenCalledWith('il:1', 'C_BCAT', '1794519549.86')
    expect(deps.copyThreadToShipment).toHaveBeenCalledWith('s9', 'il:1', 'C_BCAT', '1794519549.86')
  })

  it('never posts the same line twice (stream retry)', async () => {
    const { deps, posts, intake } = fakeDeps({}, { shipment: { id: 's9', number: '20101' } })
    const r = rec('IntakeLoad', { ...intake, status: 'PROMOTING' }, { ...intake, status: 'MOVED', shipmentId: 's9', shipmentNumber: '20101' })
    await handleIntakeThreadStream(deps, [r], id)
    await handleIntakeThreadStream(deps, [r], id)
    expect(posts).toHaveLength(1)
  })

  it('an intake with no Slack message posts nothing', async () => {
    const { deps, posts, intake } = fakeDeps({ history: async () => [] })
    const out = await handleIntakeThreadStream(deps, [rec('IntakeLoad', { ...intake }, { ...intake, status: 'MOVED', shipmentId: 's9' })], id)
    expect(out).toEqual({ posted: 0, skipped: 1, failed: 0 })
    expect(posts).toEqual([])
  })

  it('a duplicate notice waits for the Slack post to appear', async () => {
    let calls = 0
    const { deps, posts, intake } = fakeDeps({
      history: async (channel) => (++calls > 2 && channel === 'C_BCAT'
        ? [{ ts: '9.9', files: [{ filetype: 'email', subject: SUBJECT, timestamp: STAMP }] }]
        : []),
    })
    await handleIntakeThreadStream(deps, [rec('IntakeLoad', null, { ...intake, alreadyBuilt: [{ number: '20027', value: '4828693' }] })], id)
    expect(deps.sleep).toHaveBeenCalledWith(20_000)
    expect(posts[0]!.text).toMatch(/^:warning: Possible duplicate: this tender matches PRO 20027/)
  })

  it('shipment milestones find the intake through intakeLoadId; carrier line names the carrier, never the rate', async () => {
    const shipment = { id: 's9', number: '20101', intakeLoadId: 'il:1', loadIds: ['l1'] }
    const { deps, posts } = fakeDeps({}, { shipment, load: { id: 'l1', carrierName: 'Acme Freight', carrierRateCents: 90000 } })
    await handleIntakeThreadStream(deps, [rec('Shipment', { ...shipment, status: 'DISPATCHED' }, { ...shipment, status: 'PICKED_UP' })], id)
    expect(posts.map((p) => p.text)).toEqual([':truck: Carrier booked on PRO *20101*: Acme Freight', ':package: PRO *20101* picked up'])
    expect(posts.some((p) => /900|\$/.test(p.text))).toBe(false)
  })

  it('POD and invoice lines reach the thread through the shipment', async () => {
    const shipment = { id: 's9', number: '20101', intakeLoadId: 'il:1' }
    const { deps, posts } = fakeDeps({}, { shipment })
    await handleIntakeThreadStream(deps, [
      rec('ShipmentDocument', null, { id: 'd1', type: 'POD', status: 'ACTIVE', shipmentId: 's9' }),
      rec('Invoice', null, { id: '20101', number: '20101', shipmentId: 's9', status: 'ISSUED', totalCents: 175000 }),
    ], id)
    expect(posts.map((p) => p.text)).toEqual([':page_facing_up: POD received for PRO *20101*', ':receipt: PRO *20101* released to billing'])
  })

  it('a failed Slack post releases the claim, audits, and never throws', async () => {
    const { deps, claimed, intake } = fakeDeps({ post: async () => { throw new Error('Slack chat.postMessage: not_in_channel') } }, { shipment: { id: 's9', number: '1' } })
    const out = await handleIntakeThreadStream(deps, [rec('IntakeLoad', { ...intake, status: 'PROMOTING' }, { ...intake, status: 'MOVED', shipmentId: 's9' })], id)
    expect(out.failed).toBe(1)
    expect(claimed.size).toBe(0)
    expect(deps.audit).toHaveBeenCalledWith('il:1', 'INTAKE_SLACK_POST_FAILED', expect.objectContaining({ kind: 'created' }))
  })

  it('a dismissal of a twin row is not posted under a thread that already has "Shipment created"', async () => {
    const { deps, posts, intake } = fakeDeps({}, { shipment: { id: 's9', number: '20101' } })
    await handleIntakeThreadStream(deps, [rec('IntakeLoad', { ...intake, status: 'PROMOTING' }, { ...intake, status: 'MOVED', shipmentId: 's9' })], id)
    await handleIntakeThreadStream(deps, [rec('IntakeLoad', { ...intake, status: 'OPEN' }, { ...intake, status: 'DISMISSED', dismissedBy: 'ryne@bcatcorp.com', dismissedAt: 't', dismissReason: 'dup' })], id)
    expect(posts).toHaveLength(1)
  })

  it('dry run (dev) decides but never claims or posts', async () => {
    const { deps, posts, claimed, intake } = fakeDeps({ dryRun: true }, { shipment: { id: 's9', number: '1' } })
    await handleIntakeThreadStream(deps, [rec('IntakeLoad', { ...intake, status: 'PROMOTING' }, { ...intake, status: 'MOVED', shipmentId: 's9' })], id)
    expect(posts).toEqual([])
    expect(claimed.size).toBe(0)
  })

  it('a record that throws is counted, not rethrown', async () => {
    const { deps } = fakeDeps({ getShipment: async () => { throw new Error('boom') } })
    const out = await handleIntakeThreadStream(deps, [rec('ShipmentDocument', null, { type: 'POD', shipmentId: 's9' })], id)
    expect(out.failed).toBe(1)
  })
})
