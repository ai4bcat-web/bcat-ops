// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { TmsSettings } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'admin@bcatcorp.com' }, isAdmin: true, isOwner: false }) }))

/** Every apiClient function the settings cards import; a missing one throws on render. */
const api = vi.hoisted(() => ({
  listDivisions: vi.fn(async () => []),
  saveDivision: vi.fn(),
  listUserProfiles: vi.fn(async () => []),
  getTmsSettings: vi.fn(),
  saveTmsSettings: vi.fn(async (patch: Partial<TmsSettings>) => ({ id: 'default', ...patch } as TmsSettings)),
  saveShipmentSettings: vi.fn(async () => ({ settings: { id: 'default' } as TmsSettings })),
  saveCommissionSettings: vi.fn(async () => ({ settings: { id: 'default' } as TmsSettings })),
  saveTrackingSettings: vi.fn(async (patch: Partial<TmsSettings>) => ({ id: 'default', ...patch } as TmsSettings)),
}))
vi.mock('@/lib/apiClient', () => api)

import { SettingsPage } from './SettingsPage'
import { ShipmentSettingsCard } from './ShipmentSettingsCard'
import { ChargeCodesCard } from './ChargeCodesCard'
import { TeamsCard } from './TeamsCard'
import { CommissionSettingsCard } from './CommissionSettingsCard'
import { TrackingSettingsCard } from './TrackingSettingsCard'
import { PostalCodeAliasesCard } from './PostalCodeAliasesCard'

function settingsAre(settings: Partial<TmsSettings>) {
  api.getTmsSettings.mockResolvedValue({ id: 'default', ...settings } as TmsSettings)
}

beforeEach(() => {
  vi.clearAllMocks()
  settingsAre({ defaultPaymentTermsDays: 30, accessorialCodes: ['POD', 'BOL'] })
})

describe('SettingsPage', () => {
  it('renders admin-only division and TMS settings sections', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>)
    expect(screen.getAllByText('Legacy division keys').length).toBeGreaterThan(0)
    expect(screen.getAllByText('TMS defaults').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Quotes & offers').length).toBeGreaterThan(0)
  })

  it('renders the step I cards for an admin', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>)
    for (const heading of ['Shipments', 'Charge codes', 'Teams', 'Roles & pages', 'Commissions']) {
      expect(screen.getAllByText(heading).length).toBeGreaterThan(0)
    }
  })

  it('Add division opens the create form', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Add division')).toBeTruthy())
    expect(screen.queryByText('Key *')).toBeNull()
    fireEvent.click(screen.getByText('Add division'))
    expect(screen.getByText('Key *')).toBeTruthy()
  })
})

describe('ShipmentSettingsCard', () => {
  it('previews the next shipment number as the prefix plus the padded counter', async () => {
    settingsAre({ shipmentPrefix: 'S', nextShipmentNumber: 42 })
    render(<ShipmentSettingsCard />)

    await waitFor(() => expect(screen.getByTestId('shipment-number-example').textContent).toBe('S000042'))

    fireEvent.change(screen.getByLabelText('Shipment prefix'), { target: { value: 'BC-' } })
    fireEvent.change(screen.getByLabelText('Next shipment number'), { target: { value: '7' } })
    expect(screen.getByTestId('shipment-number-example').textContent).toBe('BC-000007')
  })

  it('refuses a counter that goes backwards without calling the save', async () => {
    settingsAre({ shipmentPrefix: 'S', nextShipmentNumber: 42 })
    render(<ShipmentSettingsCard />)
    await waitFor(() => expect(screen.getByLabelText('Next shipment number')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Next shipment number'), { target: { value: '5' } })
    fireEvent.click(screen.getByText('Save shipment settings'))

    await waitFor(() => expect(screen.getByText('The shipment counter is at 42 and can only go forward')).toBeTruthy())
    expect(api.saveShipmentSettings).not.toHaveBeenCalled()
  })
})

describe('ChargeCodesCard', () => {
  it('stores a default amount typed in dollars as integer cents', async () => {
    settingsAre({ chargeCodes: [{ code: 'FSC', label: 'Fuel surcharge', calculatedBy: 'FLAT' }] })
    render(<ChargeCodesCard />)
    await waitFor(() => expect(screen.getByLabelText('Charge code 1 default amount')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Charge code 1 default amount'), { target: { value: '125.50' } })
    fireEvent.click(screen.getByText('Save charge codes'))

    await waitFor(() => expect(api.saveTmsSettings).toHaveBeenCalled())
    const [patch] = api.saveTmsSettings.mock.calls[0]
    expect(patch.chargeCodes?.[0]).toMatchObject({ code: 'FSC', defaultAmountCents: 12550 })
  })

  it('refuses a row with no label and never calls the save', async () => {
    settingsAre({ chargeCodes: [{ code: 'FSC', label: '', calculatedBy: 'FLAT' }] })
    render(<ChargeCodesCard />)
    await waitFor(() => expect(screen.getByLabelText('Charge code 1 label')).toBeTruthy())

    fireEvent.click(screen.getByText('Save charge codes'))

    await waitFor(() => expect(screen.getByText('Charge code FSC needs a label')).toBeTruthy())
    expect(api.saveTmsSettings).not.toHaveBeenCalled()
  })
})

describe('TeamsCard', () => {
  it("shows validateTeams' own sentence and does not save an empty team", async () => {
    settingsAre({ teams: [{ key: 'SALES', name: 'Sales desk', memberIds: [] }] })
    render(<TeamsCard />)
    await waitFor(() => expect(screen.getByLabelText('Team 1 key')).toBeTruthy())

    fireEvent.click(screen.getByText('Save teams'))

    await waitFor(() => expect(screen.getByText('Team SALES needs at least one member.')).toBeTruthy())
    expect(api.saveTmsSettings).not.toHaveBeenCalled()
  })

  it('saves the teams it was given once they are whole', async () => {
    settingsAre({ teams: [{ key: 'SALES', name: 'Sales desk', memberIds: ['rep@bcatcorp.com'] }] })
    render(<TeamsCard />)
    await waitFor(() => expect(screen.getByLabelText('Team 1 key')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Team 1 Shipment e-mails'), { target: { value: 'sales@bcatcorp.com' } })
    fireEvent.click(screen.getByText('Save teams'))

    await waitFor(() => expect(api.saveTmsSettings).toHaveBeenCalled())
    const [patch] = api.saveTmsSettings.mock.calls[0]
    expect(patch.teams?.[0]).toMatchObject({
      key: 'SALES',
      memberIds: ['rep@bcatcorp.com'],
      senderAddresses: { shipment: 'sales@bcatcorp.com' },
    })
  })
})

describe('CommissionSettingsCard', () => {
  it('stores a rate typed as a percentage in basis points', async () => {
    settingsAre({
      commissionsEnabled: true,
      commissionPlans: [{
        id: 'house', name: 'House plan',
        roles: [{ roleName: 'PRIMARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT', rateBps: 100 }],
      }],
    })
    render(<CommissionSettingsCard />)
    await waitFor(() => expect(screen.getByLabelText('Plan 1 role 1 rate')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Plan 1 role 1 rate'), { target: { value: '3.5' } })
    fireEvent.click(screen.getByText('Save commission settings'))

    await waitFor(() => expect(api.saveCommissionSettings).toHaveBeenCalled())
    const [patch] = api.saveCommissionSettings.mock.calls[0]
    expect(patch.commissionPlans?.[0].roles[0]).toMatchObject({ rateType: 'PERCENT_PROFIT', rateBps: 350 })
  })

  it("shows validateCommissionPlans' own sentence for a graduated margin ladder", async () => {
    settingsAre({
      commissionsEnabled: true,
      commissionPlans: [{
        id: 'house', name: 'House plan',
        roles: [{
          roleName: 'PRIMARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT', rateBps: 100,
          tierType: 'PER_LOAD_MARGIN_BPS', graduated: true,
          tiers: [{ fromBps: 0, rateBps: 100 }],
        }],
      }],
    })
    render(<CommissionSettingsCard />)
    await waitFor(() => expect(screen.getByLabelText('Plan 1 role 1 rate')).toBeTruthy())

    fireEvent.click(screen.getByText('Save commission settings'))

    await waitFor(() => expect(screen.getByText(/a margin ladder has no slice to pay a rate on/)).toBeTruthy())
    expect(api.saveCommissionSettings).not.toHaveBeenCalled()
  })

  it('previews the pay window the schedule produces', async () => {
    settingsAre({
      commissionsEnabled: true,
      commissionPaySchedule: { frequency: 'MONTHLY', payDay: 5, daysUntilPay: 7 },
    })
    render(<CommissionSettingsCard />)

    await waitFor(() => expect(screen.getByTestId('commission-period-preview').textContent).toMatch(
      /^\d{4}-\d{2}-01 to \d{4}-\d{2}-\d{2}, paid \d{4}-\d{2}-05$/,
    ))
  })
})

describe('TrackingSettingsCard', () => {
  it('saves the four shared tracking defaults and says nothing reads them yet', async () => {
    settingsAre({ trackByDefault: true, trackingIntervalMin: 30, trackingDurationHours: 72 })
    render(<TrackingSettingsCard />)
    await waitFor(() => expect(screen.getByLabelText('Tracking ping interval minutes')).toBeTruthy())

    expect(screen.getAllByText(/used once a tracking provider is live/i).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByLabelText('Track every shipment by default'))
    fireEvent.click(screen.getByLabelText('Set status from geofence'))
    fireEvent.change(screen.getByLabelText('Tracking ping interval minutes'), { target: { value: '45' } })
    fireEvent.change(screen.getByLabelText('Tracking duration hours'), { target: { value: '120' } })
    fireEvent.click(screen.getByText('Save tracking settings'))

    await waitFor(() => expect(api.saveTrackingSettings).toHaveBeenCalled())
    const [patch] = api.saveTrackingSettings.mock.calls[0]
    expect(patch).toMatchObject({
      trackByDefault: false,
      autoStatusFromGeofence: true,
      trackingIntervalMin: 45,
      trackingDurationHours: 120,
    })
  })

  it('refuses a ping interval under five minutes without calling the save', async () => {
    settingsAre({})
    render(<TrackingSettingsCard />)
    await waitFor(() => expect(screen.getByLabelText('Tracking ping interval minutes')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Tracking ping interval minutes'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('Save tracking settings'))

    await waitFor(() => expect(screen.getByText(/Tracking ping interval must be a whole number between 5 and 240/)).toBeTruthy())
    expect(api.saveTrackingSettings).not.toHaveBeenCalled()
  })
})

describe('PostalCodeAliasesCard', () => {
  it('saves a whole alias row as zip, city and state', async () => {
    settingsAre({ postalCodeAliases: [{ zip: '60601', city: 'chicago', state: 'il' }] })
    render(<PostalCodeAliasesCard />)
    await waitFor(() => expect(screen.getByLabelText('Alias 1 city')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Alias 1 city'), { target: { value: 'Chicago' } })
    fireEvent.change(screen.getByLabelText('Alias 1 state'), { target: { value: 'il' } })
    fireEvent.click(screen.getByText('Save postal code aliases'))

    await waitFor(() => expect(api.saveTmsSettings).toHaveBeenCalled())
    const [patch] = api.saveTmsSettings.mock.calls[0]
    expect(patch.postalCodeAliases).toEqual([{ zip: '60601', city: 'Chicago', state: 'IL' }])
  })

  it('refuses a short ZIP and a one-letter state without calling the save', async () => {
    settingsAre({ postalCodeAliases: [{ zip: '6060', city: 'Chicago', state: 'IL' }] })
    render(<PostalCodeAliasesCard />)
    await waitFor(() => expect(screen.getByLabelText('Alias 1 ZIP')).toBeTruthy())

    fireEvent.click(screen.getByText('Save postal code aliases'))
    await waitFor(() => expect(screen.getByText('Alias 1 needs a five-digit ZIP')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Alias 1 ZIP'), { target: { value: '60601' } })
    fireEvent.change(screen.getByLabelText('Alias 1 state'), { target: { value: 'I' } })
    fireEvent.click(screen.getByText('Save postal code aliases'))
    await waitFor(() => expect(screen.getByText('Alias 60601 needs a two-letter state')).toBeTruthy())

    expect(api.saveTmsSettings).not.toHaveBeenCalled()
  })
})
