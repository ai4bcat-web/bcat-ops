// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TrackingCard } from './TrackingCard'
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
vi.mock('@/hooks/useTruckConfigs', () => ({ useDriverPhones: () => ({ work: null, personal: null, truckNumber: null }) }))

function show(ctxOver: Partial<FormCtx>, mode: 'create' | 'edit' = 'create') {
  const values = emptyValues()
  const ctx = makeCtx({ mode, ...ctxOver })
  render(
    <MemoryRouter>
      <TrackingCard values={values} update={vi.fn()} form={makeForm(values)} ctx={ctx} issues={[]} mode={mode} locked={NO_LOCKS} />
    </MemoryRouter>,
  )
}

const text = (id: string) => screen.getByTestId(id).textContent ?? ''

describe('TrackingCard edit mode', () => {
  const bundle = savedBundle()
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
    expect(within(screen.getByTestId('card-tracking-updates')).getByTestId('history-feed')).toBeTruthy()
  })

  it('says Unassigned with no tracker and offers no entry form', () => {
    show({ bundle, customer }, 'edit')
    expect(text('card-tracking-assignee')).toBe('Unassigned')
    expect(screen.queryByLabelText('Message')).toBeNull()
  })
})

describe('TrackingCard create mode (planned setup)', () => {
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
    expect(text('card-tracking-after-create')).toBe('Tracking starts when the load is covered.')
    expect(screen.queryByTestId('card-tracking-open')).toBeNull()
  })

  it('asks for a customer when none is picked', () => {
    show({})
    expect(text('card-tracking-planned-mode')).toBe('Pick a customer')
  })
})
