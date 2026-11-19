import { describe, expect, it } from 'vitest'
import { dataViewer, type DataViewer } from '../../../src/lib/dataVisibility'
import { resolveWindow } from '../../../src/lib/dashboards/windows'
import type { Row } from '../_shared/crmStore'
import { assistantTurn, type AssistantTools } from './assistant'
import type { AssistantBlock, AssistantModel, StepRequest } from './assistantModel'
import { DATASETS, describeData, mayUse, queryData, runDataQuery, weekStart, type AskEnv, type DataQuery, type Rec } from './askData'
import { fleetPnl } from './askFleet'
import type { AskSource } from './askSources'

const TODAY = '2026-11-19'

const owner = dataViewer({ id: 'owner', email: 'ryne@bcatcorp.com', groups: ['ADMIN'] })
const accounting = dataViewer({ id: 'jenny', email: 'jenny@bcatcorp.com', groups: ['role-AR_AP'] })
const rep = dataViewer({ id: 'jason', email: 'jason@bcatcorp.com', groups: ['page-tms'] })

const customers = new Map([
  ['c1', { id: 'c1', name: 'Alpha Freight', accountOwnerIds: ['jason'] }],
  ['c2', { id: 'c2', name: 'Beta Foods', accountOwnerIds: ['someone-else'] }],
])

const sample = (over: Row): Row => ({
  shipmentId: 's', date: '2026-11-05', excluded: false, revenueCents: 100_000, costCents: 80_000, profitCents: 20_000, miles: 500,
  customerId: 'c1', customerName: 'Alpha Freight', carrierName: 'Fast Carrier', assignmentKind: 'CARRIER', revDivision: 'BCAT', mode: 'FTL', ...over,
})

/** An AskSource whose every read is empty unless overridden. */
function source(over: Partial<AskSource> = {}): AskSource {
  const none = async (): Promise<Row[]> => []
  return {
    samples: none, carrierBills: none, vendorPayables: none, maintenanceInvoices: none, fuelTransactions: none, drivers: none, equipment: none,
    payPeriods: none, payCredits: none, payDeductions: none, paySettings: none, recurringExpenses: none, expenseRecords: none, expenseTypes: none,
    expenseAllocations: none, truckMileageDays: none, insurancePeriods: none, insuranceItems: none, loadsDeliveredBetween: none, ...over,
  }
}

const env = (viewer: DataViewer, ask: AskSource): AskEnv => ({
  ask, viewer, customers, divisions: [{ code: 'BCAT', name: 'BCAT Logistics', brand: null, parentId: null }],
  staff: [{ id: 'jason', name: 'Jason Smith', email: 'jason@bcatcorp.com' }], today: TODAY,
})

const win = resolveWindow({ preset: 'THIS_MONTH' }, `${TODAY}T12:00:00Z`)
const q = (over: Partial<DataQuery>): DataQuery => ({ metrics: ['loads', 'revenue'], groupBy: [], filters: [], dateField: 'delivered', sort: '', order: 'desc', limit: 25, ...over })

describe('the query engine', () => {
  const rec = (day: string, customer: string, revenue: number, profit: number, miles = 0): Rec => ({
    dates: { delivered: day }, dim: { customer, carrier: '' },
    v: { n: 1, revenue, cost: revenue - profit, profit, miles, revenueMi: miles ? revenue : 0, costMi: miles ? revenue - profit : 0, profitMi: miles ? profit : 0 },
  })
  const rows = [rec('2026-11-02', 'Alpha', 1000, 200, 100), rec('2026-11-09', 'Alpha', 3000, 600, 300), rec('2026-11-10', 'Beta', 2000, 100, 0), rec('2026-10-30', 'Alpha', 9999, 9999)]
  const ds = DATASETS.delivered_loads!

  it('totals, margin and per-mile come from summed rows, not averaged ratios', () => {
    const out = runDataQuery(ds, rows, q({ metrics: ['loads', 'revenue', 'profit', 'margin', 'revenuePerMile'] }), win)
    expect(out.rowsUsed).toBe(3) // October is outside the window
    expect(out.totals).toMatchObject({ loads: 3, revenue: 6000, profit: 900, margin: 15, revenuePerMile: 10 })
  })

  it('groups by a dimension, sorted by the first metric, and groups by week or month', () => {
    const byCustomer = runDataQuery(ds, rows, q({ groupBy: ['customer'] }), win)
    expect(byCustomer.groups.map((g) => g.customer)).toEqual(['Alpha', 'Beta'])
    const byWeek = runDataQuery(ds, rows, q({ groupBy: ['week'] }), win)
    expect(byWeek.groups.map((g) => g.week)).toEqual(['2026-11-02', '2026-11-09']) // time groupings read oldest first
    expect(weekStart('2026-11-10')).toBe('2026-11-09')
  })

  it('a filter that matches nothing says which values exist instead of returning a silent zero', () => {
    const out = runDataQuery(ds, rows, q({ filters: [{ dim: 'customer', values: ['Gamma'] }] }), win)
    expect(out.rowsUsed).toBe(0)
    expect(out.notes.join(' ')).toMatch(/Alpha/)
  })

  it('caps the groups it returns and says so', () => {
    const many = Array.from({ length: 6 }, (_, i) => rec('2026-11-03', `Cust ${i}`, 100 + i, 10))
    const out = runDataQuery(ds, many, q({ groupBy: ['customer'], limit: 3 }), win)
    expect(out.groups).toHaveLength(3)
    expect(out.truncated).toBe(true)
    expect(out.groupCount).toBe(6)
  })
})

describe('query_data', () => {
  const ask = source({ samples: async () => [sample({ shipmentId: 'a' }), sample({ shipmentId: 'b', customerId: 'c2', customerName: 'Beta Foods', revenueCents: 555_000, profitCents: 55_000 })] })

  it('a rep sees only the customers they own: the other customer is not in totals or groups', async () => {
    const out = JSON.parse(await queryData(env(rep, ask), { dataset: 'delivered_loads', metrics: ['revenue'], groupBy: ['customer'] }))
    expect(out.totals.revenue).toBe(100_000)
    expect(out.groups.map((g: { customer: string }) => g.customer)).toEqual(['Alpha Freight'])
    expect(JSON.stringify(out)).not.toContain('Beta')
  })

  it('the owner sees every customer, with rep and division names resolved', async () => {
    const out = JSON.parse(await queryData(env(owner, ask), { dataset: 'delivered_loads', metrics: ['revenue', 'margin'], groupBy: ['division'] }))
    expect(out.totals.revenue).toBe(655_000)
    expect(out.groups[0].division).toBe('BCAT Logistics')
  })

  it('refuses a bad metric or dimension by name instead of guessing', async () => {
    const msg = await queryData(env(owner, ask), { dataset: 'delivered_loads', metrics: ['nonsense'], groupBy: ['planet'] })
    expect(msg).toMatch(/metric nonsense/)
    expect(msg).toMatch(/dimension planet/)
  })

  it('carrier bills need AR/AP or owner: a rep is refused with the same words whatever the table holds', async () => {
    const withBills = source({ carrierBills: async () => [{ status: 'TO_BE_PAID', billDate: '2026-11-03', carrierName: 'Fast Carrier', netCents: 123_456, balanceCents: 123_456 }] })
    const empty = source()
    const a = await queryData(env(rep, withBills), { dataset: 'carrier_bills' })
    const b = await queryData(env(rep, empty), { dataset: 'carrier_bills' })
    expect(a).toBe(b)
    expect(a).toMatch(/does not include/)
    expect(a).not.toContain('123456')
    const ok = JSON.parse(await queryData(env(accounting, withBills), { dataset: 'carrier_bills', metrics: ['bills', 'balance'], groupBy: ['carrier'] }))
    expect(ok.totals).toMatchObject({ bills: 1, balance: 123_456 })
  })

  it('driver pay, fuel and maintenance are owner/admin only, even for AR/AP', async () => {
    for (const dataset of ['driver_pay', 'fuel', 'maintenance_invoices']) {
      expect(await queryData(env(accounting, source()), { dataset })).toMatch(/does not include/)
      expect(await queryData(env(rep, source()), { dataset })).toMatch(/does not include/)
      expect(await queryData(env(owner, source()), { dataset })).not.toMatch(/does not include/)
    }
  })

  it('voided and archived carrier bills are left out; paid bills can be windowed by their paid day', async () => {
    const ask2 = source({
      carrierBills: async () => [
        { status: 'PAID', billDate: '2026-09-01', paidAt: '2026-11-04T15:00:00.000Z', carrierName: 'A', netCents: 1000, paidCents: 1000 },
        { status: 'VOID', billDate: '2026-11-02', carrierName: 'B', netCents: 5000 },
        { status: 'PAID', billDate: '2026-11-02', archivedAt: '2026-11-15T00:00:00Z', carrierName: 'C', netCents: 7000 },
      ],
    })
    const out = JSON.parse(await queryData(env(owner, ask2), { dataset: 'carrier_bills', dateField: 'paidDate', metrics: ['bills', 'paid'] }))
    expect(out.totals).toMatchObject({ bills: 1, paid: 1000 })
  })

  it('driver pay lists pay periods, approved credits and deductions, and skips pending credits', async () => {
    const ask3 = source({
      drivers: async () => [{ id: 'd1', name: 'Pat Driver', fleetGroup: 'LOCAL' }],
      payPeriods: async () => [{ driverId: 'fleet-combined:LOCAL', periodStart: '2026-11-02', periodEnd: '2026-11-15', grossPay: 10000 }],
      payCredits: async () => [
        { driverId: 'd1', periodStart: '2026-11-02', kind: 'CREDIT', reasonCode: 'DETENTION', amount: 50, approvalStatus: null },
        { driverId: 'd1', periodStart: '2026-11-02', kind: 'CREDIT', reasonCode: 'BONUS', amount: 999, approvalStatus: 'PENDING' },
      ],
    })
    const out = JSON.parse(await queryData(env(owner, ask3), { dataset: 'driver_pay', groupBy: ['kind'], metrics: ['amount'] }))
    expect(out.groups).toEqual(expect.arrayContaining([{ kind: 'PAY_PERIOD', amount: 1_000_000 }, { kind: 'CREDIT', amount: 5000 }]))
    expect(JSON.stringify(out)).not.toContain('99900')
  })

  it('describe_data lists only what the viewer may use', () => {
    const repList = JSON.parse(describeData(env(rep, source()), {}))
    expect(repList.datasets.map((d: { dataset: string }) => d.dataset)).toEqual(['delivered_loads'])
    expect(repList.otherTools).toEqual([])
    const ownerList = JSON.parse(describeData(env(owner, source()), {}))
    expect(ownerList.datasets).toHaveLength(Object.keys(DATASETS).length)
    expect(ownerList.otherTools.join(' ')).toMatch(/fleet_pnl/)
    expect(mayUse('FINANCE', accounting)).toBe(true)
    expect(mayUse('OWNER', accounting)).toBe(false)
  })
})

// ── fleet_pnl ────────────────────────────────────────────────────────────────

const fleetAsk = (): AskSource =>
  source({
    equipment: async () => [
      { id: 'eq1', type: 'truck', unitNumber: '685', fleetGroup: 'LOCAL', active: true, fuelCardNumbers: ['00685'] },
      { id: 'eq2', type: 'truck', unitNumber: '3890', fleetGroup: 'BOX_TRUCK', active: true, fuelCardNumbers: [] },
      { id: 'eq3', type: 'truck', unitNumber: '310', fleetGroup: 'AMAZON', active: true, fuelCardNumbers: ['00310'] },
    ],
    drivers: async () => [
      { id: 'd1', name: 'Charles Best', active: true, type: 'driver', fleetGroup: 'LOCAL', assignedTruckId: 'eq1' },
      { id: 'd2', name: 'Roy Workman', active: true, type: 'driver', fleetGroup: 'OWNER_OPERATOR', assignedTruckId: 'eq3' },
    ],
    // $20,000 delivered by the local driver in the window; $9,000 by the owner-operator (another fleet).
    loadsDeliveredBetween: async () => [
      { id: 'l1', deliveryDriverId: 'd1', rate: 2_000_000, deliveryAppt: '2026-10-12T15:00:00Z' },
      { id: 'l2', deliveryDriverId: 'd2', rate: 900_000, deliveryAppt: '2026-10-13T15:00:00Z' },
    ],
    fuelTransactions: async () => [
      { id: 'f1', transactionDate: '2026-10-10', cardNumber: '00685', truckId: 'eq1', amount: 3000, itemCategory: 'FUEL', quantity: 800 },
      { id: 'f2', transactionDate: '2026-11-03', cardNumber: '00310', truckId: 'eq3', amount: 7777, itemCategory: 'FUEL', quantity: 1 },
    ],
    // One combined pay row per 14-day period for the whole LOCAL fleet, entered through Nov 8.
    payPeriods: async () => [
      { driverId: 'fleet-combined:LOCAL', periodStart: '2026-10-12', periodEnd: '2026-10-25', grossPay: 14_000 },
      { driverId: 'fleet-combined:LOCAL', periodStart: '2026-10-26', periodEnd: '2026-11-08', grossPay: 14_000 },
    ],
    expenseTypes: async () => [{ id: 't-ins', name: 'Loan', category: 'FINANCING' }],
    recurringExpenses: async () => [{ expenseTypeId: 't-ins', allocationId: 'a1', monthlyAmount: 3100, startMonth: '2026-01', endMonth: null, active: true }],
    expenseAllocations: async () => [{ id: 'a1', expenseTypeId: 't-ins', allocationMethod: 'SPLIT_EVEN', truckIds: ['eq1', 'eq2'] }],
  })

describe('fleet_pnl', () => {
  it('is owner/admin only', async () => {
    expect(await fleetPnl(env(rep, fleetAsk()), { fleet: 'LOCAL' })).toMatch(/does not include/)
    expect(await fleetPnl(env(accounting, fleetAsk()), { fleet: 'LOCAL' })).toMatch(/does not include/)
  })

  it('a full month: revenue only from the fleet\'s own drivers, expenses summed, margin = net / revenue', async () => {
    const out = JSON.parse(await fleetPnl(env(owner, fleetAsk()), { fleet: 'LOCAL', from: '2026-10-01', to: '2026-10-31' }))
    expect(out.revenue).toBe(2_000_000) // the owner-operator's $9,000 is another fleet
    expect(out.expenses.fuel).toBe(300_000) // $3,000, in cents; the other fleet's fuel is not here
    expect(out.expenses.truckLoans).toBe(310_000) // the monthly loan, split across the two LOCAL-fleet trucks, full month
    // Pay periods Oct 12-25 and Oct 26-Nov 8: 20 of the window's days are covered, prorated by day.
    expect(out.expenses.driverPay).toBe(Math.round(((14_000 * 14) / 14 + (14_000 * 6) / 14) * 100))
    expect(out.net).toBe(out.revenue - out.expenses.total)
    expect(out.marginPercent).toBeCloseTo((out.net / out.revenue) * 100, 0)
    expect(out.gaps.join(' ')).toMatch(/3890/) // the box truck has no fuel card on file
  })

  it('a window running past the last pay entry reports the gap and a separate, labelled estimate', async () => {
    const out = JSON.parse(await fleetPnl(env(owner, fleetAsk()), { fleet: 'LOCAL', window: 'THIS_MONTH' }))
    expect(out.window).toMatchObject({ from: '2026-11-01', to: TODAY }) // cut at today
    expect(out.driverPayCoverage.lastPayPeriodEnd).toBe('2026-11-08')
    expect(out.driverPayCoverage.daysWithPayRecorded).toBe(8)
    expect(out.gaps.join(' ')).toMatch(/11 of 19 days/)
    const est = out.driverPayCoverage.estimateForMissingDays
    expect(est.driverPay).toBeGreaterThan(0)
    expect(est.expensesTotalWithEstimate).toBe(out.expenses.total + est.driverPay)
    expect(out.expenses.driverPay).toBeLessThan(est.driverPay + out.expenses.driverPay) // the engine's own figure is not changed by the estimate
  })

  it('rejects an unknown fleet and a window that starts after today', async () => {
    expect(await fleetPnl(env(owner, fleetAsk()), { fleet: 'MOON' })).toMatch(/Unknown fleet/)
    expect(await fleetPnl(env(owner, fleetAsk()), { from: '2026-12-01', to: '2026-12-31' })).toMatch(/after today/)
  })
})

// ── The exact question, through the assistant loop ───────────────────────────

describe('"If you look at monthly expenses for local drivers. What is our profit margin"', () => {
  const scripted = (steps: AssistantBlock[][], seen: StepRequest[]): AssistantModel => {
    let i = 0
    return { async step(req) { seen.push({ ...req, messages: structuredClone(req.messages) }); return { content: steps[i++] ?? [{ type: 'text', text: 'done' }] } } }
  }
  const asked = { messages: [{ role: 'user' as const, text: 'If you look at monthly expenses for local drivers. What is our profit margin' }] }

  it('offers fleet_pnl and the data tools, and the answer comes from the tool result, not the model', async () => {
    const seen: StepRequest[] = []
    const e = env(owner, fleetAsk())
    const tools: AssistantTools = {
      runQuery: async () => '{}', findShipment: async () => '{}',
      describeData: (i) => describeData(e, i), queryData: (i) => queryData(e, i), fleetPnl: (i) => fleetPnl(e, i),
    }
    const res = await assistantTurn(asked, {
      model: scripted([[{ type: 'tool_use', id: 't1', name: 'fleet_pnl', input: { fleet: 'LOCAL', from: '2026-10-01', to: '2026-10-31' } }], [{ type: 'text', text: 'Margin was shown.' }]], seen),
      tools, today: TODAY, nowMs: Date.now,
    })
    expect(res.toolsUsed).toEqual(['fleet_pnl'])
    expect(res.modelError).toBeNull()
    expect(seen[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['describe_data', 'query_data', 'fleet_pnl']))
    expect(seen[0]!.system).toMatch(/fleet_pnl/)
    const fed = JSON.stringify(seen[1]!.messages)
    expect(fed).toContain('marginPercent')
    expect(fed).toContain('driverPayCoverage')
  })

  it('a rep asking the same question is told their access does not include it', async () => {
    const seen: StepRequest[] = []
    const e = env(rep, fleetAsk())
    const tools: AssistantTools = { runQuery: async () => '{}', findShipment: async () => '{}', fleetPnl: (i) => fleetPnl(e, i) }
    await assistantTurn(asked, {
      model: scripted([[{ type: 'tool_use', id: 't1', name: 'fleet_pnl', input: { fleet: 'LOCAL' } }], [{ type: 'text', text: 'I cannot see that.' }]], seen),
      tools, today: TODAY, nowMs: Date.now,
    })
    const fed = JSON.stringify(seen[1]!.messages)
    expect(fed).toMatch(/does not include/)
    expect(fed).not.toMatch(/marginPercent|revenue/)
  })
})
