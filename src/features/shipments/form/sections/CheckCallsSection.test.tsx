// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CheckCallsSection } from './CheckCallsSection'
import { emptyCheckCall, emptyValues } from '../model'
import { makeCtx, makeForm, savedBundle } from './ah5TestKit'

vi.mock('@/hooks/useLoadTracking', () => ({
  useLoadTracking: () => ({
    events: [{ id: 'e1', at: '2026-01-02T10:00:00.000Z', type: 'LOCATION_UPDATE', source: 'MANUAL', city: 'Joliet', state: 'IL', createdBy: 'x' }],
    lastKnown: null, nowMs: Date.parse('2026-01-02T12:00:00.000Z'), links: [], refresh: vi.fn(),
  }),
}))
vi.mock('@/hooks/useTruckConfigs', () => ({ useDriverPhones: () => ({ work: null, personal: null, truckNumber: null }) }))
vi.mock('../../workstations/tracking/trackingSummary', () => ({
  summaryOf: () => ({
    driver: { name: null, truckNumber: null }, phones: {}, lastKnown: null, eta: null,
    nextCheck: { state: 'NONE', at: null, minutes: null }, pod: null,
    carrier: { label: 'No carrier', contactName: null, phone: null, email: null },
  }),
}))
vi.mock('../../workstations/tracking/TrackingSummaryStrip', () => ({ TrackingSummaryStrip: () => <div data-testid="tracking-strip" /> }))

const renderIt = (ctx = makeCtx()) =>
  render(
    <MemoryRouter>
      <CheckCallsSection value={emptyCheckCall()} onChange={vi.fn()} ctx={ctx} form={makeForm(emptyValues())} />
    </MemoryRouter>,
  )

describe('CheckCallsSection (read-only Load Tracking preview)', () => {
  it('says it is available after creation, and offers no entry form, in create mode', () => {
    renderIt()
    expect(screen.getByTestId('checkcalls-after-create')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByLabelText('Message')).toBeNull()
  })

  it('shows the summary strip, recent calls and a link into Load Tracking for a saved shipment', () => {
    renderIt(makeCtx({ mode: 'edit', bundle: savedBundle() }))
    expect(screen.getByTestId('tracking-strip')).toBeTruthy()
    expect(screen.getAllByTestId('recent-check-call')).toHaveLength(1)
    expect(screen.getByText('Open in Load Tracking').getAttribute('href')).toBe('/tms/tracking?shipment=shp-1')
    expect(screen.queryByLabelText('Add Check Call')).toBeNull()
  })
})
