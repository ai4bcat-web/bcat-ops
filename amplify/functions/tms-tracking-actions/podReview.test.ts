import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { requestPod, reviewShipmentPod, type PodReviewDeps, type PodCheckResult } from './podReview'
import { threadKeyFor } from '../../../src/lib/shipmentThread'
import { MemoryStore, type Row } from './testSupport'

const CALLER = { email: 'ops@bcatcorp.com', sub: 'sub-ops', groups: [], isAdmin: false }

function makePodDeps(
  store: MemoryStore,
  overrides: { checkPod?: (input: { s3Key: string; contentType: string; stops: Row[] }) => Promise<PodCheckResult>; readyForBilling?: () => Promise<Row> } = {},
): PodReviewDeps {
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
    sendEmail: vi.fn(async () => ({ status: 'SENT' as const, providerRef: 'ses', error: null })),
    sendSms: vi.fn(async () => ({ status: 'SENT' as const, providerRef: 'tw', error: null })),
    geocode: vi.fn(async () => null),
    readDocumentBytes: vi.fn(async () => new Uint8Array(0)),
    now: () => currentTime,
    randomId: () => `r${Math.random().toString(36).slice(2)}`,
    checkPod: overrides.checkPod ?? vi.fn(async () => passResult()),
    readyForBilling: overrides.readyForBilling ?? vi.fn(async () => ({ ok: true })),
  }
}

let currentTime = '2026-02-02T12:00:00.000Z'

function passResult(): PodCheckResult {
  return {
    pages: { verdict: 'PASS', markers: '', statedTotal: null, received: 2, notes: 'complete' },
    legibility: { verdict: 'PASS', notes: 'clear' },
    signed: 'PASS',
    summary: 'good',
  }
}

function missingPageResult(): PodCheckResult {
  return {
    pages: { verdict: 'FAIL', markers: 'Page 1 of 2', statedTotal: 2, received: 1, notes: 'missing page 2' },
    legibility: { verdict: 'PASS', notes: 'clear' },
    signed: 'PASS',
    summary: 'incomplete',
  }
}

function illegibleResult(): PodCheckResult {
  return {
    pages: { verdict: 'PASS', markers: '', statedTotal: null, received: 1, notes: 'complete' },
    legibility: { verdict: 'FAIL', notes: 'blurred signature' },
    signed: 'PASS',
    summary: 'illegible',
  }
}

function unsignedResult(): PodCheckResult {
  return {
    pages: { verdict: 'PASS', markers: '', statedTotal: null, received: 1, notes: 'complete' },
    legibility: { verdict: 'PASS', notes: 'clear' },
    signed: 'FAIL',
    summary: 'unsigned',
  }
}

function seedDeliveredShipment(store: MemoryStore): Row {
  return store.seed({
    id: 'shp-1',
    __typename: 'Shipment',
    number: 'BC1001',
    status: 'DELIVERED',
    threadKey: threadKeyFor('shp-1'),
    threadOpenedAt: '2026-02-02T08:00:00.000Z',
    podFlaggedAt: null,
    podFlagReason: null,
    createdBy: CALLER.email,
    updatedBy: CALLER.email,
    updatedAt: '2026-01-02T00:00:00.000Z',
  })
}

function seedDeliveredLoad(store: MemoryStore, overrides: Row = {}): Row {
  return store.seed({
    id: 'lod-1',
    __typename: 'Load',
    shipmentId: 'shp-1',
    loadNumber: 'BC1001-1',
    status: 'DELIVERED',
    activeLoadCarrierId: 'lc-1',
    stops: [
      { id: 'stp-1', type: 'pickup', sequence: 1, city: 'Chicago', state: 'IL' },
      { id: 'stp-2', type: 'delivery', sequence: 2, city: 'Dallas', state: 'TX' },
    ],
    createdBy: CALLER.email,
    updatedBy: CALLER.email,
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  })
}

function seedCarrier(store: MemoryStore): Row {
  return store.seed({
    id: 'lc-1',
    __typename: 'LoadCarrier',
    loadId: 'lod-1',
    shipmentId: 'shp-1',
    kind: 'CARRIER',
    status: 'ACTIVE',
    driverName: 'Jose',
    driverPhone: '+12245550137',
    dispatcherEmail: 'dispatch@swift.test',
    podRequestedAt: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
  })
}

function seedPodDocument(store: MemoryStore, overrides: Row = {}): Row {
  return store.seed({
    id: 'sdoc-1',
    __typename: 'ShipmentDocument',
    shipmentId: 'shp-1',
    loadId: 'lod-1',
    loadCarrierId: 'lc-1',
    type: 'POD',
    name: 'pod.pdf',
    s3Key: 'shipment-docs/shp-1/pod.pdf',
    contentType: 'application/pdf',
    sizeBytes: 120_000,
    pages: 2,
    source: 'UPLOAD',
    audience: 'ALL',
    status: 'ACTIVE',
    version: 1,
    reviewStatus: null,
    uploadedBy: CALLER.email,
    uploadedAt: currentTime,
    createdBy: CALLER.email,
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  })
}

describe('requestPod', () => {
  beforeEach(() => {
    currentTime = '2026-02-02T12:00:00.000Z'
  })

  it('refuses to ask for a POD before delivery', async () => {
    const store = new MemoryStore()
    store.seed({
      id: 'shp-1',
      __typename: 'Shipment',
      number: 'BC1001',
      status: 'IN_TRANSIT',
      threadKey: threadKeyFor('shp-1'),
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    const deps = makePodDeps(store)
    await expect(requestPod(deps, { shipmentId: 'shp-1' }, CALLER)).rejects.toThrow('POD cannot be requested until the shipment is delivered')
  })

  it('sends an email to dispatch and an SMS to the driver', async () => {
    const store = new MemoryStore()
    seedDeliveredShipment(store)
    seedDeliveredLoad(store)
    seedCarrier(store)
    const deps = makePodDeps(store)

    const result = await requestPod(deps, { shipmentId: 'shp-1' }, CALLER)

    const messages = result.messages as Row[]
    expect(messages.length).toBe(2)
    const kinds = messages.map((m: Row) => ({ channel: m.channel, kind: m.kind, to: m.to }))
    expect(kinds).toContainEqual({ channel: 'EMAIL', kind: 'POD_REQUEST', to: 'dispatch@swift.test' })
    expect(kinds).toContainEqual({ channel: 'SMS', kind: 'POD_REQUEST', to: '+12245550137' })

    const carrier = store.getById('LoadCarrier-test', 'lc-1')
    expect(carrier?.podRequestedAt).toBe(currentTime)
  })

  it('includes the rejection reason when re-asking', async () => {
    const store = new MemoryStore()
    seedDeliveredShipment(store)
    seedDeliveredLoad(store)
    seedCarrier(store)
    const deps = makePodDeps(store)

    const result = await requestPod(deps, { shipmentId: 'shp-1', reason: 'page 2 missing' }, CALLER)

    const email = (result.messages as Row[]).find((m: Row) => m.channel === 'EMAIL')
    expect(email?.body).toContain('page 2 missing')
  })
})

describe('reviewShipmentPod', () => {
  beforeEach(() => {
    currentTime = '2026-02-02T12:00:00.000Z'
  })

  it('accepts a legible POD with all pages and routes to readyForBilling', async () => {
    const store = new MemoryStore()
    seedDeliveredShipment(store)
    seedDeliveredLoad(store)
    seedCarrier(store)
    seedPodDocument(store)
    const deps = makePodDeps(store)

    const result = await reviewShipmentPod(deps, { shipmentId: 'shp-1', documentId: 'sdoc-1' }, CALLER)

    expect(result.status).toBe('ACCEPTED')
    expect(result.readyForBillingCalled).toBe(true)
    const doc = store.getById('ShipmentDocument-test', 'sdoc-1')
    expect(doc?.reviewStatus).toBe('ACCEPTED')
    expect(doc?.reviewedBy).toBe(CALLER.email)
  })

  it('rejects a POD with a missing page and re-requests on the first failure', async () => {
    const store = new MemoryStore()
    seedDeliveredShipment(store)
    seedDeliveredLoad(store)
    seedCarrier(store)
    seedPodDocument(store)
    const deps = makePodDeps(store, { checkPod: async () => missingPageResult() })

    const result = await reviewShipmentPod(deps, { shipmentId: 'shp-1', documentId: 'sdoc-1' }, CALLER)

    expect(result.status).toBe('REJECTED')
    expect(result.flagged).toBe(false)
    expect(result.reRequested).toBe(true)
    expect(result.reason).toContain('Missing pages')

    const messages = store.queryIndex('ShipmentMessage-test', 'shipmentMessagesByShipmentIdAndAt', 'shipmentId', 'shp-1')
    expect(messages.some((m) => m.kind === 'POD_REQUEST')).toBe(true)
  })

  it('flags a human after the second rejected POD', async () => {
    const store = new MemoryStore()
    seedDeliveredShipment(store)
    seedDeliveredLoad(store)
    seedCarrier(store)
    // First rejected POD already on the shipment
    store.seed({
      id: 'sdoc-old',
      __typename: 'ShipmentDocument',
      shipmentId: 'shp-1',
      loadId: 'lod-1',
      loadCarrierId: 'lc-1',
      type: 'POD',
      name: 'pod-old.pdf',
      s3Key: 'shipment-docs/shp-1/pod-old.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100_000,
      source: 'UPLOAD',
      audience: 'ALL',
      status: 'ACTIVE',
      version: 1,
      reviewStatus: 'REJECTED',
      uploadedBy: CALLER.email,
      uploadedAt: currentTime,
      createdBy: CALLER.email,
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    seedPodDocument(store)
    const deps = makePodDeps(store, { checkPod: async () => missingPageResult() })

    const result = await reviewShipmentPod(deps, { shipmentId: 'shp-1', documentId: 'sdoc-1' }, CALLER)

    expect(result.status).toBe('REJECTED')
    expect(result.flagged).toBe(true)
    expect(result.reRequested).toBe(false)
    const shipment = store.getById('Shipment-test', 'shp-1')
    expect(shipment?.podFlaggedAt).toBe(currentTime)
    expect(shipment?.podFlagReason).toContain('Missing pages')
  })

  it('rejects on illegibility on the first failure', async () => {
    const store = new MemoryStore()
    seedDeliveredShipment(store)
    seedDeliveredLoad(store)
    seedCarrier(store)
    seedPodDocument(store)
    const deps = makePodDeps(store, { checkPod: async () => illegibleResult() })

    const result = await reviewShipmentPod(deps, { shipmentId: 'shp-1', documentId: 'sdoc-1' }, CALLER)

    expect(result.status).toBe('REJECTED')
    expect(result.flagged).toBe(false)
    expect(result.reRequested).toBe(true)
    expect(result.reason).toContain('blurred')
  })

  it('rejects on missing signature or date', async () => {
    const store = new MemoryStore()
    seedDeliveredShipment(store)
    seedDeliveredLoad(store)
    seedCarrier(store)
    seedPodDocument(store)
    const deps = makePodDeps(store, { checkPod: async () => unsignedResult() })

    const result = await reviewShipmentPod(deps, { shipmentId: 'shp-1', documentId: 'sdoc-1' }, CALLER)

    expect(result.status).toBe('REJECTED')
    expect(result.reason).toContain('Signature')
  })

  it('does not call readyForBilling on a failing review', async () => {
    const store = new MemoryStore()
    seedDeliveredShipment(store)
    seedDeliveredLoad(store)
    seedCarrier(store)
    seedPodDocument(store)
    const readyForBilling = vi.fn(async () => ({ ok: true }))
    const deps = makePodDeps(store, { checkPod: async () => missingPageResult(), readyForBilling })

    await reviewShipmentPod(deps, { shipmentId: 'shp-1', documentId: 'sdoc-1' }, CALLER)

    expect(readyForBilling).not.toHaveBeenCalled()
  })

  it('throws when the document is not a POD', async () => {
    const store = new MemoryStore()
    seedDeliveredShipment(store)
    seedDeliveredLoad(store)
    seedCarrier(store)
    store.seed({
      id: 'sdoc-bol',
      __typename: 'ShipmentDocument',
      shipmentId: 'shp-1',
      type: 'BOL',
      name: 'bol.pdf',
      s3Key: 'bol.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1000,
      source: 'UPLOAD',
      audience: 'ALL',
      status: 'ACTIVE',
      version: 1,
      uploadedBy: CALLER.email,
      uploadedAt: currentTime,
      createdBy: CALLER.email,
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    const deps = makePodDeps(store)
    await expect(reviewShipmentPod(deps, { shipmentId: 'shp-1', documentId: 'sdoc-bol' }, CALLER)).rejects.toThrow('Only POD documents')
  })
})
