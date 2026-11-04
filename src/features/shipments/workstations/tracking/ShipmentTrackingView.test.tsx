// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { invalidateLists } from '@/lib/listCache'
import { useAppStore } from '@/store/useAppStore'
import type { Driver } from '@/types'
import type {
  CustomerRecord, LoadCarrierRecord, ShipmentBundle, ShipmentLoad, ShipmentMessageRecord, ShipmentRecord,
} from '@/types/tms'
import type { ShipmentActions } from '../../useShipmentActions'
import { ShipmentTrackingView } from './ShipmentTrackingView'

const listShipmentMessages = vi.hoisted(() => vi.fn(async () => [] as ShipmentMessageRecord[]))
const sendShipmentMessage = vi.hoisted(() => vi.fn(async () => ({ message: {} })))
const listTruckConfigs = vi.hoisted(() => vi.fn(async () => [] as unknown[]))

vi.mock('@/lib/apiClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/apiClient')>('@/lib/apiClient')
  return {
    ...actual,
    getTmsSettings: vi.fn(async () => null),
    listDivisions: vi.fn(async () => []),
    listCheckCallsByLoad: vi.fn(async () => []),
    listTrackingLinksByShipment: vi.fn(async () => []),
    listTruckPositions: vi.fn(async () => []),
    listLoadBreadcrumbs: vi.fn(async () => []),
    getLoadRoute: vi.fn(async () => ({ encoded: null, meters: null, seconds: null, source: 'NONE', cached: false, fetchedAt: null, waypoints: [], reason: null })),
    listTruckConfigs,
    listShipmentMessages,
    sendShipmentMessage,
  }
})

const load = { id: 'L1', shipmentId: 'S1', status: 'IN_TRANSIT', updatedAt: '2026-03-02T19:10:00.000Z' } as ShipmentLoad
const leg = {
  id: 'C1', loadId: 'L1', shipmentId: 'S1', kind: 'OWN_ASSET', status: 'ACTIVE', driverId: 'D1', driverName: 'John',
  driverPhone: '+13125550199', truckId: 'T1', truckNumber: '12', dispatcherName: 'Dee', dispatcherEmail: 'dee@carrier.test',
} as LoadCarrierRecord
const shipment = { id: 'S1', number: 'S000001', customerId: 'c1', updatedAt: '2026-03-02T19:10:00.000Z' } as ShipmentRecord
const bundle: ShipmentBundle = { shipment, orders: [], loads: [load], loadCarriers: [leg], charges: [], financials: [], documents: [] }
const actions = { busy: false, tracking: { logCheckCall: vi.fn(), resolveIncident: vi.fn(), setNextCheckCall: vi.fn(async () => {}), setEta: vi.fn() }, reload: vi.fn(async () => {}) } as unknown as ShipmentActions

const msg = (id: string, channel: 'SMS' | 'EMAIL', over: Partial<ShipmentMessageRecord> = {}): ShipmentMessageRecord => ({
  id, shipmentId: 'S1', channel, direction: 'OUT', status: 'SENT', at: '2026-03-02T19:00:00.000Z', body: `${channel} body ${id}`,
  authorKind: 'PERSON', authorName: 'Maria Gomez', ...over,
} as ShipmentMessageRecord)

function renderView(customer: CustomerRecord | null = null) {
  return render(<ShipmentTrackingView bundle={bundle} customer={customer} actions={actions} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidateLists()
  listShipmentMessages.mockResolvedValue([])
  listTruckConfigs.mockResolvedValue([{ truckId: 'T1', unitNumber: '12', phone: '+13125550100', phoneLabel: 'Cab phone', createdAt: '', updatedAt: '' }])
  useAppStore.setState({ drivers: [{ id: 'D1', name: 'John', phone: '+13125550199', assignedTruckId: 'T1' } as Driver] })
})

describe('ShipmentTrackingView', () => {
  it('puts each channel in its own pane', async () => {
    listShipmentMessages.mockResolvedValue([msg('a', 'SMS'), msg('b', 'EMAIL', { subject: 'Where are you' })])
    renderView()
    const sms = screen.getByTestId('pane-sms')
    const email = screen.getByTestId('pane-email')
    await waitFor(() => expect(within(sms).getByText('SMS body a')).toBeInTheDocument())
    expect(within(sms).queryByText('EMAIL body b')).not.toBeInTheDocument()
    expect(within(email).getByText('EMAIL body b')).toBeInTheDocument()
    expect(within(email).queryByText('SMS body a')).not.toBeInTheDocument()
  })

  it('shows a text that was not sent as "Would have sent" in the SMS pane', async () => {
    listShipmentMessages.mockResolvedValue([msg('n', 'SMS', { status: 'NOT_SENT' })])
    renderView()
    await waitFor(() => expect(within(screen.getByTestId('pane-sms')).getByTestId('not-sent-body')).toHaveTextContent('SMS body n'))
  })

  it('addresses the SMS pane to the truck work phone and sends without a literal number', async () => {
    renderView()
    await waitFor(() => expect(screen.getByTestId('sms-target')).toHaveTextContent('(312) 555-0100'))
    expect(screen.getByTestId('sms-target')).toHaveTextContent('work phone (truck 12)')
    const pane = screen.getByTestId('pane-sms')
    fireEvent.change(within(pane).getByLabelText('Text message body'), { target: { value: 'Where are you?' } })
    fireEvent.click(within(pane).getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(sendShipmentMessage).toHaveBeenCalled())
    expect(sendShipmentMessage).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: 'S1', channel: 'SMS', to: null, party: 'DRIVER', body: 'Where are you?',
    }))
  })

  it('falls back to the personal number and says why when the truck has no phone', async () => {
    listTruckConfigs.mockResolvedValue([{ truckId: 'T1', unitNumber: '12', createdAt: '', updatedAt: '' }])
    renderView()
    await waitFor(() => expect(screen.getByTestId('sms-target')).toHaveTextContent('(312) 555-0199'))
    expect(screen.getByTestId('sms-target-reason')).toHaveTextContent('Truck 12 has no work phone')
  })

  it('honours a per-customer WORK_ONLY target: no number, composer refuses', async () => {
    listTruckConfigs.mockResolvedValue([{ truckId: 'T1', unitNumber: '12', createdAt: '', updatedAt: '' }])
    renderView({ id: 'c1', driverSmsTarget: 'WORK_ONLY' } as unknown as CustomerRecord)
    const pane = screen.getByTestId('pane-sms')
    await waitFor(() => expect(within(pane).getByText('Truck 12 has no work phone', { selector: 'p' })).toBeInTheDocument())
    fireEvent.change(within(pane).getByLabelText('Text message body'), { target: { value: 'hi' } })
    expect(within(pane).getByRole('button', { name: /Send/ })).toBeDisabled()
  })

  it('sends e-mail to the dispatcher address with the subject', async () => {
    renderView()
    const pane = screen.getByTestId('pane-email')
    fireEvent.change(within(pane).getByLabelText('Subject'), { target: { value: 'ETA?' } })
    fireEvent.change(within(pane).getByLabelText('E-mail body'), { target: { value: 'Please update' } })
    fireEvent.click(within(pane).getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(sendShipmentMessage).toHaveBeenCalled())
    expect(sendShipmentMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'EMAIL', to: 'dee@carrier.test', subject: 'ETA?', party: 'DISPATCHER',
    }))
  })

  it('shows both phones in the strip', async () => {
    renderView()
    await waitFor(() => expect(screen.getByTestId('driver-phone-work')).toHaveTextContent('Work (truck 12): (312) 555-0100'))
    expect(screen.getByTestId('driver-phone-personal')).toHaveTextContent('Personal: (312) 555-0199')
  })

  it('stacks the strip (with the prefs row inside it), the map, then the panes', async () => {
    renderView()
    const strip = screen.getByTestId('tracking-strip')
    const map = screen.getByTestId('tracking-map-panel')
    const panes = screen.getByTestId('tracking-panes')
    expect(within(strip).getByTestId('tracking-prefs-row')).toBeInTheDocument()
    expect(strip.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(map.compareDocumentPosition(panes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByTestId('tracking-prefs-button')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('driver-phone-work')).toBeInTheDocument())
  })
})
