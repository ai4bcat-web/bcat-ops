import { describe, it, expect, vi } from 'vitest'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  ingestShipmentMessage,
  listThread,
  openShipmentThread,
  sendShipmentMessage,
  type ThreadDeps,
} from './thread'
import { threadKeyFor, threadReplyAddress, newMessageId } from '../../../src/lib/shipmentThread'
import { MemoryStore, type Row } from './testSupport'

const CALLER = { email: 'ops@bcatcorp.com', sub: 'sub-ops', groups: [], isAdmin: false }

function makeDeps(store: MemoryStore, overrides: Partial<ThreadDeps> = {}): ThreadDeps {
  const sentEmails: ThreadDeps['sendEmail'] = vi.fn(async () => ({
    status: 'SENT' as const,
    providerRef: 'ses-ref',
    error: null,
  }))
  const sentSms: ThreadDeps['sendSms'] = vi.fn(async () => ({
    status: 'SENT' as const,
    providerRef: 'twilio-sid',
    error: null,
  }))
  return {
    tables: {
      message: 'ShipmentMessage-test',
      shipment: 'Shipment-test',
      order: 'Order-test',
      load: 'Load-test',
      loadCarrier: 'LoadCarrier-test',
      customer: 'Customer-test',
      settings: 'TmsSettings-test',
      document: 'ShipmentDocument-test',
      checkCall: 'LoadCheckCall-test',
      trackingLink: 'TrackingLink-test',
    },
    getById: (table, id) => Promise.resolve(store.getById(table, id)),
    queryIndex: (table, index, key, value) => Promise.resolve(store.queryIndex(table, index, key, value)),
    transact: (items: TransactWriteItem[]) => store.transact(items),
    readBundle: async () => ({}),
    getSettings: async () => ({}),
    writeAudit: vi.fn(async () => undefined),
    sendEmail: overrides.sendEmail ?? sentEmails,
    sendSms: overrides.sendSms ?? sentSms,
    geocode: overrides.geocode ?? vi.fn(async () => null),
    readDocumentBytes: overrides.readDocumentBytes ?? vi.fn(async () => new Uint8Array(0)),
    now: () => '2026-02-02T12:00:00.000Z',
    randomId: () => `r${Math.random().toString(36).slice(2)}`,
  }
}

function seedShipment(store: MemoryStore, overrides: Row = {}): Row {
  const row: Row = {
    id: 'shp-1',
    __typename: 'Shipment',
    number: 'BC1001',
    status: 'IN_TRANSIT',
    customerId: 'cus-1',
    threadKey: null,
    threadOpenedAt: null,
    version: 1,
    createdBy: CALLER.email,
    updatedBy: CALLER.email,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
  store.seed(row)
  return row
}

function seedLoad(store: MemoryStore, overrides: Row = {}): Row {
  const row: Row = {
    id: 'lod-1',
    __typename: 'Load',
    shipmentId: 'shp-1',
    loadNumber: 'BC1001-1',
    status: 'IN_TRANSIT',
    activeLoadCarrierId: 'lc-1',
    checkCallAwaitingSince: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
  store.seed(row)
  return row
}

function seedCarrier(store: MemoryStore, overrides: Row = {}): Row {
  const row: Row = {
    id: 'lc-1',
    __typename: 'LoadCarrier',
    loadId: 'lod-1',
    shipmentId: 'shp-1',
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierName: 'SWIFT TRANSPORTATION',
    driverName: 'Jose Ruiz',
    driverPhone: '(224) 555-0137',
    dispatcherEmail: 'dispatch@swift.test',
    createdBy: CALLER.email,
    updatedBy: CALLER.email,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
  store.seed(row)
  return row
}

describe('openShipmentThread', () => {
  it('stamps threadKey and threadOpenedAt once', async () => {
    const store = new MemoryStore()
    seedShipment(store)
    const deps = makeDeps(store)

    const result = await openShipmentThread(deps, 'shp-1', CALLER)
    expect(result.threadKey).toBe(threadKeyFor('shp-1'))
    expect(result.threadOpenedAt).toBe('2026-02-02T12:00:00.000Z')

    const fromStore = store.getById('Shipment-test', 'shp-1')
    expect(fromStore?.threadKey).toBe(result.threadKey)
    expect(fromStore?.updatedBy).toBe(CALLER.email)
  })

  it('returns existing threadKey idempotently', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1'), threadOpenedAt: '2026-01-15T00:00:00.000Z' })
    const deps = makeDeps(store)

    const result = await openShipmentThread(deps, 'shp-1', CALLER)
    expect(result.threadKey).toBe(threadKeyFor('shp-1'))
    expect(result.threadOpenedAt).toBe('2026-01-15T00:00:00.000Z')

    const fromStore = store.getById('Shipment-test', 'shp-1')
    expect(fromStore?.updatedAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('throws when shipment is missing', async () => {
    const store = new MemoryStore()
    const deps = makeDeps(store)
    await expect(openShipmentThread(deps, 'shp-missing', CALLER)).rejects.toThrow('Shipment not found')
  })
})

describe('sendShipmentMessage', () => {
  it('sends an email on the thread with a real Message-ID and Reply-To', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    const deps = makeDeps(store)

    const result = await sendShipmentMessage(
      deps,
      {
        shipmentId: 'shp-1',
        channel: 'EMAIL',
        kind: 'CHECK_CALL',
        to: 'dispatch@swift.test',
        subject: 'Update',
        body: 'Where are you?',
      },
      CALLER,
    )

    expect(result.status).toBe('SENT')
    expect(result.channel).toBe('EMAIL')
    expect(result.messageId).toMatch(/^<s\.shp-1\./)
    expect(result.threadKey).toBe(threadKeyFor('shp-1'))
    expect(deps.sendEmail).toHaveBeenCalled()
    const call = (deps.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.replyTo).toBe(threadReplyAddress('shp-1'))
    expect(call.inReplyTo).toBeNull()
  })

  it('sends an SMS to the driver', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    seedCarrier(store)
    const deps = makeDeps(store)

    const result = await sendShipmentMessage(
      deps,
      {
        shipmentId: 'shp-1',
        channel: 'SMS',
        kind: 'CHECK_CALL',
        to: '+12245550137',
        body: ' location?',
        label: { driverName: 'Jose' },
      },
      CALLER,
    )

    expect(result.status).toBe('SENT')
    expect(result.channel).toBe('SMS')
    expect(result.providerRef).toBe('twilio-sid')
    expect(deps.sendSms).toHaveBeenCalled()
  })

  it('writes an SMS row with no messageId and an email row with a messageId', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    seedCarrier(store)
    const deps = makeDeps(store)

    const sms = await sendShipmentMessage(
      deps,
      {
        shipmentId: 'shp-1',
        channel: 'SMS',
        kind: 'CHECK_CALL',
        to: '+12245550137',
        body: 'SMS body',
      },
      CALLER,
    )
    const email = await sendShipmentMessage(
      deps,
      {
        shipmentId: 'shp-1',
        channel: 'EMAIL',
        kind: 'CHECK_CALL',
        to: 'dispatch@swift.test',
        subject: 'Update',
        body: 'Email body',
      },
      CALLER,
    )

    expect(sms.channel).toBe('SMS')
    expect(sms.messageId).toBeFalsy()
    const smsRow = store.getById('ShipmentMessage-test', String(sms.id))
    expect('messageId' in (smsRow ?? {})).toBe(false)

    expect(email.channel).toBe('EMAIL')
    expect(email.messageId).toMatch(/^<s\.shp-1\./)
    const emailRow = store.getById('ShipmentMessage-test', String(email.id))
    expect(emailRow?.messageId).toMatch(/^<s\.shp-1\./)
  })

  it('refuses VOICE outright', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    const deps = makeDeps(store)

    await expect(
      sendShipmentMessage(
        deps,
        {
          shipmentId: 'shp-1',
          channel: 'VOICE',
          kind: 'CHECK_CALL',
          to: '+12245550137',
          body: 'call',
        },
        CALLER,
      ),
    ).rejects.toThrow('voice is not switched on yet')
  })

  it('leaves a NOT_SENT row with the exact body when SES is denied on dev', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    const sendEmail = vi.fn(async () => ({ status: 'NOT_SENT' as const, providerRef: null, error: null }))
    const deps = makeDeps(store, { sendEmail })

    const result = await sendShipmentMessage(
      deps,
      {
        shipmentId: 'shp-1',
        channel: 'EMAIL',
        kind: 'CHECK_CALL',
        to: 'dispatch@swift.test',
        subject: 'Update',
        body: 'exact body text',
      },
      CALLER,
    )

    expect(result.status).toBe('NOT_SENT')
    expect(result.body).toBe('exact body text\n\n— Ops, BCAT Tracking')
    const fromStore = store.getById('ShipmentMessage-test', String(result.id))
    expect(fromStore?.status).toBe('NOT_SENT')
    expect(fromStore?.body).toBe('exact body text\n\n— Ops, BCAT Tracking')
  })

  it('records a FAILED status when the provider throws', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    const sendEmail = vi.fn(async () => ({ status: 'FAILED' as const, providerRef: null, error: 'boom' }))
    const deps = makeDeps(store, { sendEmail })

    const result = await sendShipmentMessage(
      deps,
      { shipmentId: 'shp-1', channel: 'EMAIL', kind: 'CHECK_CALL', to: 'a@test', subject: 'S', body: 'B' },
      CALLER,
    )

    expect(result.status).toBe('FAILED')
    expect(result.error).toBe('boom')
  })

  it('throws when the shipment thread has not been opened', async () => {
    const store = new MemoryStore()
    seedShipment(store)
    const deps = makeDeps(store)
    await expect(
      sendShipmentMessage(
        deps,
        { shipmentId: 'shp-1', channel: 'EMAIL', kind: 'CHECK_CALL', to: 'a@test', subject: 'S', body: 'B' },
        CALLER,
      ),
    ).rejects.toThrow('thread has not been opened')
  })

  it('uses the supplied In-Reply-To header', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    const deps = makeDeps(store)

    await sendShipmentMessage(
      deps,
      {
        shipmentId: 'shp-1',
        channel: 'EMAIL',
        kind: 'CHECK_CALL',
        to: 'dispatch@swift.test',
        subject: 'Re: update',
        body: 'reply',
        inReplyTo: '<parent@example.com>',
      },
      CALLER,
    )

    const call = (deps.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.inReplyTo).toBe('<parent@example.com>')
    expect(call.messageId).toMatch(/^<s\.shp-1\./)
  })

  it('resolves documentIds into attachment metadata on an outbound email', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    store.seed({
      id: 'doc-1',
      __typename: 'ShipmentDocument',
      shipmentId: 'shp-1',
      name: 'rate.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1000,
      s3Key: 'shipment-docs/shp-1/doc-1/rate.pdf',
      audience: 'CARRIER',
    })
    const deps = makeDeps(store, {
      readDocumentBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    })

    const result = await sendShipmentMessage(
      deps,
      {
        shipmentId: 'shp-1',
        channel: 'EMAIL',
        kind: 'RATE_CON',
        to: 'dispatch@swift.test',
        subject: 'Rate',
        body: 'See attached',
        documentIds: ['doc-1'],
      },
      CALLER,
    )

    expect(Array.isArray(result.attachments)).toBe(true)
    expect((result.attachments as Row[])[0].name).toBe('rate.pdf')
  })

  it('signs a person message with their first name', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    const deps = makeDeps(store)

    const result = await sendShipmentMessage(
      deps,
      { shipmentId: 'shp-1', channel: 'EMAIL', kind: 'NOTE', to: 'dispatch@swift.test', subject: 'S', body: 'Hi' },
      { ...CALLER, email: 'maria.garcia@bcatcorp.com' },
    )

    expect(result.body).toBe('Hi\n\n— Maria, BCAT Tracking')
    expect(result.authorKind).toBe('PERSON')
    expect(result.authorName).toBe('Maria')
    const call = (deps.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.body).toBe('Hi\n\n— Maria, BCAT Tracking')
  })

  it('signs an agent message as the assistant', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    const deps = makeDeps(store)

    const result = await sendShipmentMessage(
      deps,
      { shipmentId: 'shp-1', channel: 'SMS', kind: 'CHECK_CALL', to: '+12245550137', body: 'Where are you?', authorKind: 'AGENT' },
      CALLER,
    )

    expect(result.body).toBe('Where are you?\n\n— BCAT Tracking Assistant')
    expect(result.authorKind).toBe('AGENT')
    expect(result.authorName).toBe('BCAT Tracking Assistant')
    const call = (deps.sendSms as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.body).toBe('Where are you?\n\n— BCAT Tracking Assistant')
  })
})

describe('ingestShipmentMessage', () => {
  it('routes an inbound reply by plus address', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    seedLoad(store)
    const deps = makeDeps(store)

    const result = await ingestShipmentMessage(
      deps,
      {
        messageId: '<driver-1@example.com>',
        to: threadReplyAddress('shp-1'),
        from: 'driver@example.com',
        subject: 'Re: Load BC1001',
        body: 'In Dallas',
      },
      CALLER,
    )

    expect(result.routed).toBe(true)
    const msg = store.queryIndex('ShipmentMessage-test', 'shipmentMessagesByShipmentIdAndAt', 'shipmentId', 'shp-1')[0]
    expect(msg.direction).toBe('IN')
  })

  it('routes an inbound reply by Message-ID', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    seedLoad(store)
    const deps = makeDeps(store)

    const result = await ingestShipmentMessage(
      deps,
      {
        messageId: newMessageId('shp-1', 1),
        to: 'ai4bcat@gmail.com',
        from: 'driver@example.com',
        subject: 'Fw: update',
        body: 'loaded',
      },
      CALLER,
    )

    expect(result.routed).toBe(true)
  })

  it('returns routed:false when it cannot find a shipment', async () => {
    const store = new MemoryStore()
    const deps = makeDeps(store)
    const result = await ingestShipmentMessage(
      deps,
      { messageId: '<x@example.com>', to: 'ai4bcat@gmail.com', from: 'x', subject: 's', body: 'b' },
      CALLER,
    )
    expect(result.routed).toBe(false)
    expect(result.reason).toMatch(/Could not route/)
  })

  it('deduplicates on messageId', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    seedLoad(store)
    const deps = makeDeps(store)
    const input = { messageId: '<dup-1@example.com>', to: threadReplyAddress('shp-1'), from: 'd', subject: 's', body: 'b' }

    const first = await ingestShipmentMessage(deps, input, CALLER)
    const second = await ingestShipmentMessage(deps, input, CALLER)

    expect(second.duplicate).toBe(true)
    expect((second.message as Row).id).toBe((first.message as Row).id)
    expect(store.table('ShipmentMessage-test').size).toBe(1)
  })

  it('clears the reply clock on every waiting load', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    seedLoad(store, { checkCallAwaitingSince: '2026-02-02T11:59:00.000Z' })
    const deps = makeDeps(store)

    await ingestShipmentMessage(
      deps,
      {
        messageId: '<reply-1@example.com>',
        to: threadReplyAddress('shp-1'),
        from: 'driver@example.com',
        subject: 'Re:',
        body: 'All good',
      },
      CALLER,
    )

    const load = store.getById('Load-test', 'lod-1')
    expect(load?.checkCallAwaitingSince).toBeUndefined()
  })

  it('writes a positioned location update when the body geocodes to a place', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    seedLoad(store)
    const geocode = vi.fn(async (text: string) =>
      text.toLowerCase().includes('dallas')
        ? { city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.797 }
        : null
    )
    const deps = makeDeps(store, { geocode })

    await ingestShipmentMessage(
      deps,
      {
        messageId: '<loc-1@example.com>',
        to: threadReplyAddress('shp-1'),
        from: 'driver@example.com',
        subject: 'Re:',
        body: 'In Dallas now',
      },
      CALLER,
    )

    const calls = store.queryIndex('LoadCheckCall-test', 'loadCheckCallsByLoadIdAndAt', 'loadId', 'lod-1')
    const location = calls.find((c) => c.type === 'LOCATION_UPDATE')
    expect(location?.city).toBe('Dallas')
    expect(location?.source).toBe('MANUAL')

    const load = store.getById('Load-test', 'lod-1')
    expect(load?.lastKnownCity).toBe('Dallas')
    expect(load?.lastKnownSource).toBe('MANUAL')
  })

  it('writes a plain NOTE check call when geocoding returns null', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    seedLoad(store)
    const deps = makeDeps(store)

    await ingestShipmentMessage(
      deps,
      {
        messageId: '<note-1@example.com>',
        to: threadReplyAddress('shp-1'),
        from: 'driver@example.com',
        subject: 'Re:',
        body: 'Thanks',
      },
      CALLER,
    )

    const calls = store.queryIndex('LoadCheckCall-test', 'loadCheckCallsByLoadIdAndAt', 'loadId', 'lod-1')
    expect(calls.some((c) => c.type === 'NOTE' && c.note === 'Thanks')).toBe(true)
    expect(calls.some((c) => c.type === 'LOCATION_UPDATE')).toBe(false)
  })
})

describe('listThread', () => {
  it('returns messages oldest first', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    store.seed({
      id: 'm2',
      __typename: 'ShipmentMessage',
      shipmentId: 'shp-1',
      threadKey: threadKeyFor('shp-1'),
      at: '2026-02-02T12:05:00.000Z',
      direction: 'OUT',
      channel: 'EMAIL',
      kind: 'CHECK_CALL',
      status: 'SENT',
      createdBy: CALLER.email,
      updatedAt: '2026-02-02T12:05:00.000Z',
    })
    store.seed({
      id: 'm1',
      __typename: 'ShipmentMessage',
      shipmentId: 'shp-1',
      threadKey: threadKeyFor('shp-1'),
      at: '2026-02-02T12:00:00.000Z',
      direction: 'OUT',
      channel: 'EMAIL',
      kind: 'RATE_CON',
      status: 'SENT',
      createdBy: CALLER.email,
      updatedAt: '2026-02-02T12:00:00.000Z',
    })
    const deps = makeDeps(store)

    const result = await listThread(deps, { shipmentId: 'shp-1' })
    const ids = (result.messages as Row[]).map((m) => m.id)
    expect(ids).toEqual(['m1', 'm2'])
  })

  it('returns an empty list for a shipment with no messages', async () => {
    const store = new MemoryStore()
    seedShipment(store, { threadKey: threadKeyFor('shp-1') })
    const deps = makeDeps(store)

    const result = await listThread(deps, { shipmentId: 'shp-1' })
    expect((result.messages as Row[]).length).toBe(0)
  })
})
