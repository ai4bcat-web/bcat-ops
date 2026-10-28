/**
 * The board's arithmetic, without a browser.
 *
 * Three things here are load-bearing: a row must land on exactly one tab (a quote shown
 * on two is a quote worked twice), the strip must answer 0% for a month that decided
 * nothing rather than NaN, and the expiry chip must say "Expired" the moment the clock
 * runs out — the Sent tab's whole job is to make a lapsed number obvious.
 */
import { describe, it, expect } from 'vitest'
import {
  EMPTY_LANE_LOOKUP, expiryChip, laneLookupKeys, marginChip, quoteTabCounts, quoteTotals,
  splitQuoteTabs, theirNumberCents, whoseMoveLabel,
} from './quoteViews'
import type { QuoteRecord, QuoteStatus } from '@/types/tms'

const NOW = '2026-03-10T12:00:00.000Z'

function quote(patch: Partial<QuoteRecord> & { id: string; status: QuoteStatus }): QuoteRecord {
  return {
    side: 'SELL',
    quoteDate: '2026-03-10',
    quoteMonth: '2026-03',
    amountCents: 150_000,
    rounds: 1,
    createdBy: 'rep@bcat',
    updatedBy: 'rep@bcat',
    version: 1,
    ...patch,
  }
}

describe('the quote tabs', () => {
  it('puts every open row on exactly one tab and keeps the two sides apart', () => {
    const open = [
      quote({ id: 'Q1', status: 'REQUESTED' }),
      quote({ id: 'Q2', status: 'QUOTED' }),
      quote({ id: 'Q3', status: 'SENT_COUNTER' }),
      quote({ id: 'Q4', status: 'RECEIVED_REPLY' }),
      quote({ id: 'Q5', status: 'RECEIVED_COUNTER' }),
      quote({ id: 'Q6', status: 'DRAFT' }),
      quote({ id: 'Q7', status: 'QUOTED', side: 'BUY' }),
      quote({ id: 'Q8', status: 'REQUESTED', side: 'BUY' }),
    ]
    const closed = [
      quote({ id: 'Q9', status: 'WON' }),
      quote({ id: 'Q10', status: 'LOST' }),
      // An open row that also came back in the month read must not double up.
      quote({ id: 'Q2', status: 'QUOTED' }),
    ]

    const rows = splitQuoteTabs(open, closed)

    expect(rows['to-price'].map((q) => q.id)).toEqual(['Q1'])
    expect(rows.sent.map((q) => q.id).sort()).toEqual(['Q2', 'Q3'])
    expect(rows.replies.map((q) => q.id).sort()).toEqual(['Q4', 'Q5'])
    expect(rows.drafts.map((q) => q.id)).toEqual(['Q6'])
    expect(rows['won-lost'].map((q) => q.id).sort()).toEqual(['Q10', 'Q9'])
    expect(rows.offers.map((q) => q.id).sort()).toEqual(['Q7', 'Q8'])

    expect(quoteTabCounts(rows)).toEqual({
      'to-price': 1, sent: 2, replies: 2, drafts: 1, 'won-lost': 2, offers: 2,
    })
  })
})

describe('the totals strip', () => {
  it('counts what is on the table, what landed and how fast they answer', () => {
    const open = [
      quote({ id: 'Q1', status: 'QUOTED', amountCents: 100_000 }),
      quote({ id: 'Q2', status: 'RECEIVED_COUNTER', amountCents: 50_000 }),
      // The buy side is cost, not revenue: it never joins the open figure.
      quote({ id: 'Q3', status: 'QUOTED', side: 'BUY', amountCents: 900_000 }),
    ]
    const month = [
      quote({
        id: 'Q4', status: 'WON', amountCents: 200_000,
        sentAt: '2026-03-01T00:00:00.000Z', respondedAt: '2026-03-01T02:00:00.000Z',
      }),
      quote({
        id: 'Q5', status: 'LOST', amountCents: 300_000,
        sentAt: '2026-03-02T00:00:00.000Z', respondedAt: '2026-03-02T06:00:00.000Z',
      }),
      quote({
        id: 'Q6', status: 'WON', amountCents: 100_000,
        sentAt: '2026-03-03T00:00:00.000Z', respondedAt: '2026-03-03T04:00:00.000Z',
      }),
    ]

    const totals = quoteTotals(open, month)

    expect(totals.openCents).toBe(150_000)
    expect(totals.openCount).toBe(2)
    expect(totals.wonCents).toBe(300_000)
    expect(totals.wonCount).toBe(2)
    expect(totals.lostCount).toBe(1)
    expect(totals.winRatePct).toBe(67)
    // 2h, 4h, 6h — the middle one.
    expect(totals.medianReplyHours).toBe(4)
  })

  it('answers 0% and an unmeasured reply time for a month that decided nothing', () => {
    const totals = quoteTotals([], [quote({ id: 'Q1', status: 'QUOTED' })])

    expect(totals.winRatePct).toBe(0)
    expect(Number.isNaN(totals.winRatePct)).toBe(false)
    expect(totals.wonCents).toBe(0)
    expect(totals.medianReplyHours).toBeNull()
  })
})

describe('the expiry chip', () => {
  it('says Expired once the clock has run out, whatever the row still reads', () => {
    const chip = expiryChip(
      quote({ id: 'Q1', status: 'QUOTED', expiresAt: '2026-03-10T11:00:00.000Z' }),
      NOW,
    )
    expect(chip).toEqual({ text: 'Expired', tone: 'danger' })
  })

  it('counts down in hours, and warns inside the last four', () => {
    expect(expiryChip(quote({ id: 'Q1', status: 'QUOTED', expiresAt: '2026-03-10T15:00:00.000Z' }), NOW))
      .toEqual({ text: 'Expires in 3h', tone: 'warn' })
    expect(expiryChip(quote({ id: 'Q2', status: 'QUOTED', expiresAt: '2026-03-12T12:00:00.000Z' }), NOW))
      .toEqual({ text: 'Expires in 2d', tone: 'muted' })
  })

  it('has nothing to say about a quote whose clock is not running', () => {
    expect(expiryChip(quote({ id: 'Q1', status: 'DRAFT' }), NOW)).toBeNull()
    // A counter sitting with us does not go stale while we think about it, whatever
    // expiry the last round left on the row.
    expect(expiryChip(
      quote({ id: 'Q2', status: 'RECEIVED_COUNTER', expiresAt: '2026-03-10T11:00:00.000Z', counterCents: 90_000 }),
      NOW,
    )).toBeNull()
  })

  /**
   * Rows with no clock carry a far-future `expiresAt` so they stay in the composite
   * open index. It is an index key; counting down to the year 9999 would be absurd.
   */
  it('never counts down to the index sentinel', () => {
    expect(expiryChip(
      quote({ id: 'Q1', status: 'QUOTED', expiresAt: '9999-12-31T23:59:59.999Z' }),
      NOW,
    )).toBeNull()
  })
})

describe('the row chips', () => {
  it('reads margin against the floor the quote has to clear', () => {
    expect(marginChip({ marginBps: 1_250 }, 1_000)).toEqual({ text: '12.5% margin', tone: 'good' })
    expect(marginChip({ marginBps: 800 }, 1_000)).toEqual({ text: '8.0% margin', tone: 'warn' })
    expect(marginChip({ marginBps: -200 }, 1_000)).toEqual({ text: '-2.0% margin', tone: 'danger' })
    expect(marginChip({ marginBps: null }, 1_000)).toBeNull()
  })

  it('names whose move it is in the words of the side it is with', () => {
    expect(whoseMoveLabel(quote({ id: 'Q1', status: 'QUOTED', expiresAt: '2026-03-12T12:00:00.000Z' }), NOW))
      .toBe('Customer')
    expect(whoseMoveLabel(quote({ id: 'Q2', status: 'REQUESTED', side: 'BUY' }), NOW)).toBe('Carrier')
    expect(whoseMoveLabel(quote({ id: 'Q3', status: 'RECEIVED_COUNTER' }), NOW)).toBe('Us')
    expect(whoseMoveLabel(quote({ id: 'Q4', status: 'QUOTED', expiresAt: '2026-03-10T11:00:00.000Z' }), NOW))
      .toBe('Us — it lapsed')
    expect(whoseMoveLabel(quote({ id: 'Q5', status: 'WON' }), NOW)).toBe('—')
  })

  it('shows their number only where the other side has actually named one', () => {
    expect(theirNumberCents(quote({ id: 'Q1', status: 'RECEIVED_COUNTER', counterCents: 90_000 }))).toBe(90_000)
    expect(theirNumberCents(quote({ id: 'Q2', status: 'QUOTED' }))).toBeNull()
    expect(theirNumberCents(quote({ id: 'Q3', status: 'QUOTED', side: 'BUY', amountCents: 80_000 }))).toBe(80_000)
  })
})

describe('the lane lookup', () => {
  it('keys a typed-in lane exactly as a load would be keyed', () => {
    const keys = laneLookupKeys({
      originCity: 'st. louis', originState: 'mo', originZip: '63101',
      destCity: 'Danville', destState: 'IL', destZip: '61832-1234',
    })
    expect(keys.laneKey).toBe('ST LOUIS|MO>DANVILLE|IL')
    expect(keys.laneKey3).toBe('631>618')
  })

  it('refuses to guess a half-typed lane', () => {
    expect(laneLookupKeys(EMPTY_LANE_LOOKUP)).toEqual({ laneKey: null, laneKey3: null })
    expect(laneLookupKeys({ ...EMPTY_LANE_LOOKUP, originCity: 'Chicago', originState: 'IL' }))
      .toEqual({ laneKey: null, laneKey3: null })
  })
})
