/**
 * Step AL router half: filing inbound carrier offers, assigning and dismissing the Unmatched bucket.
 * In-memory deps; the engine honours the conditions the module relies on (create-once, still-unmatched).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

import type { Row } from '../_shared/shipmentStore'
import type { Caller } from '../_shared/actionInputs'
import type { InboundExtraction, FileInboundOfferInput } from '../../../src/lib/carrierInbox/types'
import { UNMATCHED_SHIPMENT_ID } from '../../../src/lib/carrierInbox/types'
import { fileInboundOffer, assignInboundOffer, dismissInboundOffer, type CarrierInboundDeps } from './carrierInbound'

const NOW = '2026-11-04T12:00:00.000Z'
const SYSTEM: Caller = { email: 'system@bcatcorp.com', sub: 'carrier-inbox', groups: [], isAdmin: false }
const REP: Caller = { email: 'rep@bcatcorp.com', sub: 'u-rep', groups: ['page-loads'], isAdmin: false }

const T = {
  quote: 'Quote-t', carrier: 'Carrier-t', carrierDocument: 'CarrierDocument-t', shipment: 'Shipment-t', load: 'Load-t',
  posting: 'Posting-t', settings: 'Settings-t', message: 'Message-t', proClaim: 'ProClaim-t',
}

type TestDeps = CarrierInboundDeps & { audits: Row[] }

function makeDeps(store: Map<string, Row>): TestDeps {
  const audits: Row[] = []
  const rows = (table: string): Row[] => [...store.entries()].filter(([k]) => k.startsWith(`${table}#`)).map(([, v]) => v)
  const apply = (item: TransactWriteItem): void => {
    if (item.Put) {
      const row = unmarshall(item.Put.Item as never) as Row
      // DynamoDB refuses NULL on an index key, in production only.
      for (const k of ['shipmentId', 'threadKey', 'messageId']) {
        if (item.Put.TableName === T.message && k in row && row[k] === null) throw new Error(`ValidationError: Type mismatch for Index Key ${k}`)
      }
      const key = `${item.Put.TableName}#${String(row.id)}`
      if (item.Put.ConditionExpression?.includes('attribute_not_exists(id)') && store.has(key)) {
        throw new Error('TransactionCanceledException: ConditionalCheckFailed')
      }
      store.set(key, row)
    } else if (item.Update) {
      const id = String((unmarshall(item.Update.Key as never) as Row).id)
      const key = `${item.Update.TableName}#${id}`
      const existing = store.get(key)
      const names = item.Update.ExpressionAttributeNames ?? {}
      const values = unmarshall((item.Update.ExpressionAttributeValues ?? {}) as never) as Row
      const cond = item.Update.ConditionExpression ?? ''
      if (cond.includes('attribute_exists(id)') && !existing) throw new Error('ConditionalCheckFailed')
      if (cond.includes(':condUnmatched') && existing?.shipmentId !== values[':condUnmatched']) throw new Error('ConditionalCheckFailed')
      const next: Row = { ...(existing ?? {}) }
      const expr = item.Update.UpdateExpression ?? ''
      const set = /SET (.+?)(?: REMOVE |$)/.exec(expr)
      if (set) {
        for (const part of set[1]!.split(', ')) {
          const m = /^(#\w+) = (:\w+)$/.exec(part.trim())
          if (m) next[names[m[1]!]!] = values[m[2]!]
        }
      }
      const rem = /REMOVE (.+)$/.exec(expr)
      if (rem) for (const tok of rem[1]!.split(', ')) delete next[names[tok.trim()]!]
      store.set(key, next)
    } else if (item.Delete) {
      const id = String((unmarshall(item.Delete.Key as never) as Row).id)
      const key = `${item.Delete.TableName}#${id}`
      const values = unmarshall((item.Delete.ExpressionAttributeValues ?? {}) as never) as Row
      if (item.Delete.ConditionExpression && store.get(key)?.shipmentId !== values[':u']) throw new Error('ConditionalCheckFailed')
      store.delete(key)
    }
  }
  return {
    tables: T,
    audits,
    getById: async (t, id) => store.get(`${t}#${id}`) ?? null,
    queryIndex: async (t, _i, keyName, keyValue) => rows(t).filter((r) => r[keyName] === keyValue),
    transact: async (items) => { for (const i of items) apply(i) },
    getSettings: async () => ({}),
    writeAudit: async (entityType, entityId, action, _caller, detail) => { audits.push({ entityType, entityId, action, detail }) },
    carrierStanding: (c) => ({ known: c != null, bookable: false, blockers: [], warnings: [], status: '', mcpStatus: null }),
    setupPacketAdapter: async () => { throw new Error('unused') },
    nextQuoteNumber: async () => `Q${String(rows(T.quote).length + 1).padStart(6, '0')}`,
    now: () => NOW,
  }
}

function seedLoadFor(store: Map<string, Row>, n: number, pro: string, extra: Row = {}): { shipmentId: string; loadId: string } {
  const shipmentId = `ship-${n}`
  const loadId = `load-${n}`
  store.set(`${T.shipment}#${shipmentId}`, { id: shipmentId, status: 'OPEN', proNumber: pro, updatedAt: NOW, version: 1 })
  store.set(`${T.load}#${loadId}`, {
    id: loadId, shipmentId, loadNumber: `${pro}-1`, equipmentType: "53' VAN", pickupAppt: '2026-11-06T09:00:00.000Z',
    stops: [
      { type: 'pickup', sequence: 0, city: 'Chicago', state: 'IL', appt: '2026-11-06T09:00:00.000Z' },
      { type: 'delivery', sequence: 1, city: 'Dallas', state: 'TX', appt: '2026-11-07T09:00:00.000Z' },
    ],
    updatedAt: NOW, version: 1, ...extra,
  })
  store.set(`${T.proClaim}#${pro}`, { id: pro, loadId, shipmentId })
  return { shipmentId, loadId }
}

function extraction(over: Partial<InboundExtraction> = {}): InboundExtraction {
  return {
    kind: 'OFFER', confidence: 'high', reason: 'bid', loadRefs: [], postingRef: null, origin: null, destination: null,
    pickupDate: null, equipment: null, rateCents: 185_000, ratePerMileCents: null, availableAt: null, trucks: null,
    carrier: { name: 'Swift Transportation', mc: '123456', dot: null, contactName: 'Dana', email: 'dana@swift.test', phone: null },
    notes: null, lowConfidence: [], flags: [], ...over,
  }
}

function mail(key: string, over: Partial<FileInboundOfferInput> = {}): Row {
  return {
    source: 'EMAIL', sourceKey: key, mailboxId: 'm1', boardProvider: null, receivedAt: NOW,
    fromEmail: 'dana@swift.test', fromName: 'Dana', to: ['loads@bcat.test'], cc: [], subject: 'Re: load S5001 rate',
    body: 'I can haul it for $1850', messageId: `<${key}@swift.test>`, inReplyTo: null, attachments: [], authOk: true,
    extraction: extraction({ loadRefs: ['S5001'] }), ...over,
  }
}

const quotes = (store: Map<string, Row>): Row[] => [...store.entries()].filter(([k]) => k.startsWith(`${T.quote}#`)).map(([, v]) => v)
const messages = (store: Map<string, Row>): Row[] => [...store.entries()].filter(([k]) => k.startsWith(`${T.message}#`)).map(([, v]) => v)

describe('fileInboundOffer', () => {
  let store: Map<string, Row>
  let deps: TestDeps
  beforeEach(() => {
    store = new Map()
    deps = makeDeps(store)
  })

  it('auto-files an exact load reference as a BUY quote with provenance, posting count and open flag', async () => {
    const { shipmentId } = seedLoadFor(store, 1, 'S5001')
    store.set(`${T.posting}#post:ship-1:DAT`, { id: 'post:ship-1:DAT', shipmentId, status: 'POSTED', offerCount: 0, updatedAt: NOW, version: 1 })
    const res = await fileInboundOffer(deps, mail('a'.repeat(20)), SYSTEM)
    expect(res).toMatchObject({ outcome: 'FILED', shipmentId, how: 'LOAD_REF_SUBJECT' })
    const [q] = quotes(store)
    expect(q).toMatchObject({
      side: 'BUY', offerSource: 'EMAIL', shipmentId, amountCents: 185_000, carrierName: 'Swift Transportation',
      offerMessageRef: `msg:cs:${'a'.repeat(20)}`, offerPostingId: 'post:ship-1:DAT', createdBy: SYSTEM.email,
    })
    expect(store.get(`${T.shipment}#${shipmentId}`)).toMatchObject({ carrierOfferOpen: 'OPEN' })
    expect(store.get(`${T.posting}#post:ship-1:DAT`)).toMatchObject({ offerCount: 1 })
    const msg = messages(store)[0]!
    expect(msg).toMatchObject({ shipmentId, threadKey: `tracking+${shipmentId}`, kind: 'CARRIER_OFFER', channel: 'EMAIL', status: 'RECEIVED' })
    expect(msg.ttlEpoch).toBeUndefined()
    expect((msg.offer as Row).quoteId).toBe(q!.id)
  })

  it('files a call as a PHONE offer on a VOICE message', async () => {
    seedLoadFor(store, 1, 'S5001')
    const res = await fileInboundOffer(
      deps,
      mail('b'.repeat(20), {
        source: 'CALL', fromEmail: null, fromName: '+13125550123', to: [], subject: 'Call · Swift', messageId: null,
        call: { callSid: 'CA1', durationSec: 60, outcome: 'TRANSFERRED', recordingUrl: null },
      }),
      SYSTEM,
    )
    expect(res.outcome).toBe('FILED')
    expect(quotes(store)[0]).toMatchObject({ offerSource: 'PHONE' })
    expect(messages(store)[0]).toMatchObject({ channel: 'VOICE', from: '+13125550123', providerRef: 'call:CA1' })
  })

  it('a call with no Message-ID files without a NULL index key', async () => {
    seedLoadFor(store, 1, 'S5001')
    const call = { callSid: 'CA2', durationSec: null, outcome: null, recordingUrl: null }
    for (const [n, over] of [['u', { messageId: null }], ['v', { messageId: null, subject: null, fromEmail: null, fromName: null }]] as const) {
      const res = await fileInboundOffer(deps, mail(n.repeat(20), { source: 'CALL', to: [], call, ...over }), SYSTEM)
      expect(res.outcome).toBe('FILED')
    }
  })

  it('lane + date alone suggests the posted load even when the posting stores "City, ST" as the city', async () => {
    const { shipmentId } = seedLoadFor(store, 1, 'S5001')
    store.set(`${T.posting}#post:ship-1:DAT`, {
      id: 'post:ship-1:DAT', shipmentId, status: 'POSTED', originCity: 'Chicago, IL', originState: 'IL',
      destinationCity: 'Dallas, TX', destinationState: 'TX', pickupAppt: '2026-11-06T09:00:00.000Z', rateCents: 180_000, updatedAt: NOW, version: 1,
    })
    const x = extraction({ loadRefs: [], origin: { city: 'Chicago', state: 'IL' }, destination: { city: 'Dallas', state: 'TX' }, pickupDate: '2026-11-06' })
    const res = await fileInboundOffer(deps, mail('w'.repeat(20), { subject: 'truck available', extraction: x }), SYSTEM)
    expect(res.outcome).toBe('SUGGESTED')
    expect(quotes(store)).toHaveLength(0)
    expect(((messages(store)[0]!.offer as Row).match as Row).top).toMatchObject({ shipmentId, how: 'LANE_DATE' })
  })

  it('an unknown reference lands in the Unmatched bucket with a TTL and no quote', async () => {
    seedLoadFor(store, 1, 'S5001')
    const res = await fileInboundOffer(deps, mail('c'.repeat(20), { subject: 'load ZZ9999', extraction: extraction({ loadRefs: ['ZZ9999'] }) }), SYSTEM)
    expect(res).toMatchObject({ outcome: 'UNMATCHED', shipmentId: null, quoteId: null })
    const msg = messages(store)[0]!
    expect(msg).toMatchObject({ shipmentId: UNMATCHED_SHIPMENT_ID, threadKey: 'offers+unmatched' })
    // AppSync reads createdAt/updatedAt as non-null: a row without them fails every thread / bucket list.
    expect(msg).toMatchObject({ createdAt: NOW, updatedAt: NOW })
    expect(msg.ttlEpoch).toBe(Math.floor(Date.parse(NOW) / 1000) + 30 * 86_400)
    expect(quotes(store)).toHaveLength(0)
  })

  it('a voided shipment is never matched', async () => {
    seedLoadFor(store, 1, 'S5001')
    store.set(`${T.shipment}#ship-1`, { ...store.get(`${T.shipment}#ship-1`)!, voidedAt: NOW })
    const res = await fileInboundOffer(deps, mail('d'.repeat(20)), SYSTEM)
    expect(res.outcome).toBe('UNMATCHED')
    expect(quotes(store)).toHaveLength(0)
  })

  it('a covered load keeps the message on its thread as COVERED_LATE and files no quote', async () => {
    const { shipmentId } = seedLoadFor(store, 1, 'S5001', { activeLoadCarrierId: 'lc-1' })
    const res = await fileInboundOffer(deps, mail('e'.repeat(20)), SYSTEM)
    expect(res).toMatchObject({ outcome: 'COVERED_LATE', shipmentId })
    expect(quotes(store)).toHaveLength(0)
    expect((messages(store)[0]!.offer as Row).match).toMatchObject({ state: 'COVERED_LATE' })
  })

  it('an INTEREST on a matched load is thread-only', async () => {
    const { shipmentId } = seedLoadFor(store, 1, 'S5001')
    const res = await fileInboundOffer(deps, mail('f'.repeat(20), { extraction: extraction({ kind: 'INTEREST', rateCents: null, loadRefs: ['S5001'] }) }), SYSTEM)
    expect(res).toMatchObject({ outcome: 'THREAD_ONLY', shipmentId })
    expect(quotes(store)).toHaveLength(0)
  })

  it('medium confidence never auto-files', async () => {
    seedLoadFor(store, 1, 'S5001')
    const res = await fileInboundOffer(deps, mail('g'.repeat(20), { extraction: extraction({ confidence: 'medium', loadRefs: ['S5001'] }) }), SYSTEM)
    expect(res.outcome).toBe('SUGGESTED')
    expect(quotes(store)).toHaveLength(0)
    expect(messages(store)[0]!.shipmentId).toBe(UNMATCHED_SHIPMENT_ID)
    expect(((messages(store)[0]!.offer as Row).match as Row).candidates).toHaveLength(1)
  })

  it('the same source key twice is one row and one quote', async () => {
    seedLoadFor(store, 1, 'S5001')
    const first = await fileInboundOffer(deps, mail('h'.repeat(20)), SYSTEM)
    const second = await fileInboundOffer(deps, mail('h'.repeat(20)), SYSTEM)
    expect(second).toMatchObject({ outcome: 'DUPLICATE', quoteId: first.quoteId })
    expect(messages(store)).toHaveLength(1)
    expect(quotes(store)).toHaveLength(1)
  })

  it('a replay after a crash between the message put and the quote files exactly one quote', async () => {
    seedLoadFor(store, 1, 'S5001')
    const key = 'i'.repeat(20)
    // First attempt: the quote write blows up after the message is stored.
    const real = deps.transact
    let failQuote = true
    deps.transact = async (items) => {
      if (failQuote && items.some((i) => i.Put?.TableName === T.quote)) { failQuote = false; throw new Error('boom') }
      return real(items)
    }
    await expect(fileInboundOffer(deps, mail(key), SYSTEM)).rejects.toThrow('boom')
    expect(messages(store)).toHaveLength(1)
    expect(quotes(store)).toHaveLength(0)
    const replay = await fileInboundOffer(deps, mail(key), SYSTEM)
    expect(replay.outcome).toBe('FILED')
    expect(quotes(store)).toHaveLength(1)
    const again = await fileInboundOffer(deps, mail(key), SYSTEM)
    expect(again.outcome).toBe('DUPLICATE')
    expect(quotes(store)).toHaveLength(1)
  })

  it('two different offers for one load in one batch both file', async () => {
    seedLoadFor(store, 1, 'S5001')
    await fileInboundOffer(deps, mail('j'.repeat(20)), SYSTEM)
    await fileInboundOffer(deps, mail('k'.repeat(20), { extraction: extraction({ rateCents: 175_000, loadRefs: ['S5001'] }) }), SYSTEM)
    expect(quotes(store).map((q) => q.amountCents).sort()).toEqual([175_000, 185_000])
  })

  it('a reply to one of our messages matches by thread', async () => {
    const { shipmentId } = seedLoadFor(store, 1, 'S5001')
    store.set(`${T.message}#msg:out`, { id: 'msg:out', shipmentId, messageId: '<out@bcat.test>' })
    const res = await fileInboundOffer(
      deps,
      mail('l'.repeat(20), { subject: 'Re: your load', inReplyTo: '<out@bcat.test>', extraction: extraction() }),
      SYSTEM,
    )
    expect(res).toMatchObject({ outcome: 'FILED', shipmentId, how: 'REPLY_THREAD' })
  })

  it('refuses a malformed hand-over', async () => {
    await expect(fileInboundOffer(deps, { ...mail('m'.repeat(20)), sourceKey: 'x' }, SYSTEM)).rejects.toThrow('sourceKey')
    await expect(fileInboundOffer(deps, { ...mail('m'.repeat(20)), source: 'FAX' }, SYSTEM)).rejects.toThrow('source')
  })

  it('audit rows carry ids and outcome, never the body', async () => {
    seedLoadFor(store, 1, 'S5001')
    await fileInboundOffer(deps, mail('n'.repeat(20)), SYSTEM)
    expect(JSON.stringify(deps.audits)).not.toContain('I can haul it')
    expect(deps.audits.find((a) => a.action === 'FILE_INBOUND_OFFER')).toBeTruthy()
  })
})

describe('assign and dismiss', () => {
  let store: Map<string, Row>
  let deps: TestDeps
  beforeEach(() => {
    store = new Map()
    deps = makeDeps(store)
  })

  const bucket = async (key: string, over: Partial<FileInboundOfferInput> = {}): Promise<string> => {
    const res = await fileInboundOffer(deps, mail(key, { subject: 'bid', extraction: extraction(), ...over }), SYSTEM)
    expect(res.outcome).toBe('UNMATCHED')
    return res.messageId
  }

  it('assign moves the row, drops the TTL and files the quote under the rep', async () => {
    const { shipmentId } = seedLoadFor(store, 1, 'S5001')
    const id = await bucket('o'.repeat(20))
    const res = await assignInboundOffer(deps, { messageId: id, shipmentId, amountCents: 190_000 }, REP)
    expect(res).toMatchObject({ shipmentId, outcome: 'FILED' })
    const msg = store.get(`${T.message}#${id}`)!
    expect(msg).toMatchObject({ shipmentId, threadKey: `tracking+${shipmentId}` })
    expect('ttlEpoch' in msg).toBe(false)
    expect(msg.offer).toMatchObject({ match: { state: 'ASSIGNED' }, assignedBy: REP.email, fieldMeta: { rateCents: { source: 'REP' } } })
    expect(quotes(store)[0]).toMatchObject({ amountCents: 190_000, createdBy: REP.email, offerMessageRef: id })
  })

  it('assign refuses a row that is no longer unmatched, so a second click cannot double-file', async () => {
    const { shipmentId } = seedLoadFor(store, 1, 'S5001')
    const id = await bucket('p'.repeat(20))
    await assignInboundOffer(deps, { messageId: id, shipmentId }, REP)
    await expect(assignInboundOffer(deps, { messageId: id, shipmentId }, REP)).rejects.toThrow('already assigned')
    expect(quotes(store)).toHaveLength(1)
  })

  it('assign re-run after a lost message update reuses the quote already made', async () => {
    const { shipmentId } = seedLoadFor(store, 1, 'S5001')
    const id = await bucket('q'.repeat(20))
    const real = deps.transact
    let failUpdate = true
    deps.transact = async (items) => {
      if (failUpdate && items.some((i) => i.Update?.TableName === T.message)) { failUpdate = false; throw new Error('lost') }
      return real(items)
    }
    await expect(assignInboundOffer(deps, { messageId: id, shipmentId }, REP)).rejects.toThrow('lost')
    await assignInboundOffer(deps, { messageId: id, shipmentId }, REP)
    expect(quotes(store)).toHaveLength(1)
    expect(store.get(`${T.message}#${id}`)).toMatchObject({ shipmentId })
  })

  it('assign onto a covered load only re-parents', async () => {
    const { shipmentId } = seedLoadFor(store, 1, 'S5001', { activeLoadCarrierId: 'lc' })
    const id = await bucket('r'.repeat(20))
    const res = await assignInboundOffer(deps, { messageId: id, shipmentId }, REP)
    expect(res.outcome).toBe('COVERED_LATE')
    expect(quotes(store)).toHaveLength(0)
    expect(store.get(`${T.message}#${id}`)).toMatchObject({ shipmentId })
  })

  it('dismiss deletes only an unmatched row and audits no content', async () => {
    const { shipmentId } = seedLoadFor(store, 1, 'S5001')
    const id = await bucket('s'.repeat(20))
    await dismissInboundOffer(deps, { messageId: id, reason: 'spam' }, REP)
    expect(store.has(`${T.message}#${id}`)).toBe(false)
    expect(JSON.stringify(deps.audits)).not.toContain('I can haul it')

    const filed = await fileInboundOffer(deps, mail('t'.repeat(20)), SYSTEM)
    expect(filed.shipmentId).toBe(shipmentId)
    await expect(dismissInboundOffer(deps, { messageId: filed.messageId }, REP)).rejects.toThrow('unmatched')
    expect(store.has(`${T.message}#${filed.messageId}`)).toBe(true)
  })
})

