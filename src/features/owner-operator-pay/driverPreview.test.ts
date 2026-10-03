/**
 * Staff answer "what is the driver seeing?" by asking the driver — someone on a truck
 * describing a screen. This builds the settlement the driver app would be served, from
 * data the staff page already holds, so it can be rendered in the driver's own components.
 *
 * Its only value is faithfulness. A preview that quietly disagrees with the real thing is
 * worse than no preview, because it sends people looking for a bug on the wrong side. So
 * these pin the places the two could drift: held pay, the always-present factoring fee,
 * and the document flags the row turns red or green on.
 */
import { describe, it, expect } from 'vitest'
import { previewSettlement } from './driverPreview'
import { FACTORING_FEE_LABEL } from '@/lib/driverPay'
import type { OwnerOperatorPayRow } from '@/hooks/useOwnerOperatorPay'

const trip = (over: Record<string, unknown> = {}) => ({
  id: 'load-1',
  loadId: '14538',
  customer: 'WAYFINDER LOGISTICS',
  origin: 'DALLAS, TX',
  destination: 'OKLAHOMA CITY, OK',
  miles: 206,
  freightAmount: 1250,
  deliveredAt: '2026-10-02T18:00:00.000Z',
  readiness: {
    ready: false,
    payload: { InvoiceNo: '14538', PoNumber: 'PO-7', InvoiceAmount: 1250 },
    sources: {},
    missingFields: [],
    missingDocuments: [] as string[],
    warnings: [],
  },
  ...over,
})

function row(over: Partial<OwnerOperatorPayRow> = {}): OwnerOperatorPayRow {
  return {
    driver: { id: 'drv-1', name: 'Ryne Test' },
    setting: { payPercent: 0.88, expensesBeforePercent: false },
    trips: [trip()],
    deductions: [{ label: 'Insurance', amount: 100 }],
    credits: [],
    debits: [],
    fixedDebits: [],
    heldTrips: [],
    heldFreight: 0,
    statement: { gross: 1250, factoringFee: 25, checkAmount: 975 },
    ...over,
  } as unknown as OwnerOperatorPayRow
}

describe('previewSettlement', () => {
  it('pays the driver their percentage of the freight', () => {
    const s = previewSettlement(row(), '2026-09-27')
    expect(s.trips[0].amount).toBe(1100) // 88% of 1250
    expect(s.trips[0].rate).toBe(1250)
  })

  it('shows a held load at $0, not at what it would have paid', () => {
    /*
     * The server does this, and it matters more here than anywhere: a preview showing
     * $1,100 for a load nobody is paying would have staff telling a driver a number that
     * never arrives.
     */
    const t = trip()
    const s = previewSettlement(
      row({ trips: [t], heldTrips: [{ trip: t, reason: 'NO_POD' }] } as Partial<OwnerOperatorPayRow>),
      '2026-09-27',
    )
    expect(s.trips[0].amount).toBe(0)
    expect(s.trips[0].heldReason).toBe('NO_POD')
    expect(s.trips[0].heldLabel).toBeTruthy()
  })

  it('always lists the factoring fee, even at zero', () => {
    // A driver who never sees the line cannot know the fee exists, and its absence reads
    // as an error rather than as a quiet week.
    const s = previewSettlement(row({ statement: { gross: 0, factoringFee: 0, checkAmount: 0 } } as Partial<OwnerOperatorPayRow>), '2026-09-27')
    expect(s.deductions[0].label).toBe(FACTORING_FEE_LABEL)
    expect(s.deductions[0].amount).toBe(0)
  })

  it('reports the documents the row turns red or green on', () => {
    const missing = trip({
      readiness: { ...trip().readiness, missingDocuments: ['POD'] },
    })
    const s = previewSettlement(row({ trips: [missing] } as Partial<OwnerOperatorPayRow>), '2026-09-27')
    expect(s.trips[0].factoring?.podPresent).toBe(false)
    expect(s.trips[0].factoring?.rateconPresent).toBe(true)
  })

  it('carries the PRO through, which is what the driver taps to send a POD', () => {
    const s = previewSettlement(row(), '2026-09-27')
    expect(s.trips[0].factoring?.invoiceNo).toBe('14538')
  })

  it('has no factoring view for a load that was never prepared', () => {
    const s = previewSettlement(
      row({ trips: [trip({ readiness: undefined })] } as Partial<OwnerOperatorPayRow>),
      '2026-09-27',
    )
    expect(s.trips[0].factoring).toBeNull()
  })

  it('sorts trips by the day they delivered', () => {
    const s = previewSettlement(
      row({
        trips: [
          trip({ id: 'b', deliveredAt: '2026-10-02T18:00:00.000Z' }),
          trip({ id: 'a', deliveredAt: '2026-09-29T12:00:00.000Z' }),
        ],
      } as Partial<OwnerOperatorPayRow>),
      '2026-09-27',
    )
    expect(s.trips.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('carries the figures the driver is actually shown', () => {
    const s = previewSettlement(row(), '2026-09-27')
    expect(s.grossPay).toBe(1250)
    expect(s.checkAmount).toBe(975)
    expect(s.weekStart).toBe('2026-09-27')
    expect(s.weekLabel).toBeTruthy()
  })

  it('handles a week with no loads rather than throwing at staff', () => {
    const s = previewSettlement(row({ trips: [], statement: { gross: 0, factoringFee: 0, checkAmount: 0 } } as Partial<OwnerOperatorPayRow>), '2026-09-27')
    expect(s.trips).toEqual([])
    expect(s.checkAmount).toBe(0)
  })
})
