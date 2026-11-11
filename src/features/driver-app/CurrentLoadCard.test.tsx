// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { CurrentLoadCard } from './CurrentLoadCard'

const api = vi.hoisted(() => ({ fetchOpenLoads: vi.fn() }))
vi.mock('./driverApi', () => api)

const mk = (id: string, pro: string, lane: string) => ({
  id, proNumber: pro, lane, originCity: null, destinationCity: null, pickupAppt: '2026-11-11T14:00:00Z', deliveryAppt: '2026-11-11T20:00:00Z',
  customer: 'Acme', hasRateConfirmation: true, hasPod: false,
})

describe('CurrentLoadCard', () => {
  it('shows the second delivery for today under the current load', async () => {
    api.fetchOpenLoads.mockResolvedValue({ load: mk('l1', '20001', 'Joliet to Chicago'), alsoOpen: [mk('l2', '20002', 'Chicago to Gary')] })
    render(<CurrentLoadCard />)
    expect(await screen.findByText('Joliet to Chicago')).toBeInTheDocument()
    const also = screen.getByTestId('also-open-loads')
    expect(also).toHaveTextContent('PRO 20002')
    expect(also).toHaveTextContent('Chicago to Gary')
  })

  it('shows no extra list when there is only one open load', async () => {
    api.fetchOpenLoads.mockResolvedValue({ load: mk('l1', '20001', 'Joliet to Chicago'), alsoOpen: [] })
    render(<CurrentLoadCard />)
    await screen.findByText('Joliet to Chicago')
    expect(screen.queryByTestId('also-open-loads')).toBeNull()
  })
})
