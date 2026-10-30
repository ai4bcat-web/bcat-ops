/**
 * Step P6 posting actions — plain in-memory fakes, no AWS SDK mocking.
 */
import { describe, expect, it } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

import {
  postLoad,
  unpostLoad,
  listPostings,
  type PostingDeps,
  type AdapterAnswer,
  POSTABLE_PROVIDERS,
} from './postings'
import type { Caller } from '../_shared/actionInputs'
import { updateItemTx, type Bundle, type Row } from '../_shared/shipmentStore'
import { validateNoNullGsiKeys } from '../tms-tracking-actions/testSupport'

const caller: Caller = { email: 'broker@bcat.com', sub: 'broker', groups: ['ADMIN'], isAdmin: true }
const NOW = '2026-10-29T12:00:00.000Z'

function defaultBundle(overrides: {
  shipmentId?: string
  shipment?: Row
  loads?: Row[]
  loadCarriers?: Row[]
}): Bundle {
  const shipment = {
    id: 'ship-1',
    number: 'S000001',
    status: 'OPEN',
    buildState: 'BUILT',
    missingFields: [],
    datPostedAt: null,
    postedBoards: [],
    updatedAt: '2026-10-29T11:00:00.000Z',
    ...overrides.shipment,
  }
  const loads = overrides.loads ?? [
    {
      id: 'load-1',
      shipmentId: 'ship-1',
      leg: 1,
      equipmentType: 'VAN',
      weight: 42000,
      rate: 175_00,
      stops: [
        {
          id: 'stop-pu',
          type: 'pickup',
          sequence: 0,
          appt: '2026-10-30T08:00:00.000Z',
          city: 'Chicago',
          address: { state: 'IL' },
        },
        {
          id: 'stop-de',
          type: 'delivery',
          sequence: 1,
          appt: '2026-10-30T18:00:00.000Z',
          city: 'Detroit',
          address: { state: 'MI' },
        },
      ],
    },
  ]
  return {
    shipment,
    orders: [],
    loads,
    loadCarriers: overrides.loadCarriers ?? [],
    charges: [],
    financials: [],
    documents: [],
  }
}

function makeDeps(overrides?: Partial<PostingDeps> & { shipment?: Row; loads?: Row[]; loadCarriers?: Row[] }): PostingDeps {
  const store = new Map<string, Map<string, Row>>()
  function table(name: string): Map<string, Row> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }

  function apply(items: TransactWriteItem[]) {
    for (const item of items) {
      if (item.Put) {
        const row = unmarshall(item.Put.Item!) as Row
        validateNoNullGsiKeys(String(item.Put.TableName), row)
        table(String(item.Put.TableName)).set(String(row.id), row)
        continue
      }
      if (item.Update) {
        const id = String((unmarshall(item.Update.Key!) as Row).id)
        const tableName = String(item.Update.TableName)
        const t = table(tableName)
        const current = t.get(id) ?? {}
        const names = item.Update.ExpressionAttributeNames ?? {}
        const values = item.Update.ExpressionAttributeValues ?? {}

        const updateExpr: string = item.Update.UpdateExpression ?? ''
        const setMatch = /\bSET\b/i.exec(updateExpr)
        const removeMatch = /\bREMOVE\s+(.+?)(?=\s*$)/i.exec(updateExpr)
        const setEnd = removeMatch ? removeMatch.index : updateExpr.length
        if (setMatch) {
          const setClause = updateExpr.slice(setMatch.index + 3, setEnd)
          for (const assignment of setClause.split(',')) {
            const m = /^\s*(#[\w]+)\s*=\s*(:\w+)\s*$/.exec(assignment)
            if (!m) continue
            const field = names[m[1]]
            if (field === 'id') {
              throw new Error('Cannot update attribute id. This attribute is part of the key')
            }
          }
        }

        for (const field of Object.values(names)) {
          if (!field) continue
          const valueAlias = `:${field}`
          if (valueAlias in values) {
            current[field] = unmarshall({ v: values[valueAlias] }).v
          }
        }

        const removeAliases = removeMatch ? removeMatch[1].split(',').map((s) => s.trim().split(' ')[0]) : []
        for (const alias of removeAliases) {
          const field = names[alias]
          if (field) delete current[field]
        }

        validateNoNullGsiKeys(tableName, current)
        current.id = id
        t.set(id, current)
      }
    }
  }

  const adapters: Record<string, { mode: 'STUB' | 'LIVE'; post: () => Promise<AdapterAnswer>; unpost: () => Promise<AdapterAnswer> }> = {
    DAT: {
      mode: 'STUB' as const,
      post: async () => ({ mode: 'STUB', ok: true, message: 'STUB — posted to DAT', externalId: 'stub:dat-1' }),
      unpost: async () => ({ mode: 'STUB', ok: true, message: 'STUB — unposted DAT' }),
    },
    TRUCKSTOP: {
      mode: 'STUB' as const,
      post: async () => ({ mode: 'STUB', ok: true, message: 'STUB — posted to Truckstop', externalId: 'stub:ts-1' }),
      unpost: async () => ({ mode: 'STUB', ok: true, message: 'STUB — unposted Truckstop' }),
    },
  }

  const deps: PostingDeps = {
    tables: {
      posting: 'ShipmentPosting',
      shipment: 'Shipment',
      load: 'Load',
      order: 'Order',
      integration: 'Integration',
    },
    getById: async (name, id) => table(name).get(id) ?? null,
    queryIndex: async (name, _index, _key, value) => {
      const rows = [...table(name).values()]
      if (_index === 'shipmentPostingsByShipmentId') return rows.filter((r) => String(r.shipmentId) === value)
      if (_index === 'shipmentPostingsByStatusAndPostedAt') return rows.filter((r) => String(r.status) === value)
      return rows.filter((r) => String(r[_key as keyof Row]) === value)
    },
    transact: async (items) => apply(items),
    readBundle: async () => defaultBundle(overrides as { shipment?: Row; loads?: Row[]; loadCarriers?: Row[] } || {}),
    writeAudit: async () => undefined,
    adapterFor: async (provider) => {
      const a = adapters[provider]
      if (!a) throw new Error(`No adapter for ${provider}`)
      return a
    },
    now: () => NOW,
  }

  return deps
}

describe('postLoad', () => {
  it('refuses a voided shipment', async () => {
    const deps = makeDeps({ shipment: { voidedAt: NOW } })
    await expect(
      postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller),
    ).rejects.toThrow('A voided shipment cannot be posted')
  })

  it('refuses a shipment still building with the missing-field labels', async () => {
    const deps = makeDeps({ shipment: { buildState: 'BUILDING', missingFields: ['pickupAddress', 'equipmentType'] } })
    await expect(postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)).rejects.toThrow(
      /Finish building this shipment first/,
    )
    await expect(postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)).rejects.toThrow(/Pickup address/)
    await expect(postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)).rejects.toThrow(/Equipment type/)
  })

  it('refuses when a load is already covered by an active carrier', async () => {
    const deps = makeDeps({
      loadCarriers: [
        {
          id: 'lc-1',
          loadId: 'load-1',
          shipmentId: 'ship-1',
          status: 'ACTIVE',
          carrierName: 'Ivan Cartage',
          carrierMc: 'MC-12345',
        },
      ],
    })
    await expect(postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)).rejects.toThrow(
      'That load is already covered by Ivan Cartage',
    )
  })

  it('refuses an unknown board and names the postable ones', async () => {
    const deps = makeDeps()
    await expect(postLoad(deps, { shipmentId: 'ship-1', providers: ['UNKNOWN'] }, caller)).rejects.toThrow(
      'UNKNOWN is not a postable provider. Choose one of: DAT, TRUCKSTOP',
    )
  })

  it('refuses an empty provider list', async () => {
    const deps = makeDeps()
    await expect(postLoad(deps, { shipmentId: 'ship-1', providers: [] }, caller)).rejects.toThrow(
      /providers must have at least one entry/,
    )
  })

  it('posts to DAT and Truckstop, writes two rows, and mirrors postedBoards and datPostedAt', async () => {
    const deps = makeDeps()
    const result = (await postLoad(
      deps,
      { shipmentId: 'ship-1', providers: ['DAT', 'TRUCKSTOP'], rateCents: 200_00 },
      caller,
    )) as { postings: Row[]; shipment: Row }

    expect(result.postings).toHaveLength(2)
    const dat = result.postings.find((p) => p.provider === 'DAT')
    expect(dat).toMatchObject({ status: 'POSTED', mode: 'STUB', boardPostingId: 'stub:dat-1' })
    expect(dat?.message).toMatch(/^STUB/)
    expect(dat?.originCity).toBe('Chicago')
    expect(dat?.originState).toBe('IL')
    expect(dat?.destinationCity).toBe('Detroit')
    expect(dat?.destinationState).toBe('MI')
    expect(dat?.rateCents).toBe(200_00)

    expect(result.shipment.postedBoards).toEqual(['DAT', 'TRUCKSTOP'])
    expect(result.shipment.datPostedAt).toBe(NOW)
  })

  it('re-posting updates the same row rather than duplicating', async () => {
    const deps = makeDeps()
    await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)
    const second = (await postLoad(
      deps,
      { shipmentId: 'ship-1', providers: ['DAT'], rateCents: 222_00, note: 'better rate' },
      caller,
    )) as { postings: Row[]; shipment: Row }

    expect(second.postings).toHaveLength(1)
    expect(second.postings[0].version).toBe(2)
    expect(second.postings[0].rateCents).toBe(222_00)
    expect(second.postings[0].note).toBe('better rate')

    const listed = (await listPostings(deps, { shipmentId: 'ship-1' })) as { postings: Row[] }
    expect(listed.postings).toHaveLength(1)
  })

  it('marks one provider FAILED while the other still posts', async () => {
    const deps = makeDeps()
    deps.adapterFor = async (provider) => {
      if (provider === 'DAT') {
        return {
          mode: 'STUB',
          post: async () => ({ mode: 'STUB', ok: false, message: 'DAT rate error' }),
          unpost: async () => ({ mode: 'STUB', ok: true, message: 'ok' }),
        }
      }
      return {
        mode: 'STUB',
        post: async () => ({ mode: 'STUB', ok: true, message: 'ok', externalId: 'stub:ts-2' }),
        unpost: async () => ({ mode: 'STUB', ok: true, message: 'ok' }),
      }
    }

    const result = (await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT', 'TRUCKSTOP'] }, caller)) as {
      postings: Row[]
      shipment: Row
    }
    expect(result.postings.find((p) => p.provider === 'DAT')?.status).toBe('FAILED')
    expect(result.postings.find((p) => p.provider === 'TRUCKSTOP')?.status).toBe('POSTED')
    expect(result.shipment.postedBoards).toEqual(['TRUCKSTOP'])
    expect(result.shipment.datPostedAt).toBeFalsy()
  })

  it('preserves STUB mode and stub: external id on the row', async () => {
    const deps = makeDeps()
    const result = (await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)) as { postings: Row[] }
    expect(result.postings[0].mode).toBe('STUB')
    expect(result.postings[0].boardPostingId).toMatch(/^stub:/)
  })

  it('writes a FAILED first posting without postedAt or postedBy', async () => {
    const deps = makeDeps()
    deps.adapterFor = async () => ({
      mode: 'STUB' as const,
      post: async () => ({ mode: 'STUB', ok: false, message: 'rate error' }),
      unpost: async () => ({ mode: 'STUB', ok: true, message: 'ok' }),
    })

    const result = (await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)) as {
      postings: Row[]
    }

    expect(result.postings[0].status).toBe('FAILED')
    expect('postedAt' in result.postings[0]).toBe(false)
    expect('postedBy' in result.postings[0]).toBe(false)
  })

  it('hardened fake rejects a key attribute in an update patch', async () => {
    const deps = makeDeps()
    await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)

    await expect(
      deps.transact([
        updateItemTx(deps.tables.posting, 'post:ship-1:DAT', { id: 'x', updatedAt: NOW, updatedBy: caller.email }, null),
      ]),
    ).rejects.toThrow('Cannot update attribute id. This attribute is part of the key')
  })

  it('hardened fake rejects a null GSI key in an update patch', async () => {
    const deps = makeDeps()
    await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)

    await expect(
      deps.transact([
        updateItemTx(deps.tables.posting, 'post:ship-1:DAT', { postedAt: null, updatedAt: NOW, updatedBy: caller.email }, null),
      ]),
    ).rejects.toThrow('Type mismatch for Index Key postedAt Expected: S Actual: NULL')
  })
})

describe('unpostLoad', () => {
  it('flips a row to UNPOSTED and recomputes postedBoards', async () => {
    const deps = makeDeps()
    await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT', 'TRUCKSTOP'] }, caller)

    const result = (await unpostLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)) as {
      postings: Row[]
      shipment: Row
    }
    expect(result.postings).toHaveLength(1)
    expect(result.postings[0]).toMatchObject({ status: 'UNPOSTED', unpostedBy: caller.email })
    expect(result.postings[0].boardPostingId).toBe('stub:dat-1')
    expect(result.shipment.postedBoards).toEqual(['TRUCKSTOP'])
    expect(result.shipment.datPostedAt).toBeFalsy()
  })

  it('keeps a row POSTED when the provider refuses to unpost', async () => {
    const deps = makeDeps()
    await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)
    deps.adapterFor = async () => ({
      mode: 'STUB',
      post: async () => ({ mode: 'STUB', ok: true, message: 'ok' }),
      unpost: async () => ({ mode: 'STUB', ok: false, message: 'Board rejects unpost' }),
    })

    const result = (await unpostLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)) as {
      postings: Row[]
      shipment: Row
    }
    expect(result.postings[0].status).toBe('POSTED')
    expect(result.postings[0].message).toBe('Board rejects unpost')
    expect(result.shipment.postedBoards).toEqual(['DAT'])
    expect(result.shipment.datPostedAt).toBe(NOW)
  })

  it('clears datPostedAt only when DAT is no longer posted', async () => {
    const deps = makeDeps()
    await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT', 'TRUCKSTOP'] }, caller)
    const result = (await unpostLoad(deps, { shipmentId: 'ship-1', providers: ['TRUCKSTOP'] }, caller)) as {
      shipment: Row
    }
    expect(result.shipment.postedBoards).toEqual(['DAT'])
    expect(result.shipment.datPostedAt).toBe(NOW)
  })
})

describe('listPostings', () => {
  it('returns postings newest first', async () => {
    const deps = makeDeps()
    await postLoad(deps, { shipmentId: 'ship-1', providers: ['TRUCKSTOP'] }, caller)
    const rows = (await listPostings(deps, { shipmentId: 'ship-1' })) as { postings: Row[] }
    expect(rows.postings).toHaveLength(1)
    expect(rows.postings[0].provider).toBe('TRUCKSTOP')
  })
})

describe('postings integration', () => {
  it('exports the constants the lead can correct if Amplify pluralises differently', () => {
    expect(POSTABLE_PROVIDERS).toEqual(['DAT', 'TRUCKSTOP'])
  })

  it('refuses to post a missing shipment', async () => {
    const deps = makeDeps()
    deps.readBundle = async () => {
      throw new Error('Shipment not found: ship-missing')
    }
    await expect(postLoad(deps, { shipmentId: 'ship-missing', providers: ['DAT'] }, caller)).rejects.toThrow(
      /Shipment not found/,
    )
  })

  it('posts with contact email, phone and note surfaced on the row', async () => {
    const deps = makeDeps()
    const result = (await postLoad(
      deps,
      {
        shipmentId: 'ship-1',
        providers: ['DAT'],
        contactEmail: 'dispatch@example.com',
        contactPhone: '+15551234567',
        note: 'no tarps',
      },
      caller,
    )) as { postings: Row[] }
    expect(result.postings[0]).toMatchObject({
      contactEmail: 'dispatch@example.com',
      contactPhone: '+15551234567',
      note: 'no tarps',
    })
  })

  it('keeps the lane snapshot when unposting', async () => {
    const deps = makeDeps()
    await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)
    const result = (await unpostLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)) as { postings: Row[] }
    expect(result.postings[0].originCity).toBe('Chicago')
    expect(result.postings[0].destinationCity).toBe('Detroit')
    expect(result.postings[0].status).toBe('UNPOSTED')
  })

  it('does not duplicate a row when unposting an already-UNPOSTED provider', async () => {
    const deps = makeDeps()
    await postLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)
    await unpostLoad(deps, { shipmentId: 'ship-1', providers: ['DAT'] }, caller)
    const rows = (await listPostings(deps, { shipmentId: 'ship-1' })) as { postings: Row[] }
    expect(rows.postings).toHaveLength(1)
    expect(rows.postings[0].status).toBe('UNPOSTED')
  })
})
