// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { CarrierOffersPanel } from './CarrierOffersPanel'
import { DemoLoads } from './DemoLoads'
import { DEMO_SHIPMENTS, demoShipmentFor } from './demoOffers'
import { targetFromDemo, type OffersTarget } from './offersTarget'

const REAL: OffersTarget = {
  id: 's-real', number: 'L777', origin: 'Chicago', destination: 'Dallas', pickupAt: null, deliveryAt: null,
  equipment: 'Van', customerRateCents: 150_000, targetBuyCents: null, demo: null,
}

describe('CarrierOffersPanel', () => {
  it('shows header, summary, both channels with count chips and the DEMO banner for a demo load', () => {
    render(<CarrierOffersPanel target={targetFromDemo(demoShipmentFor('DEMO-4105')!)} onClose={vi.fn()} />)
    const panel = screen.getByTestId('offers-panel')
    expect(within(panel).getAllByText('DEMO DATA').length).toBeGreaterThan(0)
    expect(screen.getByTestId('demo-banner').textContent).toMatch(/fabricated demo data/i)
    expect(within(panel).getByText('Voice negotiator (Aiden)')).toBeTruthy()
    expect(within(panel).getByText('Email negotiator')).toBeTruthy()
    expect(screen.getByTestId('voice-count').textContent).toBe('3')
    expect(screen.getByTestId('email-count').textContent).toBe('2')
    expect(screen.getByTestId('lowest-rate').textContent).toBe('$1,420.00')
    expect(within(screen.getByTestId('offers-summary')).getByText('Booked')).toBeTruthy()
    expect(within(screen.getByTestId('channel-voice')).getByText('Asked for a person')).toBeTruthy()
  })

  it('opens the call drawer with quote range and transcript bubbles', () => {
    render(<CarrierOffersPanel target={targetFromDemo(demoShipmentFor('DEMO-4101')!)} onClose={vi.fn()} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Open call from/ })[0]!)
    const drawer = screen.getByTestId('call-drawer')
    expect(within(drawer).getByText('$2,200.00 → $2,320.00')).toBeTruthy()
    expect(within(drawer).getByText('Cowtown Express, this is Aiden. Which load are you calling about?')).toBeTruthy()
    expect(within(drawer).getAllByText('AIDEN').length).toBeGreaterThan(1)
    expect(within(drawer).getAllByText('CARRIER').length).toBeGreaterThan(0)
  })

  it('opens the email thread drawer with highlighted rates on each message', () => {
    render(<CarrierOffersPanel target={targetFromDemo(demoShipmentFor('DEMO-4102')!)} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Open email thread with Blue Ridge Cold Chain/ }))
    const drawer = screen.getByTestId('thread-drawer')
    expect(within(drawer).getAllByTestId('mail-rate')).toHaveLength(6)
    expect(within(drawer).getAllByText('AI negotiator').length).toBe(3)
    expect(within(drawer).getAllByText(/Our counter/).length).toBe(3)
  })

  it('shows "No offers yet" and no demo offers for a real load', () => {
    render(<CarrierOffersPanel target={REAL} onClose={vi.fn()} />)
    expect(screen.getByText('No offers yet')).toBeTruthy()
    expect(screen.queryByTestId('channel-voice')).toBeNull()
    expect(screen.queryByText('DEMO DATA')).toBeNull()
  })
})

describe('DemoLoads', () => {
  it('lists every demo shipment with a DEMO DATA badge and opens one on click', () => {
    const onOpen = vi.fn()
    render(<DemoLoads onOpen={onOpen} />)
    const rows = screen.getAllByTestId('demo-row')
    expect(rows).toHaveLength(DEMO_SHIPMENTS.length)
    rows.forEach((r) => expect(within(r).getByText('DEMO DATA')).toBeTruthy())
    fireEvent.click(rows[1]!)
    expect(onOpen).toHaveBeenCalledWith(DEMO_SHIPMENTS[1])
  })
})
