/**
 * Unit tests for the P7 carrier-offer actions.
 *
 * Everything is in-memory: a tiny fake deps object exercises the module without
 * touching DynamoDB, SES, or the real adapter stack.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

import type { Row } from '../_shared/shipmentStore'
import type { Caller } from '../_shared/actionInputs'
import type { AdapterResult } from '../../../src/lib/integrations/types'
import {
  recordCarrierOffer,
  listCarrierOffers,
  sendCarrierSetupPacket,
  sendSetupPacket,
  type CarrierOfferDeps,
  type CarrierOfferVetting,
} from './carrierOffers'

const NOW = '2026-10-29T12:00:00.000Z'
const CALLER: Caller = { email: 'dispatch@bcatcorp.com', sub: 'u-dispatch', groups: ['page-tms'], isAdmin: false }

const TABLES = {
  quote: 'Quote-test',
  carrier: 'Carrier-test',
  carrierDocument: 'CarrierDocument-test',
  shipment: 'Shipment-test',
  posting: 'ShipmentPosting-test',
  settings: 'TmsSettings-test',
  load: 'Load-test',
}

function memoryStore(): Map<string, Row> {
  return new Map()
}

function fakeDeps(store: Map<string, Row>, opts: { standing?: Record<string, CarrierOfferVetting> } = {}): CarrierOfferDeps {
  const standingFor = opts.standing ?? {}
  const byId = (tableName: string, id: string): Row | null => {
    const key = `${tableName}#${id}`
    return store.get(key) ?? null
  }
  const queryIndex = async (tableName: string, _indexName: string, keyName: string, keyValue: unknown): Promise<Row[]> => {
    const out: Row[] = []
    for (const [key, row] of store.entries()) {
      if (!key.startsWith(`${tableName}#`)) continue
      if (row[keyName] === keyValue) out.push(row)
    }
    return out
  }
  return {
    tables: TABLES,
    getById: async (tableName: string, id: string) => byId(tableName, id),
    queryIndex,
    transact: async (items: TransactWriteItem[]) => {
      for (const item of items) {
        if (item.Put) {
          const row = unmarshall(item.Put.Item as never) as Row
          store.set(`${item.Put.TableName}#${String(row.id)}`, row)
        } else if (item.Update) {
          const keyName = item.Update.TableName ?? ''
          const keyId = String((unmarshall(item.Update.Key as never) as Row).id ?? '')
          const key = `${keyName}#${keyId}`
          const existing = store.get(key) ?? {}
          const names = (item.Update.ExpressionAttributeNames ?? {}) as Record<string, string>
          const values = (item.Update.ExpressionAttributeValues ?? {}) as Record<string, { S?: string; N?: string }>
          const resolve = (token: string): string => (token.startsWith('#') ? names[token] : token)
          const read = (ref: string): unknown => {
            if (ref.startsWith(':')) {
              const v = values[ref]
              if (v?.N != null) return Number(v.N)
              return v?.S ?? null
            }
            return existing[resolve(ref)]
          }
          const expr = String(item.Update.UpdateExpression ?? '')
          const patch: Record<string, unknown> = {}
          const removed = new Set<string>()
          const setMatch = /SET\s+(.+?)(?:\s+REMOVE\s+|$)/.exec(expr)
          if (setMatch) {
            for (const assignment of setMatch[1].split(',')) {
              const m = /^\s*([#\w]+)\s*=\s*(.+?)\s*$/.exec(assignment)
              if (!m) continue
              patch[resolve(m[1])] = read(m[2].trim())
            }
          }
          const removeMatch = /REMOVE\s+(.+)/.exec(expr)
          if (removeMatch) {
            for (const token of removeMatch[1].split(',')) {
              removed.add(resolve(token.trim()))
            }
          }
          const next: Row = {}
          for (const k of new Set([...Object.keys(existing), ...Object.keys(patch)])) {
            if (removed.has(k)) continue
            next[k] = k in patch ? patch[k] : existing[k]
          }
          store.set(key, next)
        }
      }
    },
    getSettings: async () => store.get(`${TABLES.settings}#default`) ?? {},
    writeAudit: async () => {},
    carrierStanding: (_carrier: Row | null, _settings: Row) => {
      const id = _carrier ? String(_carrier.id) : 'unknown'
      return (
        standingFor[id] ?? {
          known: _carrier != null,
          bookable: false,
          blockers: [],
          warnings: [],
          status: 'UNKNOWN',
          mcpStatus: null,
        }
      )
    },
    setupPacketAdapter: async () => ({
      mode: 'STUB' as const,
      send: async (_input: Record<string, unknown>): Promise<AdapterResult> => ({
        mode: 'STUB',
        ok: true,
        message: 'STUB — setup packet queued for email',
      }),
    }),
    nextQuoteNumber: async () => {
      const n = [...store.values()].filter((r) => r.__typename === 'Quote').length + 1
      return `Q${String(n).padStart(6, '0')}`
    },
    now: () => NOW,
  }
}

function seedShipment(store: Map<string, Row>, id = 'ship-1', extra: Row = {}): void {
  store.set(`${TABLES.shipment}#${id}`, {
    id,
    __typename: 'Shipment',
    status: 'OPEN',
    number: 'S000001',
    updatedAt: NOW,
    version: 1,
    ...extra,
  })
}

function seedLoad(store: Map<string, Row>, id = 'load-1', shipmentId = 'ship-1', extra: Row = {}): void {
  store.set(`${TABLES.load}#${id}`, {
    id,
    __typename: 'Load',
    shipmentId,
    loadNumber: 'L0001',
    status: 'SOURCING',
    originCity: 'Chicago',
    originState: 'IL',
    destinationCity: 'Dallas',
    destinationState: 'TX',
    stops: [
      { id: 'stop-pu', type: 'pickup', sequence: 0, city: 'Chicago, IL', appt: '2026-10-30T09:00:00.000Z', driverId: null },
      { id: 'stop-de', type: 'delivery', sequence: 1, city: 'Dallas, TX', appt: '2026-10-31T15:00:00.000Z', driverId: null },
    ],
    commodity: 'Electronics',
    weight: 42000,
    miles: 967,
    equipmentType: "53' VAN",
    pickupAppt: '2026-10-30T09:00:00.000Z',
    updatedAt: NOW,
    version: 1,
    ...extra,
  })
}

function seedCarrier(store: Map<string, Row>, id = 'car-1', extra: Row = {}): void {
  store.set(`${TABLES.carrier}#${id}`, {
    id,
    __typename: 'Carrier',
    name: 'SWIFT TRANSPORTATION',
    normalizedName: 'swift transportation',
    mcNumber: '123456',
    status: 'ACTIVE',
    authorityStatus: 'ACTIVE',
    ...extra,
  })
}

function seedPosting(store: Map<string, Row>, id = 'post:ship-1:DAT', shipmentId = 'ship-1', extra: Row = {}): void {
  store.set(`${TABLES.posting}#${id}`, {
    id,
    __typename: 'ShipmentPosting',
    shipmentId,
    provider: 'DAT',
    status: 'POSTED',
    offerCount: 0,
    updatedAt: NOW,
    version: 1,
    ...extra,
  })
}

function baseInput(): Row {
  return {
    shipmentId: 'ship-1',
    carrierName: 'Swift Transportation',
    carrierMc: '123456',
    contactName: 'Bob',
    contactPhone: '+1-555-0000',
    amountCents: 180_000,
    source: 'EMAIL',
    postingId: 'post:ship-1:DAT',
    messageRef: 'msg-abc',
  }
}

// ── recordCarrierOffer ───────────────────────────────────────────────────────

describe('recordCarrierOffer', () => {
  let store: Map<string, Row>
  let deps: CarrierOfferDeps

  beforeEach(() => {
    store = memoryStore()
    seedShipment(store)
    seedLoad(store)
    seedCarrier(store)
    seedPosting(store)
    deps = fakeDeps(store, {
      standing: {
        'car-1': { known: true, bookable: true, blockers: [], warnings: [], status: 'ACTIVE', mcpStatus: 'Ready' },
      },
    })
  })

  it('records a known, vetted carrier offer as bookable', async () => {
    const result = (await recordCarrierOffer(deps, baseInput(), CALLER)) as {
      quote: Row
      carrierId: string | null
      vetting: CarrierOfferVetting
    }
    expect(result.carrierId).toBe('car-1')
    expect(result.vetting.known).toBe(true)
    expect(result.vetting.bookable).toBe(true)
    expect(result.quote.side).toBe('BUY')
    expect(result.quote.status).toBe('RECEIVED_REPLY')
    expect(result.quote.amountCents).toBe(180_000)
  })

  it('records a lapsed-insurance carrier but marks it not bookable with the gate text', async () => {
    deps = fakeDeps(store, {
      standing: {
        'car-1': {
          known: true,
          bookable: false,
          blockers: ['No auto liability insurance covering the pickup date is on file.'],
          warnings: [],
          status: 'INACTIVE',
          mcpStatus: null,
        },
      },
    })
    const result = (await recordCarrierOffer(deps, baseInput(), CALLER)) as {
      quote: Row
      vetting: CarrierOfferVetting
    }
    expect(result.vetting.bookable).toBe(false)
    expect(result.vetting.blockers).toContain('No auto liability insurance covering the pickup date is on file.')
    expect(result.quote.status).toBe('RECEIVED_REPLY')
  })

  it('records an unknown MC with carrierId null and known false', async () => {
    const input = {
      ...baseInput(),
      carrierName: 'Acme Trucking',
      carrierMc: '999999',
    }
    const result = (await recordCarrierOffer(deps, input, CALLER)) as {
      quote: Row
      carrierId: string | null
      vetting: { known: boolean; bookable: boolean; carrierId: string | null }
    }
    expect(result.carrierId).toBeNull()
    expect(result.vetting.known).toBe(false)
    expect(result.quote.carrierId).toBeNull()
    expect(result.quote.carrierMc).toBe('999999')
  })

  it('returns the existing row on a duplicate MC/rate within ten minutes', async () => {
    await recordCarrierOffer(deps, baseInput(), CALLER)
    const result = (await recordCarrierOffer(deps, baseInput(), CALLER)) as {
      quote: Row
      carrierId: string | null
    }
    expect(result.carrierId).toBe('car-1')
    expect(result.quote.createdAt).toBe(NOW)
    const offers = [...store.values()].filter((r) => r.__typename === 'Quote')
    expect(offers).toHaveLength(1)
  })

  it('creates a second offer when the rate differs', async () => {
    await recordCarrierOffer(deps, baseInput(), CALLER)
    const input = { ...baseInput(), amountCents: 190_000 }
    await recordCarrierOffer(deps, input, CALLER)
    const offers = [...store.values()].filter((r) => r.__typename === 'Quote')
    expect(offers).toHaveLength(2)
  })

  it('records two different carriers at the same rate inside the window', async () => {
    seedCarrier(store, 'car-2', { name: 'Schneider National', normalizedName: 'schneider national', mcNumber: '654321' })
    deps = fakeDeps(store, {
      standing: {
        'car-1': { known: true, bookable: true, blockers: [], warnings: [], status: 'ACTIVE', mcpStatus: 'Ready' },
        'car-2': { known: true, bookable: true, blockers: [], warnings: [], status: 'ACTIVE', mcpStatus: 'Ready' },
      },
    })
    await recordCarrierOffer(deps, baseInput(), CALLER)
    await recordCarrierOffer(deps, { ...baseInput(), carrierName: 'Schneider National', carrierMc: '654321' }, CALLER)
    const offers = [...store.values()]
      .filter((r) => r.__typename === 'Quote')
      .sort((a, b) => String(a.carrierName).localeCompare(String(b.carrierName)))
    expect(offers).toHaveLength(2)
    expect(offers[0]?.carrierName).toBe('Schneider National')
    expect(offers[1]?.carrierName).toBe('Swift Transportation')
  })

  it('creates a new offer when the same carrier re-offers after the duplicate window', async () => {
    await recordCarrierOffer(deps, baseInput(), CALLER)
    store.set(`${TABLES.quote}#Q000001`, {
      ...store.get(`${TABLES.quote}#Q000001`)!,
      createdAt: '2026-10-22T12:00:00.000Z',
    })
    const result = (await recordCarrierOffer(deps, baseInput(), CALLER)) as {
      quote: Row
      carrierId: string | null
    }
    expect(result.carrierId).toBe('car-1')
    const offers = [...store.values()].filter((r) => r.__typename === 'Quote')
    expect(offers).toHaveLength(2)
  })

  it('refuses a load that is already covered', async () => {
    seedLoad(store, 'load-1', 'ship-1', { activeLoadCarrierId: 'lcr-1' })
    await expect(recordCarrierOffer(deps, baseInput(), CALLER)).rejects.toThrow(/already covered/)
  })

  it('refuses a voided shipment', async () => {
    seedShipment(store, 'ship-1', { voidedAt: NOW })
    await expect(recordCarrierOffer(deps, baseInput(), CALLER)).rejects.toThrow(/voided/)
  })

  it('refuses a zero rate', async () => {
    const input = { ...baseInput(), amountCents: 0 }
    await expect(recordCarrierOffer(deps, input, CALLER)).rejects.toThrow(/greater than zero/)
  })

  it('refuses a negative rate', async () => {
    const input = { ...baseInput(), amountCents: -100 }
    await expect(recordCarrierOffer(deps, input, CALLER)).rejects.toThrow(/greater than zero/)
  })

  it('sets Shipment.carrierOfferOpen to OPEN', async () => {
    await recordCarrierOffer(deps, baseInput(), CALLER)
    const shipment = store.get(`${TABLES.shipment}#ship-1`)!
    expect(shipment.carrierOfferOpen).toBe('OPEN')
  })

  it('bumps the posting offerCount when postingId is given', async () => {
    await recordCarrierOffer(deps, baseInput(), CALLER)
    const posting = store.get(`${TABLES.posting}#post:ship-1:DAT`)!
    expect(posting.offerCount).toBe(1)
  })

  it('accepts and stores PHONE source', async () => {
    const input = { ...baseInput(), source: 'PHONE' }
    const result = (await recordCarrierOffer(deps, input, CALLER)) as { quote: Row }
    expect(result.quote.offerSource).toBe('PHONE')
  })

  it('accepts and stores BOARD source', async () => {
    const input = { ...baseInput(), source: 'BOARD' }
    const result = (await recordCarrierOffer(deps, input, CALLER)) as { quote: Row }
    expect(result.quote.offerSource).toBe('BOARD')
  })

  it('accepts and stores MANUAL source', async () => {
    const input = { ...baseInput(), source: 'MANUAL' }
    const result = (await recordCarrierOffer(deps, input, CALLER)) as { quote: Row }
    expect(result.quote.offerSource).toBe('MANUAL')
  })

  it('matches the carrier by normalized name when MC is omitted', async () => {
    const input = { ...baseInput(), carrierMc: undefined }
    const result = (await recordCarrierOffer(deps, input, CALLER)) as { carrierId: string | null }
    expect(result.carrierId).toBe('car-1')
  })

  it('copies lane fields from the load onto the quote', async () => {
    const result = (await recordCarrierOffer(deps, baseInput(), CALLER)) as { quote: Row }
    expect(result.quote.laneKey).toBe('CHICAGO|IL>DALLAS|TX')
    expect(result.quote.miles).toBe(967)
    expect(result.quote.commodity).toBe('Electronics')
  })

  it('refuses an unknown shipment', async () => {
    const input = { ...baseInput(), shipmentId: 'ship-missing' }
    await expect(recordCarrierOffer(deps, input, CALLER)).rejects.toThrow(/Shipment not found/)
  })
})

// ── listCarrierOffers ──────────────────────────────────────────────────────────

describe('listCarrierOffers', () => {
  let store: Map<string, Row>

  beforeEach(async () => {
    store = memoryStore()
    seedShipment(store)
    seedLoad(store)
    seedPosting(store)
    seedCarrier(store, 'car-1', { normalizedName: 'swift transportation', mcNumber: '123456' })
    seedCarrier(store, 'car-2', { normalizedName: 'jb hunt', mcNumber: '654321' })
    seedCarrier(store, 'car-3', { normalizedName: 'old dominion', mcNumber: '111111' })
    const deps = fakeDeps(store, {
      standing: {
        'car-1': { known: true, bookable: true, blockers: [], warnings: [], status: 'ACTIVE', mcpStatus: 'Ready' },
        'car-2': { known: true, bookable: false, blockers: ['W-9 missing'], warnings: [], status: 'REVIEW', mcpStatus: null },
        'car-3': { known: true, bookable: false, blockers: [], warnings: [], status: 'INACTIVE', mcpStatus: null },
      },
    })
    // Create three offers: closed cheap, open expensive, open cheap.
    await recordCarrierOffer(deps, { ...baseInput(), carrierName: 'Swift Transportation', carrierMc: '123456', amountCents: 190_000, source: 'EMAIL' }, CALLER)
    const q1 = [...store.values()].find((r) => r.__typename === 'Quote')!
    store.set(`${TABLES.quote}#${String(q1.id)}`, { ...q1, quoteOpen: null }) // close it
    await recordCarrierOffer(deps, { ...baseInput(), carrierName: 'J.B. Hunt', carrierMc: '654321', amountCents: 185_000, source: 'EMAIL' }, CALLER)
    await recordCarrierOffer(deps, { ...baseInput(), carrierName: 'Old Dominion', carrierMc: '111111', amountCents: 175_000, source: 'PHONE' }, CALLER)
  })

  it('sorts open offers first, then by rate ascending', async () => {
    const deps = fakeDeps(store)
    const result = (await listCarrierOffers(deps, { shipmentId: 'ship-1' })) as { offers: (Row & { vetting: { known: boolean; blockers: string[] } })[] }
    expect(result.offers).toHaveLength(3)
    expect(result.offers[0].amountCents).toBe(175_000)
    expect(result.offers[1].amountCents).toBe(185_000)
    expect(result.offers[2].amountCents).toBe(190_000)
    expect(result.offers[0].quoteOpen).toBe('OPEN')
    expect(result.offers[1].quoteOpen).toBe('OPEN')
    expect(result.offers[2].quoteOpen).toBeNull()
  })

  it('attaches vetting to every offer', async () => {
    const deps = fakeDeps(store, {
      standing: {
        'car-1': { known: true, bookable: true, blockers: [], warnings: [], status: 'ACTIVE', mcpStatus: 'Ready' },
        'car-2': { known: true, bookable: false, blockers: ['W-9 missing'], warnings: [], status: 'REVIEW', mcpStatus: null },
        'car-3': { known: true, bookable: false, blockers: [], warnings: [], status: 'INACTIVE', mcpStatus: null },
      },
    })
    const result = (await listCarrierOffers(deps, { shipmentId: 'ship-1' })) as { offers: (Row & { vetting: { known: boolean; blockers: string[] } })[] }
    expect(result.offers[0].vetting.known).toBe(true)
    expect(result.offers[1].vetting.blockers).toContain('W-9 missing')
  })
})

// ── sendSetupPacket ───────────────────────────────────────────────────────────

describe('sendSetupPacket', () => {
  let store: Map<string, Row>

  beforeEach(async () => {
    store = memoryStore()
    seedShipment(store)
    seedLoad(store)
    seedPosting(store)
    seedCarrier(store, 'car-known', { normalizedName: 'known carrier', mcNumber: '111' })
    seedCarrier(store, 'car-unknown', { normalizedName: 'unknown carrier', mcNumber: '222' })
    const deps = fakeDeps(store, {
      standing: {
        'car-known': { known: true, bookable: true, blockers: [], warnings: [], status: 'ACTIVE', mcpStatus: 'Ready' },
        'unknown': { known: false, bookable: false, blockers: [], warnings: [], status: 'UNKNOWN', mcpStatus: null },
      },
    })
    await recordCarrierOffer(deps, { ...baseInput(), carrierName: 'Unknown Carrier', carrierMc: '222', amountCents: 170_000, source: 'EMAIL' }, CALLER)
    await recordCarrierOffer(deps, { ...baseInput(), carrierName: 'Known Carrier', carrierMc: '111', amountCents: 180_000, source: 'EMAIL' }, CALLER)
  })

  it('sends a setup packet in STUB mode labelled STUB', async () => {
    const deps = fakeDeps(store)
    const result = (await sendSetupPacket(deps, { shipmentId: 'ship-1', quoteId: 'Q000001', email: 'dispatch@example.com' }, CALLER)) as {
      sent: boolean
      mode: string
      message: string
    }
    expect(result.sent).toBe(true)
    expect(result.mode).toBe('STUB')
    expect(result.message).toMatch(/^STUB/)
  })

  it('refuses to send a setup packet for a carrier already set up', async () => {
    const deps = fakeDeps(store, {
      standing: {
        'car-known': { known: true, bookable: true, blockers: [], warnings: [], status: 'ACTIVE', mcpStatus: 'Ready' },
      },
    })
    await expect(
      sendSetupPacket(deps, { shipmentId: 'ship-1', quoteId: 'Q000002', email: 'dispatch@example.com' }, CALLER),
    ).rejects.toThrow(/already set up/)
  })

  it('rejects a setup packet for a missing offer', async () => {
    const deps = fakeDeps(store)
    await expect(
      sendSetupPacket(deps, { shipmentId: 'ship-1', quoteId: 'Q999999', email: 'dispatch@example.com' }, CALLER),
    ).rejects.toThrow(/Offer not found/)
  })
})

describe('sendCarrierSetupPacket', () => {
  it('sends a setup packet from a carrier profile in STUB mode', async () => {
    const store = memoryStore()
    seedCarrier(store, 'car-1', { name: 'Haul Bros', mcNumber: 'MC-123' })
    const deps = fakeDeps(store)

    const result = (await sendCarrierSetupPacket(deps, { carrierId: 'car-1', email: 'dispatch@haulbros.com' }, CALLER)) as {
      sent: boolean
      mode: string
      message: string
    }

    expect(result.sent).toBe(true)
    expect(result.mode).toBe('STUB')
  })

  it('rejects a setup packet for a missing carrier', async () => {
    const store = memoryStore()
    const deps = fakeDeps(store)
    await expect(
      sendCarrierSetupPacket(deps, { carrierId: 'car-missing', email: 'dispatch@example.com' }, CALLER),
    ).rejects.toThrow(/Carrier not found/)
  })
})
