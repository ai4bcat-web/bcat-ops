// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import type { CapacityBoard as BoardData, CapacityOp } from '@/lib/capacityBoard'

// The "server": the same pure rules the Lambda applies, over a board that outlives a remount.
const server = vi.hoisted(() => ({ board: { cards: [] } as { cards: unknown[] }, n: 0 }))
vi.mock('@/lib/apiClient', async () => {
  const lib = await import('@/lib/capacityBoard')
  return {
    getCapacityBoard: async () => lib.parseCapacityBoard(JSON.parse(JSON.stringify(server.board))),
    capacityBoardOp: async (op: CapacityOp) => {
      const out = lib.applyCapacityOp(lib.parseCapacityBoard(server.board), op, { today: '2026-11-27', nowIso: new Date().toISOString(), user: 'dennis@bcatcorp.com', newId: () => `srv-${++server.n}` })
      server.board = JSON.parse(JSON.stringify(out.board))
      return { board: out.board, card: out.card }
    },
  }
})
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/features/tms/kit/CityInput', () => ({
  CityInput: ({ value, onChange, onPick: _p, ...rest }: { value: string; onChange: (v: string) => void; onPick: unknown } & Record<string, unknown>) => {
    void _p
    return <input value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
  },
}))

import { CapacityBoard } from './CapacityBoard'

function dataTransfer() {
  const store = new Map<string, string>()
  return { setData: (k: string, v: string) => { store.set(k, v) }, getData: (k: string) => store.get(k) ?? '', effectAllowed: 'move' }
}

const range = { from: '2026-11-27', to: '2026-11-29' }
function board() {
  return <CapacityBoard from={range.from} to={range.to} onRangeChange={() => undefined} drivers={[]} phone={false} userEmail="dennis@bcatcorp.com" />
}
const column = (day: string) => document.querySelector(`section[data-day="${day}"]`) as HTMLElement
/** The board loads before it draws its columns. */
const loaded = () => waitFor(() => { if (!column('2026-11-27')) throw new Error('not drawn yet') })
const baseCard = { availableFrom: '2026-11-27', availableTo: '2026-11-27', origin: 'Chicago, IL', destination: '', equipment: 'Dry Van', loadType: 'FULL', lengthFt: 53 }
function seed(...cards: Record<string, unknown>[]) {
  server.board = { cards: cards.map((c, i) => ({ id: `s${i}`, status: 'OPEN', createdAt: `2026-11-27T1${i}:00:00.000Z`, createdBy: 'x', updatedAt: '2026-11-27T10:00:00.000Z', updatedBy: 'x', ...baseCard, ...c })) }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-27T15:00:00Z'))
  server.board = { cards: [] }
  server.n = 0
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('CapacityBoard', () => {
  it('draws a truck for each card and gives cards on one day their own colors', async () => {
    seed({ id: 'a', equipment: 'Van' }, { id: 'b', equipment: 'Box truck', lengthFt: 18 }, { id: 'c', equipment: 'Reefer' })
    render(board())
    await loaded()
    const cards = Array.from(column('2026-11-27').querySelectorAll('[data-testid="capacity-card"]')) as HTMLElement[]
    expect(cards).toHaveLength(3)
    expect(new Set(cards.map((c) => c.dataset.accent)).size).toBe(3)
    expect(cards.map((c) => c.querySelector('svg')?.getAttribute('data-truck')).sort()).toEqual(['box', 'reefer', 'van'])
    expect(cards.every((c) => c.style.getPropertyValue('--cap-accent') === c.dataset.accent)).toBe(true)
  })

  it('keeps a multi-day card the same color on every day it shows', async () => {
    seed({ id: 'span', availableFrom: '2026-11-27', availableTo: '2026-11-29' }, { id: 'one', availableFrom: '2026-11-28', availableTo: '2026-11-28' })
    render(board())
    await loaded()
    const colors = ['2026-11-27', '2026-11-28', '2026-11-29'].map((d) => (column(d).querySelector('[data-card-id="span"]') as HTMLElement).dataset.accent)
    expect(new Set(colors).size).toBe(1)
    const one = (column('2026-11-28').querySelector('[data-card-id="one"]') as HTMLElement).dataset.accent
    expect(one).not.toBe(colors[0])
  })

  it('shows the status pill, and greys a covered card', async () => {
    seed({ id: 'open1' }, { id: 'done1', status: 'COVERED' })
    render(board())
    await loaded()
    const open = column('2026-11-27').querySelector('[data-card-id="open1"]') as HTMLElement
    const done = column('2026-11-27').querySelector('[data-card-id="done1"]') as HTMLElement
    expect(within(open).getByText('Open')).toBeTruthy()
    expect(done.dataset.status).toBe('COVERED')
    expect(within(done).getByText('Covered', { selector: '.cap-pill' })).toBeTruthy()
  })

  it('shows one column per day of the range', async () => {
    render(board())
    await screen.findByText('Fri Nov 27')
    expect(screen.getByText('Sat Nov 28')).toBeTruthy()
    expect(screen.getByText('Sun Nov 29')).toBeTruthy()
    expect(document.querySelectorAll('section[data-day]')).toHaveLength(3)
    expect(screen.getAllByText('No trucks to fill')).toHaveLength(3)
  })

  it('adds a card from the form, and it is still there after the board is reopened', async () => {
    const first = render(board())
    await screen.findByText('Fri Nov 27')
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    fireEvent.change(screen.getByLabelText(/Origin/), { target: { value: 'Joliet, IL' } })
    fireEvent.change(screen.getByLabelText(/Equipment/), { target: { value: 'Reefer' } })
    fireEvent.change(screen.getByLabelText(/Length/), { target: { value: '53' } })
    fireEvent.change(screen.getByLabelText(/Min. rate/), { target: { value: '2.75' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }))
    await within(column('2026-11-27')).findByText('Joliet, IL → anywhere')
    expect(within(column('2026-11-27')).getByText('$2.75/mi')).toBeTruthy()
    expect(server.board.cards).toHaveLength(1)

    first.unmount()
    render(board())
    await loaded()
    await within(column('2026-11-27')).findByText('Joliet, IL → anywhere')
  })

  it('adds radius and times from the form and shows them on the card', async () => {
    render(board())
    await screen.findByText('Fri Nov 27')
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    fireEvent.change(screen.getByLabelText(/Origin/), { target: { value: 'Joliet, IL' } })
    fireEvent.change(screen.getByLabelText(/Equipment/), { target: { value: 'Reefer' } })
    fireEvent.change(screen.getByLabelText(/Length/), { target: { value: '53' } })
    expect(screen.queryByLabelText(/Destination radius/)).toBeNull()
    fireEvent.change(screen.getByLabelText(/Destination \(/), { target: { value: 'Atlanta, GA' } })
    fireEvent.change(screen.getByLabelText(/Pickup radius/), { target: { value: '50' } })
    fireEvent.change(screen.getByLabelText(/Destination radius/), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText(/Pickup time from/), { target: { value: '08:00' } })
    fireEvent.change(screen.getByLabelText(/Pickup time to/), { target: { value: '12:00' } })
    fireEvent.change(screen.getByLabelText(/Delivery time from/), { target: { value: '14:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }))
    await within(column('2026-11-27')).findByText('Joliet, IL · 50 mi → Atlanta, GA · 100 mi')
    expect(within(column('2026-11-27')).getByText('PU 8:00a–12:00p · DEL 2:00p')).toBeTruthy()
  })

  it('picks equipment from a list that fills the length, keeps the length editable, and shows maximum weight', async () => {
    seed({ equipment: 'Dry Van', weightLbs: 40000, referenceId: 'R9', contactPhone: '555-0100' })
    render(board())
    await loaded()
    const old = await within(column('2026-11-27')).findByTestId('capacity-card')
    expect(old.textContent).toContain('max 40,000 lb')
    expect(old.textContent).toContain('Dry Van')
    expect(old.textContent).not.toContain('R9')
    expect(old.textContent).not.toContain('555-0100')
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    const length = screen.getByLabelText(/Length/) as HTMLInputElement
    expect(length.value).toBe('53') // Van is the default
    fireEvent.change(screen.getByLabelText(/Equipment/), { target: { value: 'Box truck' } })
    expect(length.value).toBe('18')
    fireEvent.change(length, { target: { value: '20' } })
    expect(length.value).toBe('20')
    expect(screen.queryByLabelText(/Reference/)).toBeNull()
    expect(screen.queryByLabelText(/Contact phone/)).toBeNull()
    expect(screen.getByLabelText(/Maximum weight/)).toBeTruthy()
  })

  it('names a pickup window that ends before it starts', async () => {
    render(board())
    await screen.findByText('Fri Nov 27')
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    fireEvent.change(screen.getByLabelText(/Origin/), { target: { value: 'Joliet, IL' } })
    fireEvent.change(screen.getByLabelText(/Equipment/), { target: { value: 'Reefer' } })
    fireEvent.change(screen.getByLabelText(/Length/), { target: { value: '53' } })
    fireEvent.change(screen.getByLabelText(/Pickup time from/), { target: { value: '12:00' } })
    fireEvent.change(screen.getByLabelText(/Pickup time to/), { target: { value: '08:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Pickup window ends before it starts/)
    expect(server.board.cards).toHaveLength(0)
  })

  it('names what is missing instead of saving an incomplete card', async () => {
    render(board())
    await screen.findByText('Fri Nov 27')
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    fireEvent.change(screen.getByLabelText(/Origin/), { target: { value: 'Joliet, IL' } })
    fireEvent.change(screen.getByLabelText(/Length/), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Length is required/)
    expect(server.board.cards).toHaveLength(0)
  })

  it('lists a multi-day card on every day it is offered', async () => {
    seed({ availableTo: '2026-11-28' })
    render(board())
    await loaded()
    await within(column('2026-11-27')).findByTestId('capacity-card')
    expect(within(column('2026-11-28')).getAllByTestId('capacity-card')).toHaveLength(1)
    expect(within(column('2026-11-29')).queryByTestId('capacity-card')).toBeNull()
  })

  it('moves a card to another day when it is dragged there', async () => {
    seed({})
    render(board())
    await loaded()
    const card = await within(column('2026-11-27')).findByTestId('capacity-card')
    const dt = dataTransfer()
    fireEvent.dragStart(card, { dataTransfer: dt })
    fireEvent.dragOver(column('2026-11-29'), { dataTransfer: dt })
    fireEvent.drop(column('2026-11-29'), { dataTransfer: dt })
    await within(column('2026-11-29')).findByTestId('capacity-card')
    expect(within(column('2026-11-27')).queryByTestId('capacity-card')).toBeNull()
    expect((server.board.cards[0] as { availableFrom: string }).availableFrom).toBe('2026-11-29')
  })

  it('marks a card covered, greys it, and hides covered cards on request', async () => {
    seed({}, { origin: 'Atlanta, GA' })
    render(board())
    await loaded()
    await loaded()
    fireEvent.click(within(column('2026-11-27')).getAllByRole('button', { name: 'Mark covered' })[0])
    await waitFor(() => expect(within(column('2026-11-27')).getAllByTestId('capacity-card').map((c) => c.getAttribute('data-status'))).toEqual(['OPEN', 'COVERED']))
    expect(screen.getByTestId('count-2026-11-27').textContent).toBe('1 open · 1 covered')
    fireEvent.click(screen.getByLabelText('Show covered'))
    expect(within(column('2026-11-27')).getAllByTestId('capacity-card')).toHaveLength(1)
    expect(screen.getByTestId('count-2026-11-27').textContent).toBe('1 open · 1 covered')
    fireEvent.click(screen.getByLabelText('Show covered'))
    fireEvent.click(within(column('2026-11-27')).getByRole('button', { name: 'Reopen card' }))
    await waitFor(() => expect(screen.getByTestId('count-2026-11-27').textContent).toBe('2 open'))
  })

  it('deletes a card, offering Undo', async () => {
    seed({})
    const { toast } = await import('sonner')
    render(board())
    await loaded()
    await within(column('2026-11-27')).findByTestId('capacity-card')
    fireEvent.click(within(column('2026-11-27')).getByRole('button', { name: 'Delete card' }))
    await waitFor(() => expect(within(column('2026-11-27')).queryByTestId('capacity-card')).toBeNull())
    expect(toast).toHaveBeenCalledWith('Card deleted', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
    const undo = (toast as unknown as { mock: { calls: [string, { action: { onClick: () => void } }][] } }).mock.calls.at(-1)![1].action.onClick
    undo()
    await within(column('2026-11-27')).findByTestId('capacity-card')
  })
})

// Keep the shared type import honest for the test's seed helper.
export type { BoardData }
