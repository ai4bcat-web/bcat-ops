import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fxBill, FX_CARRIER } from '../../../src/lib/apInbox/fixtures'
import type { ApRunDigest } from '../../../src/lib/apInbox/types'
import { buildLedger } from './ledger'
import { chicagoParts, runSync, scheduleDue } from './sync'
import { hoursAgo, makeSyncKit, pdf, rawInvoice } from './testkit'

describe('Chicago hour gate', () => {
  it('reads the Chicago hour across both DST transitions', () => {
    expect(chicagoParts(new Date('2026-10-30T11:00:00Z'))).toEqual({ day: '2026-10-30', hour: 6 }) // CDT
    expect(chicagoParts(new Date('2026-11-04T12:00:00Z'))).toEqual({ day: '2026-11-04', hour: 6 }) // CST
    expect(chicagoParts(new Date('2026-11-04T11:00:00Z'))).toEqual({ day: '2026-11-04', hour: 5 })
    expect(chicagoParts(new Date('2026-03-08T07:59:00Z'))).toEqual({ day: '2026-03-08', hour: 1 }) // the hour that is skipped next
    expect(chicagoParts(new Date('2026-03-08T08:00:00Z'))).toEqual({ day: '2026-03-08', hour: 3 })
    expect(chicagoParts(new Date('2026-11-04T05:59:00Z'))).toEqual({ day: '2026-11-03', hour: 23 }) // a UTC day earlier than the Chicago day
  })

  it('runs once a day at or after the configured hour, and to finish a partial run', () => {
    const cfg = { runHourChicago: 6 }
    const at = (iso: string) => new Date(iso)
    expect(scheduleDue(at('2026-11-04T11:00:00Z'), cfg, { runs: [] })).toBe(false) // 05:00
    expect(scheduleDue(at('2026-11-04T12:00:00Z'), cfg, { runs: [] })).toBe(true) // 06:00
    expect(scheduleDue(at('2026-11-04T20:00:00Z'), cfg, { runs: [], lastScheduledDay: '2026-11-04' })).toBe(false)
    // Catch-up after an outage: yesterday's run is done, today's has not happened, it is 14:00.
    expect(scheduleDue(at('2026-11-04T20:00:00Z'), cfg, { runs: [], lastScheduledDay: '2026-11-03' })).toBe(true)
    const partial = { partial: true } as ApRunDigest
    expect(scheduleDue(at('2026-11-04T08:00:00Z'), cfg, { runs: [partial], lastScheduledDay: '2026-11-04' })).toBe(true)
    expect(scheduleDue(at('2026-11-04T08:00:00Z'), cfg, { runs: [{ ...partial, error: 'MODEL_CAP' }], lastScheduledDay: '2026-11-04' })).toBe(false)
  })

  it('the hourly door is a no-op outside the window and marks the day done after a complete run', async () => {
    const kit = makeSyncKit({ bills: [fxBill({ shipmentNumber: 'S000101-1' })], carriers: [FX_CARRIER] }, { model: () => rawInvoice() })
    await kit.inject({ id: 'zz-1', from: 'b@x.example', subject: 'inv', body: 'Invoice $1,500.50', internalDate: hoursAgo(1), attachments: [pdf('a.pdf')] })

    kit.deps.now = () => new Date('2026-11-04T10:00:00Z') // 04:00 Chicago
    expect(await runSync(kit.deps, { trigger: 'SCHEDULE', budgetMs: 60_000 })).toMatchObject({ skipped: 'NOT_DUE', digest: null })
    expect(kit.modelCalls).toHaveLength(0)
    expect(kit.mem.getStateNow().runs).toEqual([])

    kit.deps.now = () => new Date('2026-11-04T15:00:00Z')
    const ran = await runSync(kit.deps, { trigger: 'SCHEDULE', budgetMs: 60_000 })
    expect(ran.digest).toMatchObject({ trigger: 'SCHEDULE', invoices: 1, applied: 1 })
    expect(kit.mem.getStateNow().lastScheduledDay).toBe('2026-11-04')
    expect(await runSync(kit.deps, { trigger: 'SCHEDULE', budgetMs: 60_000 })).toMatchObject({ skipped: 'NOT_DUE' })
  })

  it('a partial scheduled run is continued by the next hourly check even outside the window', async () => {
    const kit = makeSyncKit({ bills: [fxBill({ shipmentNumber: 'S000101-1' })], carriers: [FX_CARRIER] }, { model: () => rawInvoice() })
    await kit.inject({ id: 'zz-1', from: 'b@x.example', subject: 'inv', body: 'Invoice $1,500.50', internalDate: hoursAgo(1), attachments: [pdf('a.pdf')] })
    kit.deps.now = () => new Date('2026-11-04T15:00:00Z')
    const first = await runSync(kit.deps, { trigger: 'SCHEDULE', budgetMs: 0 })
    expect(first.done).toBe(false)
    expect(kit.mem.getStateNow().lastScheduledDay).toBeUndefined()
    kit.deps.now = () => new Date('2026-11-04T16:00:00Z')
    expect((await runSync(kit.deps, { trigger: 'SCHEDULE', budgetMs: 60_000 })).digest).toMatchObject({ invoices: 1, partial: false })
    expect(kit.mem.getStateNow().lastScheduledDay).toBe('2026-11-04')
  })
})

describe('ledger mapping', () => {
  it('keeps only open bills and awaiting assignments, and reads the Aljex PRO from the load', () => {
    const ledger = buildLedger({
      bills: [
        { id: 'b1', status: 'IN_REVIEW', loadId: 'l1', carrierId: 'c1', version: 2, billNumber: 'A123', billedCents: 5, grossCents: 5, remitTo: '{"name":"Pay Co"}' },
        { id: 'b2', status: 'VOID', loadId: 'l1' },
      ],
      assignments: [{ id: 'lc1', apStatus: 'AWAITING_INVOICE', loadId: 'l1', shipmentId: 's1', carrierRateCents: 900, costCents: 800, tripNumber: 'T9' }, { id: 'lc2', apStatus: 'TO_BE_PAID' }],
      vendors: [{ id: 'v1', status: 'NEED_TO_PAY', amount: 100 }, { id: 'v2', status: 'DONE' }],
      loads: { l1: { id: 'l1', aljexId: 'A123', pickupNumber: 'PU1', tmsId: 'T-1' } },
      shipments: { s1: { id: 's1', number: 'S1-1' } },
      carriers: { c1: { id: 'c1', name: 'Swift', mcNumber: '12' } },
    })
    expect(ledger.bills).toEqual([expect.objectContaining({ id: 'b1', aljexId: 'A123', refs: ['PU1', 'T-1'], remitToName: 'Pay Co' })])
    expect(ledger.assignments).toEqual([expect.objectContaining({ loadCarrierId: 'lc1', rateCents: 900, shipmentNumber: 'S1-1', refs: ['PU1', 'T-1', 'T9'] })])
    expect(ledger.vendorPayables.map((v) => v.id)).toEqual(['v1'])
    expect(ledger.carriers.c1).toMatchObject({ name: 'Swift', mcNumber: '12' })
  })
})

describe('what tms-ap-inbox may import', () => {
  it('has no path to approve, pay, void or record a bill, and no mailbox write method', () => {
    // A safety property: the Lambda changes AP rows only through the store's two allow-listed writes.
    const dir = __dirname
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    for (const file of sources) {
      const text = readFileSync(join(dir, file), 'utf8')
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1])
      expect(imports.filter((i) => /tms-finance-actions|carrierBill$|apPayments|client-ses|client-sesv2|bedrock/i.test(i) && !/apInbox/.test(i))).toEqual([])
    }
    const mailbox = readFileSync(join(dir, '../../../src/lib/apInbox/mailbox.ts'), 'utf8')
    expect(mailbox).toContain('FORBIDDEN_MAILBOX_METHODS')
  })
})
