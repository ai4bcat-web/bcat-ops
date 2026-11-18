import { describe, expect, it, vi } from 'vitest'
import { ensureDeliveredLaneSamples } from './laneSamples'
import type { QuoteDeps } from './quotes'

const stops = JSON.stringify([
  { type: 'pickup', sequence: 0, appt: '2026-11-10T14:00:00.000Z' },
  { type: 'delivery', sequence: 1, appt: '2026-11-11T21:00:00.000Z', departedAt: '2026-11-12T03:30:00.000Z' },
])

function fake(sample: Record<string, unknown> | null) {
  const getById = vi.fn(async (table: string, _id: string) => (table === 'LRS' ? sample : null))
  const send = vi.fn()
  const deps = { tables: { laneSample: 'LRS', load: 'LOAD', loadFinancials: 'FIN', shipment: 'SHIP' }, getById, db: { send } } as unknown as QuoteDeps
  return { deps, getById, send }
}

describe('ensureDeliveredLaneSamples', () => {
  it('leaves a sample alone when it is already dated on the delivered day (Chicago)', async () => {
    const { deps, getById } = fake({ id: 'lrs:l1', date: '2026-11-11' })
    await ensureDeliveredLaneSamples(deps, { loads: [{ id: 'l1', status: 'DELIVERED', stops }] })
    // 03:30Z on the 12th is 9:30 pm on the 11th in Chicago.
    expect(getById.mock.calls.map((c) => c[0])).toEqual(['LRS'])
  })

  it('writes again when the sample is missing', async () => {
    const { deps, getById } = fake(null)
    await ensureDeliveredLaneSamples(deps, { loads: [{ id: 'l1', status: 'DELIVERED', stops }] })
    expect(getById).toHaveBeenCalledWith('LOAD', 'l1')
  })

  it('writes again when the sample sits on another day than the delivered day', async () => {
    const { deps, getById } = fake({ id: 'lrs:l1', date: '2026-10-30' })
    await ensureDeliveredLaneSamples(deps, { loads: [{ id: 'l1', status: 'DELIVERED', stops, deliveredAt: '2026-11-02T12:00:00.000Z' }] })
    expect(getById).toHaveBeenCalledWith('LOAD', 'l1')
  })

  it('skips a load that is not delivered yet, a voided one, and a stack without the sample table', async () => {
    const { deps, getById } = fake(null)
    await ensureDeliveredLaneSamples(deps, { loads: [{ id: 'a', status: 'IN_TRANSIT', stops }, { id: 'b', status: 'DELIVERED', stops, voidedAt: '2026-11-12T00:00:00Z' }] })
    expect(getById).not.toHaveBeenCalled()
    const noTable = { ...deps, tables: { ...deps.tables, laneSample: '' } } as QuoteDeps
    await ensureDeliveredLaneSamples(noTable, { loads: [{ id: 'c', status: 'DELIVERED', stops }] })
    expect(getById).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    const getById = vi.fn(async () => { throw new Error('boom') })
    const deps = { tables: { laneSample: 'LRS' }, getById } as unknown as QuoteDeps
    await expect(ensureDeliveredLaneSamples(deps, { loads: [{ id: 'l1', status: 'DELIVERED', stops }] })).resolves.toBeUndefined()
  })
})
