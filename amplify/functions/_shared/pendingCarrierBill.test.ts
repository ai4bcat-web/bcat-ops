import { describe, expect, it } from 'vitest'
import { PENDING_DATES_BLOCK, approvalReadiness } from '../../../src/lib/carrierBill'
import { pendingBillId, planPendingCarrierBills, writePendingBill, type PendingBillInput } from './pendingCarrierBill'

const NOW = '2026-11-12T15:00:00.000Z'
const TODAY = '2026-11-12'

function carrierLeg(over: Record<string, unknown> = {}) {
  return {
    id: 'lc-1', loadId: 'lod-1', shipmentId: 'shp-1', kind: 'CARRIER', status: 'ACTIVE',
    carrierId: 'car-1', carrierName: 'SHERIFAJ TRUCKING INC', apStatus: 'AWAITING_INVOICE', invoiceId: null,
    ...over,
  }
}
const charge = (over: Record<string, unknown> = {}) => ({
  id: 'chg-1', shipmentId: 'shp-1', loadId: 'lod-1', loadCarrierId: 'lc-1', side: 'CARRIER', code: 'LINEHAUL',
  label: 'Linehaul', calculatedBy: 'FLAT', rateCents: 140_000, count: 1, amountCents: 140_000, sortOrder: 1, ...over,
})

function input(over: Partial<PendingBillInput> = {}): PendingBillInput {
  return {
    shipment: { id: 'shp-1', number: '20027' },
    loads: [{ id: 'lod-1', loadNumber: '20027', status: 'DELIVERED', divisionKey: 'ASSETS' }],
    loadCarriers: [carrierLeg()],
    charges: [charge()],
    carriersById: new Map([['car-1', { id: 'car-1', name: 'SHERIFAJ TRUCKING INC', mcNumber: '123', paymentTermsDays: 30 }]]),
    methodsByCarrierId: new Map(),
    settings: null,
    today: TODAY,
    now: NOW,
    actorEmail: 'ryne@bcatcorp.com',
    ...over,
  }
}

describe('planPendingCarrierBills', () => {
  it('plans one bill for an outside carrier leg, from its carrier lines, with the dates pending', () => {
    const { create, skipped } = planPendingCarrierBills(input())
    expect(skipped).toEqual([])
    expect(create).toHaveLength(1)
    expect(create[0].bill).toMatchObject({
      id: 'cb:lc-1:1', loadCarrierId: 'lc-1', carrierId: 'car-1', carrierName: 'SHERIFAJ TRUCKING INC',
      status: 'IN_REVIEW', datesPending: true, billNumber: null, billDate: TODAY, billMonth: '2026-11',
      dueAt: '2026-12-12', termsDays: 30, grossCents: 140_000, netCents: 140_000, billedCents: 140_000,
      varianceCents: 0, balanceCents: 140_000, apOpen: 'OPEN', recordedBy: 'ryne@bcatcorp.com', recordedEarly: false,
    })
  })

  it('takes the due date from the carrier’s terms', () => {
    const { create } = planPendingCarrierBills(input({
      carriersById: new Map([['car-1', { id: 'car-1', name: 'S', paymentTermsDays: 15 }]]),
    }))
    expect(create[0].bill.termsDays).toBe(15)
    expect(create[0].bill.dueAt).toBe('2026-11-27')
  })

  it('never bills an own-fleet leg, a bounced leg, or a leg that already has a bill', () => {
    const { create, skipped } = planPendingCarrierBills(input({
      loadCarriers: [
        carrierLeg({ id: 'lc-own', kind: 'OWN_ASSET' }),
        carrierLeg({ id: 'lc-bounced', status: 'BOUNCED' }),
        carrierLeg({ id: 'lc-billed', invoiceId: 'cb:lc-billed:1', apStatus: 'IN_REVIEW' }),
        carrierLeg({ id: 'lc-paid', apStatus: 'PAID' }),
      ],
    }))
    expect(create).toEqual([])
    expect(skipped.map((s) => [s.loadCarrierId, s.kind])).toEqual([['lc-billed', 'ALREADY_BILLED'], ['lc-paid', 'ALREADY_BILLED']])
  })

  it('treats a leg whose apStatus was never set as awaiting its bill', () => {
    const { create } = planPendingCarrierBills(input({ loadCarriers: [carrierLeg({ apStatus: null })] }))
    expect(create).toHaveLength(1)
  })

  it('reports, instead of refusing, a leg with no carrier charges or no directory carrier', () => {
    const { create, skipped } = planPendingCarrierBills(input({
      charges: [],
      loadCarriers: [carrierLeg(), carrierLeg({ id: 'lc-2', carrierId: 'car-missing' })],
    }))
    expect(create).toEqual([])
    expect(skipped.map((s) => s.kind)).toEqual(['NOT_BILLABLE', 'NOT_BILLABLE'])
    expect(skipped[0].reasons.join(' ')).toMatch(/no carrier charges/)
  })

  it('bills each carrier on a two-carrier load for its own lines only', () => {
    const { create } = planPendingCarrierBills(input({
      loadCarriers: [carrierLeg(), carrierLeg({ id: 'lc-2', carrierId: 'car-2', carrierName: 'HEARTLAND' })],
      charges: [charge(), charge({ id: 'chg-2', loadCarrierId: 'lc-2', rateCents: 20_000, amountCents: 20_000 })],
      carriersById: new Map([['car-1', { id: 'car-1', name: 'A' }], ['car-2', { id: 'car-2', name: 'B' }]]),
    }))
    expect(create.map((c) => [c.bill.id, c.bill.grossCents])).toEqual([['cb:lc-1:1', 140_000], ['cb:lc-2:1', 20_000]])
  })

  it('freezes the carrier’s payee when it has one payment method', () => {
    const { create } = planPendingCarrierBills(input({
      methodsByCarrierId: new Map([['car-1', [{ id: 'pm-1', carrierId: 'car-1', method: 'ACH', isPreferred: true, status: 'ACTIVE', payeeName: 'Sherifaj' }]]]),
    }))
    expect(create[0].bill.paymentMethodId).toBe('pm-1')
  })

  it('names the bill the way RECORD_BILL numbers the first one', () => {
    expect(pendingBillId('lc-9')).toBe('cb:lc-9:1')
  })
})

describe('approval of a bill with pending dates', () => {
  it('is blocked until the invoice date and due date are set', () => {
    const base = {
      status: 'IN_REVIEW' as const, varianceCents: 0, billedCents: 100, grossCents: 100, recordedEarly: false, docsOverrideAt: null,
    }
    const args = {
      loadCarrier: { status: 'ACTIVE' as const, rateConStatus: 'SIGNED' as const },
      load: { id: 'l', status: 'DELIVERED' as const, loadNumber: '1' },
      gate: { missing: [] },
      payee: { kind: 'CARRIER' as const, paymentMethodId: null, remitTo: { name: 'X' } },
      settings: null,
      isAdmin: true,
    }
    expect(approvalReadiness({ bill: { ...base, datesPending: true }, ...args }).blocks).toContain(PENDING_DATES_BLOCK)
    expect(approvalReadiness({ bill: { ...base, datesPending: false }, ...args }).blocks).not.toContain(PENDING_DATES_BLOCK)
  })
})

describe('writePendingBill', () => {
  function fakeDb(script: Array<'ok' | 'conflict'>, loadCarrierRow: Record<string, unknown> | null) {
    const sent: unknown[] = []
    let i = 0
    return {
      sent,
      db: {
        send: async (command: { constructor: { name: string }; input: unknown }) => {
          sent.push(command)
          if (command.constructor.name === 'GetItemCommand') {
            const { marshall } = await import('@aws-sdk/util-dynamodb')
            return { Item: loadCarrierRow ? marshall(loadCarrierRow) : undefined }
          }
          const step = script[i++] ?? 'ok'
          if (step === 'conflict') throw new Error('TransactionCanceledException: ConditionalCheckFailed')
          return {}
        },
      } as never,
    }
  }
  const tables = { carrier: 'carrier', carrierPaymentMethod: 'pm', carrierBill: 'bill', loadCarrier: 'lc' }
  const plan = () => planPendingCarrierBills(input()).create[0]

  it('writes the bill and the assignment in one transaction', async () => {
    const { db, sent } = fakeDb(['ok'], null)
    expect(await writePendingBill(db, tables, plan(), NOW, 'ryne@bcatcorp.com')).toBe(true)
    const tx = sent[0] as { input: { TransactItems: Array<{ Put?: unknown; Update?: { ConditionExpression: string } }> } }
    expect(tx.input.TransactItems).toHaveLength(2)
    expect(tx.input.TransactItems[0].Put).toBeTruthy()
    expect(tx.input.TransactItems[1].Update?.ConditionExpression).toMatch(/AWAITING|awaiting/)
  })

  it('reports false, writing nothing more, when somebody billed the assignment first', async () => {
    const { db, sent } = fakeDb(['conflict'], { id: 'lc-1', invoiceId: 'cb:lc-1:1', apStatus: 'IN_REVIEW' })
    expect(await writePendingBill(db, tables, plan(), NOW, 'ryne@bcatcorp.com')).toBe(false)
    expect(sent.filter((c) => (c as { constructor: { name: string } }).constructor.name === 'TransactWriteItemsCommand')).toHaveLength(1)
  })

  it('takes the next bill number when an earlier, voided bill holds the first', async () => {
    const { db, sent } = fakeDb(['conflict', 'ok'], { id: 'lc-1', invoiceId: null, apStatus: 'AWAITING_INVOICE' })
    expect(await writePendingBill(db, tables, plan(), NOW, 'ryne@bcatcorp.com')).toBe(true)
    const writes = sent.filter((c) => (c as { constructor: { name: string } }).constructor.name === 'TransactWriteItemsCommand') as Array<{ input: { TransactItems: Array<{ Put?: { Item: { id: { S: string } } } }> } }>
    expect(writes.map((w) => w.input.TransactItems[0].Put?.Item.id.S)).toEqual(['cb:lc-1:1', 'cb:lc-1:2'])
  })
})
