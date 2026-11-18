import { describe, expect, it, vi } from 'vitest'
import { ensureDeliveredLaneSamples, ensureLaneSampleForLoad, type LaneSampleDeps } from './laneSamples'

const stops = JSON.stringify([
  { type: 'pickup', sequence: 0, appt: '2026-11-10T14:00:00.000Z' },
  { type: 'delivery', sequence: 1, appt: '2026-11-11T21:00:00.000Z', departedAt: '2026-11-12T03:30:00.000Z' },
])

const money = { revenueCents: 150000, costCents: 110000, profitCents: 40000 }
const current = { id: 'lrs:l1', date: '2026-11-11', ...money, revDivision: 'BROKERAGE', salesRepId: 'rep-1' }
const shipment = { id: 's1', revDivision: 'BROKERAGE', salesRepId: 'rep-1' }

function fake(sample: Record<string, unknown> | null, extra: Record<string, Record<string, unknown> | null> = {}) {
  const rows: Record<string, Record<string, unknown> | null> = { LRS: sample, FIN: { id: 'l1', loadId: 'l1', ...money }, SHIP: shipment, ...extra }
  const getById = vi.fn(async (table: string, _id: string) => rows[table] ?? null)
  const send = vi.fn()
  const deps = {
    tables: { laneSample: 'LRS', load: 'LOAD', loadFinancials: 'FIN', shipment: 'SHIP' },
    store: { tables: {} },
    getById,
    queryIndex: vi.fn(async () => []),
    getSettings: vi.fn(async () => null),
    db: { send },
  } as unknown as LaneSampleDeps
  return { deps, getById }
}

const delivered = { id: 'l1', shipmentId: 's1', status: 'DELIVERED', stops }
const bundle = { loads: [delivered], shipment, financials: [{ id: 'l1', loadId: 'l1', ...money }] }
const wrote = (getById: ReturnType<typeof vi.fn>) => getById.mock.calls.some((c) => c[0] === 'LOAD' && c[1] === 'l1')

describe('ensureDeliveredLaneSamples', () => {
  it('leaves a sample alone when it is current: the delivered day (Chicago), the money, the tag and the rep', async () => {
    const { deps, getById } = fake(current)
    await ensureDeliveredLaneSamples(deps, bundle)
    // 03:30Z on the 12th is 9:30 pm on the 11th in Chicago; the bundle already holds the money and the shipment.
    expect(getById.mock.calls.map((c) => c[0])).toEqual(['LRS'])
  })

  it('reads the money and the shipment itself when the caller holds neither', async () => {
    const { deps, getById } = fake(current)
    await ensureDeliveredLaneSamples(deps, { loads: [delivered] })
    expect(getById.mock.calls.map((c) => c[0]).sort()).toEqual(['FIN', 'LRS', 'SHIP'])
    expect(wrote(getById)).toBe(false)
  })

  it('writes again when the sample is missing', async () => {
    const { deps, getById } = fake(null)
    await ensureDeliveredLaneSamples(deps, bundle)
    expect(wrote(getById)).toBe(true)
  })

  it('writes again when the sample sits on another day than the delivered day', async () => {
    const { deps, getById } = fake({ ...current, date: '2026-10-30' })
    await ensureDeliveredLaneSamples(deps, { ...bundle, loads: [{ ...delivered, deliveredAt: '2026-11-02T12:00:00.000Z', stops: JSON.stringify([{ type: 'delivery', sequence: 1 }]) }] })
    expect(wrote(getById)).toBe(true)
  })

  it('writes again when the carrier cost was recorded after the sample was taken', async () => {
    const { deps, getById } = fake({ ...current, costCents: 0, profitCents: 150000 })
    await ensureDeliveredLaneSamples(deps, bundle)
    expect(wrote(getById)).toBe(true)
  })

  it('writes again when the load was re-tagged or re-assigned after the sample was taken', async () => {
    const retagged = fake(current)
    await ensureDeliveredLaneSamples(retagged.deps, { ...bundle, shipment: { ...shipment, revDivision: 'CAR_SHIPPING' } })
    expect(wrote(retagged.getById)).toBe(true)
    const reassigned = fake(current)
    await ensureDeliveredLaneSamples(reassigned.deps, { ...bundle, loads: [{ ...delivered, salesRepId: 'rep-2' }] })
    expect(wrote(reassigned.getById)).toBe(true)
  })

  it('never samples a voided or deleted shipment', async () => {
    const { deps, getById } = fake(null)
    await ensureDeliveredLaneSamples(deps, { ...bundle, shipment: { ...shipment, voidedAt: '2026-11-12T00:00:00Z' } })
    await ensureDeliveredLaneSamples(deps, { ...bundle, shipment: { ...shipment, deletedAt: '2026-11-12T00:00:00Z' } })
    expect(getById).not.toHaveBeenCalled()
  })

  it('skips a load that is not delivered yet, a voided one, and a stack without the sample table', async () => {
    const { deps, getById } = fake(null)
    await ensureDeliveredLaneSamples(deps, { loads: [{ id: 'a', status: 'IN_TRANSIT', stops }, { id: 'b', status: 'DELIVERED', stops, voidedAt: '2026-11-12T00:00:00Z' }] })
    expect(getById).not.toHaveBeenCalled()
    const noTable = { ...deps, tables: { ...deps.tables, laneSample: '' } } as LaneSampleDeps
    await ensureDeliveredLaneSamples(noTable, { loads: [{ id: 'c', status: 'DELIVERED', stops }] })
    expect(getById).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    const getById = vi.fn(async () => { throw new Error('boom') })
    const deps = { tables: { laneSample: 'LRS' }, getById } as unknown as LaneSampleDeps
    await expect(ensureDeliveredLaneSamples(deps, { loads: [{ id: 'l1', status: 'DELIVERED', stops }] })).resolves.toBeUndefined()
  })
})

describe('ensureLaneSampleForLoad', () => {
  it('writes the sample of a load the stream just showed delivered, once', async () => {
    const missing = fake(null)
    expect(await ensureLaneSampleForLoad(missing.deps, delivered)).toBe(true)
    expect(wrote(missing.getById)).toBe(true)
    const done = fake(current)
    expect(await ensureLaneSampleForLoad(done.deps, delivered)).toBe(false)
  })

  it('does nothing for a load that is not delivered, has no shipment, or belongs to a voided one', async () => {
    const { deps, getById } = fake(null)
    expect(await ensureLaneSampleForLoad(deps, { ...delivered, status: 'IN_TRANSIT' })).toBe(false)
    expect(await ensureLaneSampleForLoad(deps, { ...delivered, shipmentId: '' })).toBe(false)
    expect(getById).not.toHaveBeenCalled()
    const voided = fake(null, { SHIP: { ...shipment, voidedAt: '2026-11-12T00:00:00Z' } })
    expect(await ensureLaneSampleForLoad(voided.deps, delivered)).toBe(false)
    expect(wrote(voided.getById)).toBe(false)
  })

  it('never throws', async () => {
    const deps = { tables: { laneSample: 'LRS' }, getById: vi.fn(async () => { throw new Error('boom') }) } as unknown as LaneSampleDeps
    await expect(ensureLaneSampleForLoad(deps, delivered)).resolves.toBe(false)
  })
})
