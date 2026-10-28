// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { StopCards, type StopActionInput } from './components/StopCards'
import type { Stop } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {}
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const stops: Stop[] = [
  { id: 'p1', type: 'pickup', sequence: 0, appt: '2026-04-01T13:00:00.000Z', driverId: null, name: 'Acme Dock 4', city: 'Chicago, IL' },
  { id: 'd1', type: 'delivery', sequence: 1, appt: '2026-04-02T13:00:00.000Z', driverId: null, name: 'Globex DC', city: 'Dallas, TX' },
]

const onAction = vi.fn<(input: StopActionInput) => Promise<void>>(async () => {})

beforeEach(() => { onAction.mockClear() })

/** Radix opens its menu on pointerdown, which jsdom's click helper does not send. */
function openMenu(label: string) {
  fireEvent.pointerDown(screen.getByLabelText(label), { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

describe('StopCards menu', () => {
  it('renders one card per stop with its appointment and facility', () => {
    render(<StopCards stops={stops} locations={[]} onAction={onAction} />)
    expect(screen.getByText('Acme Dock 4')).toBeTruthy()
    expect(screen.getByText('Globex DC')).toBeTruthy()
    expect(screen.getByText('PU 1')).toBeTruthy()
    expect(screen.getByText('DEL 2')).toBeTruthy()
  })

  it('swaps a stop with the one after it', async () => {
    render(<StopCards stops={stops} locations={[]} onAction={onAction} />)
    openMenu('Stop 1 actions')
    await waitFor(() => expect(screen.getByText('Swap with next')).toBeTruthy())
    fireEvent.click(screen.getByText('Swap with next'))

    await waitFor(() => expect(onAction).toHaveBeenCalledWith({
      op: 'SWAP', stopId: 'p1', patch: { withStopId: 'd1' },
    }))
  })

  it('cannot swap the first stop with a previous one', async () => {
    render(<StopCards stops={stops} locations={[]} onAction={onAction} />)
    openMenu('Stop 1 actions')
    await waitFor(() => expect(screen.getByText('Swap with previous')).toBeTruthy())
    fireEvent.click(screen.getByText('Swap with previous'))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('writes in and out times as one SET_TIMES op', async () => {
    render(<StopCards stops={stops} locations={[]} onAction={onAction} />)
    openMenu('Stop 1 actions')
    await waitFor(() => expect(screen.getByText('Add In/Out times')).toBeTruthy())
    fireEvent.click(screen.getByText('Add In/Out times'))

    await waitFor(() => expect(screen.getByLabelText('In time')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('In time'), { target: { value: '2026-04-01T08:00' } })
    fireEvent.change(screen.getByLabelText('Out time'), { target: { value: '2026-04-01T09:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1))
    const input = onAction.mock.calls[0][0]
    expect(input.op).toBe('SET_TIMES')
    expect(input.stopId).toBe('p1')
    expect(String(input.patch.arrivedAt) < String(input.patch.departedAt)).toBe(true)
  })

  it('refuses an out time before the in time', async () => {
    render(<StopCards stops={stops} locations={[]} onAction={onAction} />)
    openMenu('Stop 1 actions')
    await waitFor(() => expect(screen.getByText('Add In/Out times')).toBeTruthy())
    fireEvent.click(screen.getByText('Add In/Out times'))

    await waitFor(() => expect(screen.getByLabelText('In time')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('In time'), { target: { value: '2026-04-01T09:30' } })
    fireEvent.change(screen.getByLabelText('Out time'), { target: { value: '2026-04-01T08:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.getByText('Out time is before the in time.')).toBeTruthy())
    expect(onAction).not.toHaveBeenCalled()
  })

  it('turns CODE=value lines into stop references', async () => {
    render(<StopCards stops={stops} locations={[]} onAction={onAction} />)
    openMenu('Stop 2 actions')
    await waitFor(() => expect(screen.getByText('References & notes')).toBeTruthy())
    fireEvent.click(screen.getByText('References & notes'))

    await waitFor(() => expect(screen.getByLabelText('References')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('References'), { target: { value: 'PO=4471\nBOL=88121' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onAction).toHaveBeenCalledWith({
      op: 'SET_REFS',
      stopId: 'd1',
      patch: {
        refs: [
          { code: 'PO', value: '4471', level: 'STOP', visibility: 'ALL' },
          { code: 'BOL', value: '88121', level: 'STOP', visibility: 'ALL' },
        ],
        stopNotes: null,
      },
    }))
  })

  it('deletes a stop straight from the menu', async () => {
    render(<StopCards stops={stops} locations={[]} onAction={onAction} />)
    openMenu('Stop 2 actions')
    await waitFor(() => expect(screen.getByText('Delete stop')).toBeTruthy())
    fireEvent.click(screen.getByText('Delete stop'))

    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ op: 'REMOVE', stopId: 'd1', patch: {} }))
  })

  it('offers no edits at all on a read-only shipment', () => {
    render(<StopCards stops={stops} locations={[]} readOnly onAction={onAction} />)
    expect((screen.getByLabelText('Stop 1 actions') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Additional stop/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
