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

  it('names what is missing instead of saving an incomplete card', async () => {
    render(board())
    await screen.findByText('Fri Nov 27')
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    fireEvent.change(screen.getByLabelText(/Origin/), { target: { value: 'Joliet, IL' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Equipment is required/)
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
    await within(column('2026-11-27')).findAllByTestId('capacity-card')
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
