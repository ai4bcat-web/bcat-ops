// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TrackingModeNotSetRowChip } from './TrackingModeNotSetChip'

vi.mock('@/lib/apiClient', () => ({ setTrackingPrefs: vi.fn() }))

const row = (over: Record<string, unknown> = {}) => ({ id: 's1', number: '20001', revDivision: 'BROKERAGE', assignmentType: 'CARRIER', status: 'DISPATCHED', ...over })
const show = (r: ReturnType<typeof row>) => render(<MemoryRouter><TrackingModeNotSetRowChip row={r} /></MemoryRouter>)

describe('board row tracking chip', () => {
  it('shows not sent, sent and accepted on a Brokerage load', () => {
    const a = show(row()); expect(screen.getByTestId('tracking-not-set')).toHaveTextContent('Tracking link not sent'); a.unmount()
    const b = show(row({ trackingStartedAt: '2026-11-11T14:00:00Z' })); expect(screen.getByTestId('tracking-link-sent')).toHaveTextContent('Tracking link sent'); b.unmount()
    show(row({ trackingStartedAt: '2026-11-11T14:00:00Z', trackingAcceptedAt: '2026-11-11T14:05:00Z' }))
    expect(screen.getByTestId('tracking-link-accepted')).toHaveTextContent('Driver accepted')
  })
  it('shows nothing on a load that is not Brokerage', () => {
    const { container } = show(row({ revDivision: 'ASSETS', trackingStartedAt: '2026-11-11T14:00:00Z' }))
    expect(container).toBeEmptyDOMElement()
  })
})
