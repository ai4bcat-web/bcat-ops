// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { FreightCard } from '../cards/FreightCard'
import { CustomerContact, CustomerRef } from '../cards/CustomerCard'
import { RouteCard } from '../cards/RouteCard'
import { InstructionsTab } from '../cards/more/InstructionsTab'
import { NotesTab } from '../cards/more/NotesTab'
import { renderCard } from '../cards/cardTestKit'
import type { CardProps } from '../cards/cardRegistry'
import { RolesSection } from '../sections/RolesSection'
import { RatesSection } from '../sections/RatesSection'
import { narrowSpanOf, rowsOf, spread } from './rowsOf'

vi.mock('@/hooks/useStaff', () => ({ useStaff: () => ({ staff: [], loading: false }) }))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ userId: 'u1', email: 'rep@bcat.test', groups: [] }) }))
vi.mock('../sections/routeMilesApi', () => ({ getRouteMiles: vi.fn(async () => ({ miles: null, source: null, error: null })) }))

describe('rowsOf', () => {
  it('groups spans into rows of exactly 12', () => {
    expect(rowsOf([3, 3, 3, 3, 3, 3, 3, 3])).toEqual({ rows: [[3, 3, 3, 3], [3, 3, 3, 3]], ok: true })
    expect(rowsOf([9, 3, 4, 4, 4])).toEqual({ rows: [[9, 3], [4, 4, 4]], ok: true })
    expect(rowsOf([12])).toMatchObject({ ok: true })
  })
  it('flags a ragged row, a short last row and an impossible span', () => {
    expect(rowsOf([3, 3, 3]).ok).toBe(false)
    expect(rowsOf([6, 4, 4]).ok).toBe(false)
    expect(rowsOf([13]).ok).toBe(false)
    expect(rowsOf([0, 12]).ok).toBe(false)
  })
  it('narrow: quarter and third fields become halves, 6+ fills the row, own narrow wins', () => {
    expect([3, 4, 2].map((s) => narrowSpanOf(s))).toEqual([6, 6, 6])
    expect([6, 9, 12].map((s) => narrowSpanOf(s))).toEqual([12, 12, 12])
    expect(narrowSpanOf(4, 12)).toBe(12)
  })
  it('spread(n) fills whole rows wide and narrow for every count a rate row can have', () => {
    for (let n = 1; n <= 8; n += 1) {
      const { wide, narrow } = spread(n)
      expect(wide).toHaveLength(n)
      expect(rowsOf(wide).ok, `wide ${n}`).toBe(true)
      expect(rowsOf(narrow).ok, `narrow ${n}`).toBe(true)
    }
  })
})

/** Every grid in the DOM: its fields' declared spans, wide and narrow, must make flush rows. */
function assertGrids(root: ParentNode = document) {
  const grids = [...root.querySelectorAll('.tms-fg')]
  expect(grids.length).toBeGreaterThan(0)
  for (const g of grids) {
    const fields = [...g.children].filter((c) => c.classList.contains('tms-fg-field')) as HTMLElement[]
    const wide = fields.map((f) => Number(f.dataset.span))
    const narrow = fields.map((f) => narrowSpanOf(Number(f.dataset.span), f.dataset.spanNarrow ? Number(f.dataset.spanNarrow) : undefined))
    if (wide.length === 0) continue
    expect(rowsOf(wide), `wide ${wide.join(',')}`).toMatchObject({ ok: true })
    expect(rowsOf(narrow), `narrow ${narrow.join(',')}`).toMatchObject({ ok: true })
  }
}

/** The rhythm: label, control, and under the control only the screen-reader copy or the notes counter. */
function assertRhythm() {
  for (const f of document.querySelectorAll('.tms-fg-field')) {
    const kids = [...f.children]
    expect(kids[0]!.classList.contains('tms-fg-label'), 'label first').toBe(true)
    expect(kids[1]!.classList.contains('tms-fg-control'), 'control second').toBe(true)
    for (const extra of kids.slice(2)) {
      expect(extra.classList.contains('tms-fg-sr') || extra.classList.contains('tms-fg-counter'), `nothing visible under ${f.querySelector('.tms-fg-label-text')?.textContent}`).toBe(true)
    }
    const label = f.querySelector('.tms-fg-label-text')!.textContent ?? ''
    expect(label, 'no parentheticals in a label').not.toMatch(/\(/)
  }
}

const card = (C: ComponentType<CardProps>, opts: Parameters<typeof renderCard>[1] = {}) => { renderCard(C, opts) }

describe('every card lays out on flush 12-column rows with one rhythm', () => {
  it('Freight, default and with every sub-field open', () => {
    card(FreightCard)
    assertGrids(); assertRhythm()
    for (const id of ['f-shipping-tempControl', 'f-shipping-palletExchange', 'f-shipping-tarps']) fireEvent.click(screen.getByTestId(id))
    assertGrids(); assertRhythm()
    const spans = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"] .tms-fg > .tms-fg-field`)].map((f) => (f as HTMLElement).dataset.span)
    expect(spans('f-shipping-col-details')).toEqual(['12', '12', '12', '12'])
    expect(spans('f-shipping-col-quantities')).toEqual(['6', '6', '6', '6', '12'])
  })
  it('Route (three stops) and the header Customer ref', () => {
    card(RouteCard, { seed: (v) => ({ ...v, stops: [v.stops[0], { ...v.stops[0], id: 'mid', type: 'pickup' as const }, v.stops[1]] }) })
    assertGrids(); assertRhythm()
    cleanup()
    card(CustomerRef)
    assertGrids(); assertRhythm()
  })
  it('Customer contact, More tabs, Roles and Rates (flat, per hour, % of customer)', () => {
    const wrap = (node: JSX.Element) => render(<MemoryRouter>{node}</MemoryRouter>)
    card(CustomerContact); assertGrids(); assertRhythm(); cleanup()
    card(InstructionsTab); assertGrids(); assertRhythm(); cleanup()
    card(NotesTab); assertGrids(); assertRhythm(); cleanup()
    card((p) => <RolesSection value={p.values.roles} onChange={() => {}} ctx={p.ctx} form={p.form} />); assertGrids(); assertRhythm(); cleanup()
    for (const [c, k] of [['PER_HOUR', 'FLAT'], ['FLAT', 'PER_HOUR'], ['FLAT', 'PCT_OF_CUSTOMER']] as const) {
      card((p) => <RatesSection value={{ ...p.values.rates, customer: { ...p.values.rates.customer, rateType: c }, carrier: { ...p.values.rates.carrier, rateType: k } }} onChange={() => {}} ctx={p.ctx} ship={p.values.ship} form={p.form} />)
      assertGrids(); assertRhythm(); cleanup()
    }
    expect(wrap).toBeTruthy()
  })
  it('the only element under a control is a notes counter', () => {
    card(InstructionsTab)
    expect(document.querySelectorAll('.tms-fg-counter')).toHaveLength(3)
  })
})
