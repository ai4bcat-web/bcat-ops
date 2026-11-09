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

describe('CarrierTrackingCard: the per-load tracking mode', () => {
  const after = '2026-11-07T00:00:00.000Z'
  const customer = { id: 'c1', name: 'Acme', trackingMode: 'AGENT', trackingMethod: 'BOTH' } as unknown as CustomerRecord
  const booked = (shipment: object = {}) => {
    const b = savedBundle({ loadCarriers: [{ id: 'lc1', status: 'ACTIVE', kind: 'CARRIER', carrierName: 'Ivan' }] })
    return { ...b, shipment: { ...b.shipment, createdAt: after, ...shipment } }
  }
  beforeEach(() => { vi.clearAllMocks() })

  it('before a carrier is booked the control is read-only and the sentence says tracking is chosen at booking', () => {
    const b = savedBundle()
    show({ bundle: { ...b, shipment: { ...b.shipment, createdAt: after } } as never, customer }, 'edit')
    expect(screen.getByTestId('tracking-mode-control').getAttribute('data-disabled')).toBe('true')
    expect((screen.getByTestId('tracking-mode-AGENT') as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByTestId('tracking-confirm')).toBeNull()
    expect(text('card-tracking-after-create')).toBe('Tracking is chosen when the carrier is booked.')
    expect(screen.queryByTestId('tracking-not-set')).toBeNull()
  })

  it('a booked, unconfirmed load shows the customer suggestion, the amber chip, and Confirm writes confirmed through SET_TRACKING_PREFS', async () => {
    const refreshBundle = vi.fn(async () => {})
    show({ bundle: booked() as never, customer, refreshBundle }, 'edit')
    expect(screen.getByTestId('tracking-not-set').textContent).toBe('Tracking mode not set')
    expect((screen.getByTestId('tracking-mode-AGENT') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('tracking-mode-suggested').textContent).toContain('Suggested from the customer')
    fireEvent.click(screen.getByTestId('tracking-mode-MANUAL'))
    fireEvent.click(screen.getByTestId('tracking-confirm'))
    await waitFor(() => expect(api.setTrackingPrefs).toHaveBeenCalledWith({ shipmentId: 'shp-1', prefs: { mode: 'MANUAL', confirmed: true } }))
    expect(api.saveLoadCheckCallPlan).not.toHaveBeenCalled()
    expect(api.assignTracker).not.toHaveBeenCalled()
    await waitFor(() => expect(refreshBundle).toHaveBeenCalled())
  })

  it('Automated writes method, cadence on the load plan and the assignee, each through its own existing action', async () => {
    show({ bundle: booked() as never, customer }, 'edit')
    fireEvent.change(screen.getByTestId('tracking-method'), { target: { value: 'SMS' } })
    fireEvent.change(screen.getByTestId('tracking-cadence'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('tracker-stub'), { target: { value: 'u9' } })
    fireEvent.click(screen.getByTestId('tracking-confirm'))
    await waitFor(() => expect(api.assignTracker).toHaveBeenCalledWith({ shipmentIds: ['shp-1'], trackerId: 'u9' }))
    expect(api.setTrackingPrefs).toHaveBeenCalledWith({ shipmentId: 'shp-1', prefs: { mode: 'AGENT', method: 'SMS', confirmed: true } })
    expect(api.saveLoadCheckCallPlan).toHaveBeenCalledWith({ loadId: 'load-1', plan: expect.objectContaining({ intervalHours: 2 }) })
  })

  it('None needs no cadence or method and Confirm is blocked while the mode is unchosen', async () => {
    show({ bundle: booked() as never, customer: { id: 'c2', name: 'Plain' } as unknown as CustomerRecord }, 'edit')
    expect((screen.getByTestId('tracking-confirm') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('tracking-mode-NONE'))
    expect(screen.queryByTestId('tracking-cadence')).toBeNull()
    fireEvent.click(screen.getByTestId('tracking-confirm'))
    await waitFor(() => expect(api.setTrackingPrefs).toHaveBeenCalledWith({ shipmentId: 'shp-1', prefs: { mode: 'NONE', confirmed: true } }))
  })

  it('a confirmed load shows no chip and the load\'s own mode, not the customer\'s', () => {
    show({ bundle: booked({ trackingPrefs: { mode: 'MANUAL', confirmedAt: after } }) as never, customer }, 'edit')
    expect(screen.queryByTestId('tracking-not-set')).toBeNull()
    expect((screen.getByTestId('tracking-mode-MANUAL') as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByTestId('tracking-mode-suggested')).toBeNull()
    expect((screen.getByTestId('tracking-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a pre-existing load keeps its behaviour: no chip for a shipment created before the cutoff', () => {
    show({ bundle: booked({ createdAt: '2026-10-01T00:00:00.000Z' }) as never, customer }, 'edit')
    expect(screen.queryByTestId('tracking-not-set')).toBeNull()
  })
})
