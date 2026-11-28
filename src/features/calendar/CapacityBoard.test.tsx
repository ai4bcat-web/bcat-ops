// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import type { CapacityOp } from '@/lib/capacityBoard'

// The "server": the same pure rules the Lambda applies, over a board that outlives a remount.
const server = vi.hoisted(() => ({ board: { cards: [] } as { cards: unknown[]; noGoStates?: string[] }, n: 0 }))
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
    seed({ id: 'a', equipment: 'Dry Van' }, { id: 'b', equipment: 'Straight Truck', lengthFt: 18 }, { id: 'c', equipment: 'Reefer' })
    render(board())
    await loaded()
    const cards = Array.from(column('2026-11-27').querySelectorAll('[data-testid="capacity-card"]')) as HTMLElement[]
    expect(cards).toHaveLength(3)
    expect(new Set(cards.map((c) => c.dataset.accent)).size).toBe(3)
    expect(cards.map((c) => c.querySelector('svg')?.getAttribute('data-truck')).sort()).toEqual(['reefer', 'straight', 'van'])
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
    expect((screen.getByLabelText(/Destination radius/) as HTMLInputElement).disabled).toBe(true)
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
    expect(length.value).toBe('53') // Dry Van is the default
    expect((screen.getByLabelText(/Equipment/) as HTMLSelectElement).value).toBe('Dry Van')
    fireEvent.change(screen.getByLabelText(/Equipment/), { target: { value: 'Straight Truck' } })
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
    const markBtn = within(column('2026-11-27')).getAllByRole('button', { name: 'Mark as covered' })[0]
    expect(markBtn.textContent).toContain('Mark as covered')
    expect(markBtn.getAttribute('title')).toBe('Mark this truck as covered')
    fireEvent.click(markBtn)
    await waitFor(() => expect(within(column('2026-11-27')).getAllByTestId('capacity-card').map((c) => c.getAttribute('data-status'))).toEqual(['OPEN', 'COVERED']))
    expect(screen.getByTestId('count-2026-11-27').textContent).toBe('1 open · 1 covered')
    fireEvent.click(screen.getByLabelText('Show covered'))
    expect(within(column('2026-11-27')).getAllByTestId('capacity-card')).toHaveLength(1)
    expect(screen.getByTestId('count-2026-11-27').textContent).toBe('1 open · 1 covered')
    fireEvent.click(screen.getByLabelText('Show covered'))
    const reopenBtn = within(column('2026-11-27')).getByRole('button', { name: 'Reopen' })
    expect(reopenBtn.textContent).toContain('Reopen')
    expect(reopenBtn.getAttribute('title')).toBe('Move back to open')
    fireEvent.click(reopenBtn)
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

  it('shows an older Van / Box truck card by its trade name and selects it when edited', async () => {
    seed({ id: 'old1', equipment: 'Van' }, { id: 'old2', equipment: 'Box truck', lengthFt: 18 })
    render(board())
    await loaded()
    const cards = Array.from(column('2026-11-27').querySelectorAll('[data-testid="capacity-card"]')) as HTMLElement[]
    expect(cards.map((c) => c.textContent).join(' ')).toContain('Dry Van')
    expect(cards.map((c) => c.textContent).join(' ')).toContain('Straight Truck')
    expect(cards.map((c) => c.querySelector('svg')?.getAttribute('data-truck')).sort()).toEqual(['straight', 'van'])
    fireEvent.click(within(cards.find((c) => c.dataset.cardId === 'old2') as HTMLElement).getByRole('button', { name: 'Edit card' }))
    expect((screen.getByLabelText(/Equipment/) as HTMLSelectElement).value).toBe('Straight Truck')
  })
  it('shows the destination radius from the start, greyed with a hint until there is a destination, and clears it with "anywhere"', async () => {
    render(board())
    await screen.findByText('Fri Nov 27')
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    const radius = screen.getByLabelText(/Destination radius/) as HTMLInputElement
    expect(radius.disabled).toBe(true)
    expect(screen.getByText('Enter a destination to use a radius')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Destination \(/), { target: { value: 'Atlanta, GA' } })
    expect(radius.disabled).toBe(false)
    expect(screen.queryByText('Enter a destination to use a radius')).toBeNull()
    fireEvent.change(radius, { target: { value: '100' } })
    expect(radius.value).toBe('100')
    fireEvent.change(screen.getByLabelText(/Destination \(/), { target: { value: '' } })
    expect(radius.disabled).toBe(true)
    expect(radius.value).toBe('')
  })

  it('opens an existing card with both radii in the form', async () => {
    seed({ id: 'r1', origin: 'Joliet, IL', destination: 'Atlanta, GA', originRadiusMi: 50, destinationRadiusMi: 100 })
    render(board())
    await loaded()
    const card = await within(column('2026-11-27')).findByTestId('capacity-card')
    expect(card.textContent).toContain('Joliet, IL · 50 mi → Atlanta, GA · 100 mi')
    fireEvent.click(within(card).getByRole('button', { name: 'Edit card' }))
    expect((screen.getByLabelText(/Pickup radius/) as HTMLInputElement).value).toBe('50')
    expect((screen.getByLabelText(/Destination radius/) as HTMLInputElement).value).toBe('100')
  })

  it('shows "No states excluded" until a list is set, then the list on the strip and on every card', async () => {
    seed({ id: 'a' }, { id: 'b', origin: 'Dallas, TX' })
    render(board())
    await loaded()
    const strip = screen.getByTestId('capacity-nogo')
    expect(strip.textContent).toContain('No states excluded')
    expect(screen.queryAllByTestId('card-nogo')).toHaveLength(0)
    fireEvent.click(within(strip).getByRole('button', { name: /Edit states/ }))
    fireEvent.change(screen.getByLabelText('Search states'), { target: { value: 'cali' } })
    fireEvent.click(screen.getByRole('button', { name: /CA\s*California/ }))
    fireEvent.change(screen.getByLabelText('Search states'), { target: { value: 'new york' } })
    fireEvent.click(screen.getByRole('button', { name: /NY\s*New York/ }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByTestId('capacity-nogo').textContent).toContain('CA'))
    expect(server.board.noGoStates).toEqual(['CA', 'NY'])
    const lines = await screen.findAllByTestId('card-nogo')
    expect(lines).toHaveLength(2) // the one list applies to every card
    expect(lines[0].textContent).toContain('No-go: CA, NY')
  })

  it('selects shown states and clears them all in the picker, and a saved empty list goes back to "No states excluded"', async () => {
    server.board = { cards: [], noGoStates: ['CA', 'WA'] }
    render(board())
    await loaded()
    expect(screen.getByTestId('capacity-nogo').textContent).toContain('WA')
    fireEvent.click(screen.getByRole('button', { name: /Edit states/ }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(screen.getByText('No states selected')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search states'), { target: { value: 'north' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select shown' }))
    expect(screen.getByText('2 selected')).toBeTruthy() // North Carolina, North Dakota
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByTestId('capacity-nogo').textContent).toContain('No states excluded'))
    expect(server.board.noGoStates).toBeUndefined()
  })

  it('warns, without blocking, when a card is for an excluded state', async () => {
    server.board = { cards: [], noGoStates: ['CA'] }
    render(board())
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    expect(screen.queryByText(/We do not travel to CA/)).toBeNull()
    fireEvent.change(screen.getByLabelText(/Origin/), { target: { value: 'Los Angeles, CA' } })
    expect(screen.getAllByText('We do not travel to CA')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText(/Destination \(/), { target: { value: 'Fresno, CA 93650' } })
    expect(screen.getAllByText('We do not travel to CA')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText(/Destination \(/), { target: { value: 'Reno, NV' } })
    expect(screen.getAllByText('We do not travel to CA')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText(/Length/), { target: { value: '53' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }))
    await within(column('2026-11-27')).findByText('Los Angeles, CA → Reno, NV')
  })

  it('names who covered a card and when, keeps a history, and drops the line when it is reopened', async () => {
    seed({ id: 'h1', history: [{ action: 'created', by: 'dennis@bcatcorp.com', at: '2026-11-27T15:00:00.000Z' }] })
    render(board())
    await loaded()
    const card = await within(column('2026-11-27')).findByTestId('capacity-card')
    expect(within(card).queryByTestId('covered-by')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Mark as covered' }))
    const line = await within(column('2026-11-27')).findByTestId('covered-by')
    expect(line.textContent).toMatch(/^Covered by Dennis · \w{3} \w{3} \d+, \d+:\d{2} (AM|PM)$/)
    expect(within(column('2026-11-27')).getByText('Covered').getAttribute('title')).toContain('Covered by Dennis')
    fireEvent.click(within(column('2026-11-27')).getByRole('button', { name: 'History' }))
    const items = within(screen.getByTestId('card-history')).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('Marked covered by Dennis') // newest first
    expect(items[1].textContent).toContain('Created by Dennis')
    fireEvent.click(within(column('2026-11-27')).getByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(within(column('2026-11-27')).queryByTestId('covered-by')).toBeNull())
    expect(within(column('2026-11-27')).getAllByRole('listitem').map((i) => i.textContent).join(' ')).toContain('Reopened by Dennis')
  })

  it('shows an older covered card, which has no history, as Covered with no name and no History button', async () => {
    seed({ id: 'old', status: 'COVERED' })
    render(board())
    await loaded()
    const card = await within(column('2026-11-27')).findByTestId('capacity-card')
    expect(within(card).queryByTestId('covered-by')).toBeNull()
    expect(within(card).queryByRole('button', { name: 'History' })).toBeNull()
    expect(within(card).getByText('Covered')).toBeTruthy()
  })
})
