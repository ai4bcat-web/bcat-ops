// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ShipmentThreadPanel } from './ShipmentThreadPanel'
import type { CustomerRecord, LoadCarrierRecord, ShipmentLoad, ShipmentMessageRecord, TmsSettings } from '@/types/tms'

const listShipmentMessages = vi.hoisted(() => vi.fn())
const sendShipmentMessage = vi.hoisted(() => vi.fn())
const runCheckCallPlan = vi.hoisted(() => vi.fn())
const saveLoadCheckCallPlan = vi.hoisted(() => vi.fn())
const requestPod = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({
  listShipmentMessages,
  sendShipmentMessage,
  runCheckCallPlan,
  saveLoadCheckCallPlan,
  requestPod,
  graphqlErrorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/store/useAppStore', () => ({
  useAppStore: (selector: (s: { currentUserEmail: string }) => string) => selector({ currentUserEmail: 'maria.gomez@bcatcorp.com' }),
}))

const WHEN = '2026-04-03T12:00:00.000Z'

function message(over: Partial<ShipmentMessageRecord>): ShipmentMessageRecord {
  return {
    id: 'msg-1',
    shipmentId: 'shp-1',
    threadKey: 'tracking+shp-1',
    direction: 'OUT',
    channel: 'SMS',
    kind: 'CHECK_CALL',
    status: 'NOT_SENT',
    body: 'Where are you?',
    at: WHEN,
    createdBy: 'a@b.c',
    createdAt: WHEN,
    updatedAt: WHEN,
    ...over,
  } as ShipmentMessageRecord
}

const baseLoad: ShipmentLoad = {
  id: 'load-1',
  updatedAt: WHEN,
} as ShipmentLoad

const baseLoadCarrier: LoadCarrierRecord = {
  id: 'lc-1',
  driverName: 'Chad Salerno',
  driverPhone: '+15551234567',
  dispatcherName: 'Dispatch Desk',
  dispatcherPhone: '+15557654321',
  dispatcherEmail: 'dispatch@example.com',
} as LoadCarrierRecord

const baseCustomer: CustomerRecord = {
  id: 'cust-1',
  name: 'Acme',
} as CustomerRecord

const orgPlan = {
  intervalHours: 4,
  channels: ['SMS', 'EMAIL'],
  milestones: ['DISPATCHED', 'AT_PICKUP', 'DEPARTED_PICKUP', 'AT_DELIVERY', 'DELIVERED'],
  escalateAfterMinutes: 30,
  emailDispatcher: true,
  requestPodOnDelivery: true,
}

const baseSettings = {
  defaultCheckCallPlan: orgPlan,
} as TmsSettings

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ShipmentThreadPanel', () => {
  it('shows the body a NOT_SENT message would have sent', async () => {
    listShipmentMessages.mockResolvedValue([message({ body: 'Driver, what is your location?' })])
    render(<ShipmentThreadPanel shipmentId="shp-1" shipmentNumber="S000001" />)
    await waitFor(() => expect(screen.getByTestId('shipment-thread')).toBeInTheDocument())
    expect(screen.getByText('Would have sent:')).toBeInTheDocument()
    expect(screen.getByTestId('not-sent-body')).toHaveTextContent('Driver, what is your location?')
  })

  it('marks an agent row with the author name', async () => {
    listShipmentMessages.mockResolvedValue([message({ authorKind: 'AGENT', authorName: 'BCAT Tracking Assistant', body: 'Agent check' })])
    render(<ShipmentThreadPanel shipmentId="shp-1" shipmentNumber="S000001" />)
    await waitFor(() => expect(screen.getByTestId('shipment-thread')).toBeInTheDocument())
    expect(screen.getByTestId('message-author')).toHaveTextContent('BCAT Tracking Assistant')
    expect(screen.getByTestId('message-author-kind')).toHaveTextContent('agent')
  })

  it('marks a person row with the author name', async () => {
    listShipmentMessages.mockResolvedValue([message({ authorKind: 'PERSON', authorName: 'Maria Gomez', body: 'Person check' })])
    render(<ShipmentThreadPanel shipmentId="shp-1" shipmentNumber="S000001" />)
    await waitFor(() => expect(screen.getByTestId('shipment-thread')).toBeInTheDocument())
    expect(screen.getByTestId('message-author')).toHaveTextContent('Maria Gomez')
    expect(screen.getByTestId('message-author-kind')).toHaveTextContent('person')
  })

  it('renders VOICE disabled with the deferred reason', async () => {
    listShipmentMessages.mockResolvedValue([])
    render(<ShipmentThreadPanel shipmentId="shp-1" shipmentNumber="S000001" load={baseLoad} />)
    await waitFor(() => expect(screen.getByText('Check-call plan')).toBeInTheDocument())
    const planCard = screen.getByText('Check-call plan').closest('section')!
    const voice = within(planCard).getByText('VOICE').closest('label')!
    expect(voice).toHaveClass('tms-checkcall-channel-disabled')
    expect(voice).toHaveTextContent('voice is not switched on yet')
    const checkbox = voice.querySelector('input')
    expect(checkbox).toBeDisabled()
  })

  it('shows the voice reason in the composer channel picker', async () => {
    listShipmentMessages.mockResolvedValue([])
    render(<ShipmentThreadPanel shipmentId="shp-1" shipmentNumber="S000001" load={baseLoad} />)
    await waitFor(() => expect(screen.getByLabelText('Channel')).toBeInTheDocument())
    const channel = screen.getByLabelText('Channel') as HTMLSelectElement
    const voiceOption = Array.from(channel.options).find((o) => o.value === 'VOICE')!
    expect(voiceOption).toBeDisabled()
    expect(voiceOption.textContent).toContain('voice is not switched on yet')
  })

  it('prints the run-now decision and reason', async () => {
    listShipmentMessages.mockResolvedValue([])
    runCheckCallPlan.mockResolvedValue({ action: 'CADENCE', reason: 'Load is IN_TRANSIT and due for a check call', messages: [], nextDueAt: null })
    render(<ShipmentThreadPanel shipmentId="shp-1" shipmentNumber="S000001" load={baseLoad} />)
    await waitFor(() => expect(screen.getByText('Check-call plan')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Run check call now/i }))
    await waitFor(() => expect(screen.getByTestId('run-result')).toHaveTextContent('CADENCE'))
    expect(screen.getByTestId('run-result')).toHaveTextContent('Load is IN_TRANSIT and due for a check call')
  })

  it('shows the person signature preview in the composer', async () => {
    listShipmentMessages.mockResolvedValue([])
    render(<ShipmentThreadPanel shipmentId="shp-1" shipmentNumber="S000001" />)
    await waitFor(() => expect(screen.getByTestId('signature-preview')).toBeInTheDocument())
    expect(screen.getByTestId('signature-preview')).toHaveTextContent('— Maria, BCAT Tracking')
  })

  it('sends an SMS to the driver', async () => {
    listShipmentMessages.mockResolvedValue([])
    sendShipmentMessage.mockResolvedValue({ message: message({}) })
    render(
      <ShipmentThreadPanel
        shipmentId="shp-1"
        shipmentNumber="S000001"
        load={baseLoad}
        loadCarrier={baseLoadCarrier}
      />,
    )
    await waitFor(() => expect(screen.getByLabelText('Recipient')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'SMS' } })
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'DRIVER' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello driver' } })
    fireEvent.click(screen.getByRole('button', { name: /Send/i }))
    await waitFor(() => expect(sendShipmentMessage).toHaveBeenCalledWith({
      shipmentId: 'shp-1', channel: 'SMS', to: '+15551234567', subject: null, body: 'Hello driver',
    }))
  })

  it('sends an e-mail to the dispatcher', async () => {
    listShipmentMessages.mockResolvedValue([])
    sendShipmentMessage.mockResolvedValue({ message: message({}) })
    render(
      <ShipmentThreadPanel
        shipmentId="shp-1"
        shipmentNumber="S000001"
        load={baseLoad}
        loadCarrier={baseLoadCarrier}
      />,
    )
    await waitFor(() => expect(screen.getByLabelText('Recipient')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'EMAIL' } })
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'DISPATCHER' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Update' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello dispatcher' } })
    fireEvent.click(screen.getByRole('button', { name: /Send/i }))
    await waitFor(() => expect(sendShipmentMessage).toHaveBeenCalledWith({
      shipmentId: 'shp-1', channel: 'EMAIL', to: 'dispatch@example.com', subject: 'Update', body: 'Hello dispatcher',
    }))
  })

  it('names the org default source when no overrides exist', async () => {
    listShipmentMessages.mockResolvedValue([])
    render(
      <ShipmentThreadPanel
        shipmentId="shp-1"
        shipmentNumber="S000001"
        load={baseLoad}
        customer={baseCustomer}
        settings={baseSettings}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('check-call-source')).toBeInTheDocument())
    expect(screen.getByTestId('check-call-source')).toHaveTextContent('org default')
  })

  it('names the customer source when the customer overrides the plan', async () => {
    listShipmentMessages.mockResolvedValue([])
    const customer = { ...baseCustomer, checkCallPlan: { ...orgPlan, intervalHours: 6 } }
    render(
      <ShipmentThreadPanel
        shipmentId="shp-1"
        shipmentNumber="S000001"
        load={baseLoad}
        customer={customer}
        settings={baseSettings}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('check-call-source')).toBeInTheDocument())
    expect(screen.getByTestId('check-call-source')).toHaveTextContent('inherited from Acme')
  })

  it('names the shipment source when the load overrides the plan', async () => {
    listShipmentMessages.mockResolvedValue([])
    const load = { ...baseLoad, checkCallPlan: { ...orgPlan, intervalHours: 2 } }
    render(
      <ShipmentThreadPanel
        shipmentId="shp-1"
        shipmentNumber="S000001"
        load={load}
        customer={baseCustomer}
        settings={baseSettings}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('check-call-source')).toBeInTheDocument())
    expect(screen.getByTestId('check-call-source')).toHaveTextContent('set on this shipment')
  })

  it('clears a load override back to inheritance', async () => {
    listShipmentMessages.mockResolvedValue([])
    saveLoadCheckCallPlan.mockResolvedValue({ plan: null })
    const load = { ...baseLoad, checkCallPlan: { ...orgPlan, intervalHours: 2 } }
    render(
      <ShipmentThreadPanel
        shipmentId="shp-1"
        shipmentNumber="S000001"
        load={load}
        customer={baseCustomer}
        settings={baseSettings}
      />,
    )
    await waitFor(() => expect(screen.getByText('Clear override')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Clear override/i }))
    await waitFor(() => expect(saveLoadCheckCallPlan).toHaveBeenCalledWith({ loadId: 'load-1', plan: null, expectedUpdatedAt: WHEN }))
  })
})
