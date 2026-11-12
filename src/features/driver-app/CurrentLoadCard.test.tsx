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

  it('lists the documents the office asked for on this load, with what is already in', async () => {
    api.fetchOpenLoads.mockResolvedValue({
      load: {
        ...mk('l1', '20001', 'Joliet to Chicago'),
        requiredDocs: [
          { type: 'POD', label: 'Proof of delivery', done: true },
          { type: 'LUMPER_RECEIPT', label: 'Lumper receipt', done: false },
        ],
      },
      alsoOpen: [],
    })
    render(<CurrentLoadCard />)
    const list = await screen.findByTestId('load-required-docs')
    expect(list).toHaveTextContent('Documents needed for this load')
    expect(screen.getByTestId('load-required-doc-POD')).toHaveAttribute('data-done', 'true')
    expect(screen.getByTestId('load-required-doc-LUMPER_RECEIPT')).toHaveAttribute('data-done', 'false')
    expect(list).toHaveTextContent('Tap Send next to each one')
    // A missing extra links straight to an additional-document scan of that type, for this load.
    const send = screen.getByTestId('send-required-doc-LUMPER_RECEIPT')
    expect(send.getAttribute('href')).toBe('/driver/scan?kind=doc&docType=LUMPER_RECEIPT&pro=20001&loadId=l1')
    expect(screen.queryByTestId('send-required-doc-POD')).toBeNull()
  })

  it('keeps the POD-only notice when nothing extra was asked for', async () => {
    api.fetchOpenLoads.mockResolvedValue({
      load: { ...mk('l1', '20001', 'Joliet to Chicago'), requiredDocs: [{ type: 'POD', label: 'Proof of delivery', done: false }] },
      alsoOpen: [],
    })
    render(<CurrentLoadCard />)
    await screen.findByText('Joliet to Chicago')
    expect(screen.queryByTestId('load-required-docs')).toBeNull()
    expect(screen.getByText(/Send the POD for this load/)).toBeInTheDocument()
  })
})
