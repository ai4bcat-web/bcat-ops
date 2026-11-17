// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CarrierOffersPanel } from './CarrierOffersPanel'
import type { OffersTarget } from './offersTarget'

const REAL: OffersTarget = {
  id: 's-real', number: 'L777', origin: 'Chicago', destination: 'Dallas', pickupAt: null, deliveryAt: null,
  equipment: 'Van', customerRateCents: 150_000, targetBuyCents: null,
}

describe('CarrierOffersPanel', () => {
  it('shows the load header and "No offers yet", with no demo data', () => {
    render(<CarrierOffersPanel target={REAL} onClose={vi.fn()} />)
    expect(screen.getByTestId('offers-panel')).toBeTruthy()
    expect(screen.getByText('L777')).toBeTruthy()
    expect(screen.getByText('No offers yet')).toBeTruthy()
    expect(screen.queryByText('DEMO DATA')).toBeNull()
  })
})
