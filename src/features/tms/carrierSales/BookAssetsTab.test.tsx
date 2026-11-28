// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// The Assets tab draws the same Capacity board as the Calendar, over the one stored board, so the list of states we do not
// travel to and its line on each card are there too.
vi.mock('@/lib/apiClient', async () => {
  const lib = await import('@/lib/capacityBoard')
  return {
    getCapacityBoard: async () => lib.parseCapacityBoard({
      cards: [{ id: 'a', status: 'OPEN', availableFrom: lib.todayChicagoYmd(), availableTo: lib.todayChicagoYmd(), origin: 'Chicago, IL', destination: '', equipment: 'Dry Van', loadType: 'FULL', lengthFt: 53, createdAt: '2026-11-27T10:00:00.000Z', createdBy: 'x', updatedAt: '2026-11-27T10:00:00.000Z', updatedBy: 'x' }],
      noGoStates: ['CA', 'NY'],
    }),
    capacityBoardOp: async () => { throw new Error('not used') },
  }
})
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'dennis@bcatcorp.com' } }) }))
vi.mock('@/features/tms/grid/denseCardLayout', () => ({ usePhoneWidth: () => false }))
vi.mock('@/features/tms/kit/CityInput', () => ({ CityInput: () => <input /> }))

import { BookAssetsTab } from './BookAssetsTab'

afterEach(cleanup)

describe('BookAssetsTab', () => {
  it('shows the states we do not travel to on the strip and on each card', async () => {
    render(<BookAssetsTab />)
    const strip = await screen.findByTestId('capacity-nogo')
    expect(strip.textContent).toContain('We do not travel to:')
    expect(strip.textContent).toContain('CA')
    expect(strip.textContent).toContain('NY')
    expect((await screen.findByTestId('card-nogo')).textContent).toContain('No-go: CA, NY')
  })
})
