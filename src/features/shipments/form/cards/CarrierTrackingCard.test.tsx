// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierTrackingCard } from './CarrierTrackingCard'
import { emptyValues, NO_LOCKS } from '../model'
import type { FormCtx } from '../sectionProps'
import { makeCtx, makeForm, savedBundle } from '../sections/ah5TestKit'
import type { CustomerRecord, TmsSettings } from '@/types/tms'

// The real apiClient builds its Amplify client on import; stub the client so nothing needs Amplify.configure().
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))
vi.mock('@/features/shipments/components/HistorySection', () => ({ HistorySection: () => <div data-testid="history-feed" /> }))
vi.mock('@/hooks/useLoadTracking', () => ({
  useLoadTracking: () => ({
    events: [{
      id: 'e1', at: '2026-01-02T10:00:00.000Z', type: 'LOCATION_UPDATE', source: 'MANUAL', city: 'Joliet', state: 'IL',
      note: 'Rolling, 2 h out', createdBy: 'x',
    }],
    lastKnown: { at: '2026-01-02T10:00:00.000Z', lat: 41.5, lng: -88.1, description: 'Joliet, IL', source: 'MANUAL' },
    nowMs: Date.parse('2026-01-02T12:00:00.000Z'), links: [], refresh: vi.fn(),
  }),
}))
const api = vi.hoisted(() => ({
  setTrackingPrefs: vi.fn(async () => ({ shipment: {} })),
  saveLoadCheckCallPlan: vi.fn(async () => ({ plan: null })),
  assignTracker: vi.fn(async () => ({ updated: ['shp-1'], skipped: [] })),
  listTrackingLinksByShipment: vi.fn(async () => []),
  sendTrackingLink: vi.fn(async () => ({ smsStatus: 'SENT', smsError: null })),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('./CarrierCard', () => ({ CarrierCard: () => <div data-testid="carrier-block" /> }))
vi.mock('@/components/TrackerPicker', () => ({
  TrackerPicker: ({ value, onChange, disabled }: { value: string | null; onChange: (id: string | null) => void; disabled?: boolean }) => (
    <select aria-label="Tracker" data-testid="tracker-stub" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="" /><option value="u9">Nina</option>
    </select>
  ),
}))
vi.mock('@/hooks/useTruckConfigs', () => ({ useDriverPhones: () => ({ work: null, personal: null, truckNumber: null }) }))

function show(ctxOver: Partial<FormCtx>, mode: 'create' | 'edit' = 'create') {
  const values = emptyValues()
  const ctx = makeCtx({ mode, ...ctxOver })
  render(
    <MemoryRouter>
      <CarrierTrackingCard values={values} update={vi.fn()} form={makeForm(values)} ctx={ctx} issues={[]} mode={mode} locked={NO_LOCKS} />
    </MemoryRouter>,
  )
}

const text = (id: string) => screen.getByTestId(id).textContent ?? ''

describe('CarrierTrackingCard edit mode', () => {
  const bundle = savedBundle({ loadCarriers: [{ id: 'lc1', status: 'ACTIVE', kind: 'CARRIER', carrierName: 'Ivan' }] })
  const customer = { id: 'c1', name: 'Acme', trackingMode: 'AGENT', trackingMethod: 'BOTH', driverSmsTarget: 'PERSONAL' } as unknown as CustomerRecord
  const staff = [{ id: 'u1', email: 'tess@example.invalid', name: 'Tess Tracker' }] as unknown as FormCtx['directory']['staff']
  const tracked = { ...bundle, shipment: { ...bundle.shipment, trackerId: 'u1' } }

  it('shows status, method, assignee, last check call, position/ETA strip and the Load Tracking link', () => {
    show({ bundle: tracked, customer, directory: { customers: [], locations: [], carriers: [], staff } }, 'edit')
    expect(text('card-tracking-status')).toMatch(/open/i)
    expect(text('card-tracking-method')).toBe('AI agent · E-mail + SMS · personal phone')
    expect(text('card-tracking-assignee')).toContain('Tess Tracker')
    expect(text('card-tracking-last-call')).toContain('Joliet, IL')
    expect(text('card-tracking-last-call')).toContain('Rolling, 2 h out')
    expect(text('last-known')).toContain('Joliet, IL')
    expect(screen.getByTestId('strip-next-check')).toBeTruthy()
    expect(screen.getByTestId('strip-pod')).toBeTruthy()
    expect(screen.getByTestId('card-tracking-open').getAttribute('href')).toBe('/tms/tracking?shipment=shp-1')
    expect(screen.getByTestId('card-tracking-updates').textContent).toContain('Activity list on the right')
  })

  it('says Unassigned with no tracker and offers no entry form', () => {
    show({ bundle, customer }, 'edit')
    expect(text('card-tracking-assignee')).toBe('Unassigned')
    expect(screen.queryByLabelText('Message')).toBeNull()
  })
})

describe('CarrierTrackingCard create mode (planned setup)', () => {
  const customer = { id: 'c1', name: 'Acme', trackingMode: 'MANUAL', trackingMethod: 'SMS', driverSmsTarget: 'WORK_ONLY' } as unknown as CustomerRecord

  it('shows the customer defaults, the Step V automation and the coverage sentence', () => {
    const settings = {
      trackingAutomation: { global: { checkCallsAuto: true, podAuto: false }, divisions: {} },
    } as unknown as TmsSettings
    show({ customer, settings })
    expect(text('card-tracking-planned-mode')).toBe('Manual')
    expect(text('card-tracking-planned-method')).toBe('SMS to driver')
    expect(text('card-tracking-planned-sms')).toBe('Truck work phone only')
    expect(text('card-tracking-planned-automation')).toContain('Automatic check calls on')
    expect(text('card-tracking-planned-automation')).toContain('Automatic POD requests off')
    expect(text('card-tracking-after-create')).toBe('Tracking is chosen when the carrier is booked.')
    expect(screen.queryByTestId('tracking-mode-control')).toBeNull()
    expect(screen.getByTestId('carrier-block')).toBeTruthy()
    expect(screen.queryByTestId('card-tracking-open')).toBeNull()
  })

  it('asks for a customer when none is picked', () => {
    show({})
    expect(text('card-tracking-planned-mode')).toBe('Pick a customer')
  })
})

describe('CarrierTrackingCard: the tracking link', () => {
  const after = '2026-11-07T00:00:00.000Z'
  const customer = { id: 'c1', name: 'Acme' } as unknown as CustomerRecord
  const booked = (carrier: object = {}, shipment: object = {}) => {
    const b = savedBundle({ loadCarriers: [{ id: 'lc1', status: 'ACTIVE', kind: 'CARRIER', carrierName: 'Ivan', ...carrier }] })
    return { ...b, shipment: { ...b.shipment, createdAt: after, ...shipment } }
  }
  beforeEach(() => { vi.clearAllMocks() })

  it('before a carrier is booked it asks for the driver and offers no send', () => {
    const b = savedBundle()
    show({ bundle: { ...b, shipment: { ...b.shipment, createdAt: after } } as never, customer }, 'edit')
    expect(screen.queryByTestId('tracking-link-send')).toBeNull()
    expect(screen.getByTestId('card-tracking-after-create')).toBeTruthy()
  })

  it('a booked load with no driver says the link is not set and names what is missing', async () => {
    show({ bundle: booked() as never, customer }, 'edit')
    expect((await screen.findByTestId('tracking-link-state')).textContent).toBe('Tracking link not set')
    expect((screen.getByTestId('tracking-link-send') as HTMLButtonElement).disabled).toBe(true)
    expect(text('tracking-link-missing')).toBe('Needs driver name, driver phone, truck number, trailer number')
  })

  it('with the driver, truck and trailer entered the link is sent to the driver phone', async () => {
    show({ bundle: booked({ driverName: 'Tony', driverPhone: '+18392358582', truckNumber: '743', trailerNumber: 'T9' }) as never, customer }, 'edit')
    const send = await screen.findByTestId('tracking-link-send')
    expect((send as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(send)
    await waitFor(() => expect(api.sendTrackingLink).toHaveBeenCalledWith({ loadCarrierId: 'lc1', via: 'SMS', to: '+18392358582' }))
  })

  it('an Ivan Cartage load is followed by the driver GPS and needs no link', () => {
    show({ bundle: booked({}, { revDivision: 'ASSETS' }) as never, customer }, 'edit')
    expect(screen.getByTestId('tracking-gps-note')).toBeTruthy()
    expect(screen.queryByTestId('tracking-link-send')).toBeNull()
  })
})
