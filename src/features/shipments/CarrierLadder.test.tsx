// @vitest-environment jsdom
/**
 * Step AM on the Carrier tab: the ladder card's buttons, the four-field driver gate before Dispatch, Mark signed
 * with an uploaded PDF, and the Cover entry on a load nobody is on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierSection } from './components/CarrierSection'
import type { ShipmentActions } from './useShipmentActions'
import type { CarrierRecord, LoadCarrierRecord, ShipmentBundle } from '@/types/tms'
import type * as ApiClient from '@/lib/apiClient'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const mocks = vi.hoisted(() => ({
  carrier: null as unknown,
  prepare: vi.fn(),
  put: vi.fn(),
  commit: vi.fn(),
  preview: vi.fn(),
  invite: vi.fn(),
}))

vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
vi.mock('@/hooks/useTrucks', () => ({ useTrucks: () => ({ equipment: [] }) }))
vi.mock('@/lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  getTmsSettings: vi.fn(async () => null),
  getCarrierBundle: vi.fn(async () => ({ carrier: mocks.carrier, contacts: [] })),
  prepareDocumentUpload: mocks.prepare,
  putPresignedFile: mocks.put,
  commitDocument: mocks.commit,
  mcpPreviewCarrier: mocks.preview,
  mcpSendInvite: mocks.invite,
}))
vi.mock('@/features/quotes/components/CarrierOffersCard', () => ({ CarrierOffersCard: () => null }))
vi.mock('./components/CarrierOffersSection', () => ({ CarrierOffersSection: () => null }))
vi.mock('./components/PostingsSection', () => ({ PostingsSection: () => null }))
vi.mock('@/features/carriers/components/RateConPanel', () => ({ RateConPanel: () => <div id="rate-con-panel" /> }))
vi.mock('@/features/carriers/cover/CoverCarrierDialog', () => ({
  CoverCarrierDialog: ({ shipmentId }: { shipmentId: string }) => <div data-testid="cover-dialog" data-shipment={shipmentId} />,
}))

const leg = (over: Partial<LoadCarrierRecord> = {}): LoadCarrierRecord => ({
  id: 'lc-1', loadId: 'load-1', shipmentId: 'shp-1', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car-1', carrierName: 'Swift',
  carrierRateCents: 150_000, assignmentStatus: 'ASSIGNED_SETUP_COMPLETE', assignmentTimes: JSON.stringify({ ASSIGNED_SETUP_COMPLETE: '2026-11-03T15:00:00.000Z' }),
  ...over,
} as LoadCarrierRecord)

function bundleOf(loadCarriers: LoadCarrierRecord[], loadOver: Record<string, unknown> = {}): ShipmentBundle {
  return {
    shipment: { id: 'shp-1', number: 'S1', status: 'BOOKED', buildState: 'READY' },
    orders: [], charges: [], financials: [], documents: [],
    loads: [{ id: 'load-1', status: 'BOOKED', assignmentType: 'CARRIER', stops: [], ...loadOver }],
    loadCarriers,
  } as unknown as ShipmentBundle
}

function actionsOf(): ShipmentActions {
  return {
    busy: false,
    reload: vi.fn(async () => {}),
    dispatchLoad: vi.fn(async () => {}),
    enterDriverInfo: vi.fn(async () => {}),
    markRateConSigned: vi.fn(async () => {}),
    load: { onRemoveCarrier: vi.fn(async () => {}) },
  } as unknown as ShipmentActions
}

async function renderTab(bundle: ShipmentBundle, actions = actionsOf()) {
  render(<MemoryRouter><CarrierSection bundle={bundle} actions={actions} isAdmin={false} /></MemoryRouter>)
  await screen.findByTestId('carrier-ladder')
  return actions
}

const btn = (key: string) => screen.getByTestId(`ladder-${key}`) as HTMLButtonElement

beforeEach(() => {
  vi.clearAllMocks()
  mocks.carrier = { id: 'car-1', name: 'Swift', status: 'ACTIVE', mcpStatus: 'ACCEPTABLE' } as CarrierRecord
})

describe('Carrier tab ladder', () => {
  it('a load nobody is on offers Cover, which opens the dialog for this shipment', () => {
    render(<MemoryRouter><CarrierSection bundle={bundleOf([], { assignmentType: 'NEED_TO_COVER' })} actions={actionsOf()} /></MemoryRouter>)
    fireEvent.click(screen.getByTestId('cover-open'))
    expect(screen.getByTestId('cover-dialog').getAttribute('data-shipment')).toBe('shp-1')
  })

  it('waiting on setup: only the setup packet is live, the rate con and driver steps say why they are not', async () => {
    mocks.carrier = { id: 'car-1', name: 'Swift', status: 'PENDING', mcpStatus: 'INVITED' } as CarrierRecord
    await renderTab(bundleOf([leg({ assignmentStatus: 'ASSIGNED_SETUP_PENDING', assignmentTimes: null })]))
    expect(screen.getByTestId('carrier-ladder').getAttribute('data-rung')).toBe('ASSIGNED_SETUP_PENDING')
    expect(btn('SEND_SETUP_PACKET').disabled).toBe(false)
    for (const key of ['SEND_RATE_CON', 'MARK_SIGNED', 'ENTER_DRIVER_INFO']) {
      expect(btn(key).disabled).toBe(true)
      expect(btn(key).title).toMatch(/MyCarrierPackets/)
    }
    expect(screen.getByTestId('ladder-ASSIGNED_SETUP_COMPLETE').getAttribute('data-done')).toBe('false')
  })

  it('marks every rung up to the current one as reached, with its time', async () => {
    await renderTab(bundleOf([leg()]))
    expect(screen.getByTestId('ladder-ASSIGNED_SETUP_PENDING').getAttribute('data-done')).toBe('true')
    expect(screen.getByTestId('ladder-ASSIGNED_SETUP_COMPLETE').getAttribute('data-done')).toBe('true')
    expect(screen.getByTestId('ladder-RATE_CON_SENT').getAttribute('data-done')).toBe('false')
    expect(screen.getByTestId('ladder-ASSIGNED_SETUP_COMPLETE').textContent).toMatch(/2026|Nov/)
  })

  it('Send rate con takes the rep to the rate-con panel below', async () => {
    await renderTab(bundleOf([leg()]))
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    fireEvent.click(btn('SEND_RATE_CON'))
    expect(scroll).toHaveBeenCalled()
  })

  it('blocks Dispatch until the four driver fields are on the assignment, and says which are missing', async () => {
    await renderTab(bundleOf([leg({ driverName: 'Dee', driverPhone: null })]))
    const dispatch = screen.getByRole('button', { name: /^Dispatch$/ }) as HTMLButtonElement
    expect(dispatch.disabled).toBe(true)
    expect(dispatch.title).toBe('Driver info is required before dispatch: driver phone, truck number, trailer number')
    expect(screen.getByTestId('dispatch-gate').textContent).toMatch(/driver phone/)
  })

  it('lets Dispatch through once all four are entered', async () => {
    await renderTab(bundleOf([leg({
      assignmentStatus: 'DRIVER_INFO_ENTERED', driverName: 'Dee', driverPhone: '555', truckNumber: 'T1', trailerNumber: 'R1',
    })]))
    expect((screen.getByRole('button', { name: /^Dispatch$/ }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('dispatch-gate')).toBeNull()
  })

  it('driver info needs all four fields, then saves them trimmed', async () => {
    const actions = await renderTab(bundleOf([leg()]))
    fireEvent.click(btn('ENTER_DRIVER_INFO'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Driver name'), { target: { value: ' Dee ' } })
    fireEvent.change(within(dialog).getByLabelText('Driver phone'), { target: { value: '555-0100' } })
    fireEvent.change(within(dialog).getByLabelText('Truck #'), { target: { value: 'T1' } })
    fireEvent.click(screen.getByTestId('driver-info-save'))
    expect(await within(dialog).findByText('Trailer # is required.')).toBeTruthy()
    expect(actions.enterDriverInfo).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText('Trailer #'), { target: { value: 'R9' } })
    fireEvent.click(screen.getByTestId('driver-info-save'))
    await waitFor(() => expect(actions.enterDriverInfo).toHaveBeenCalledWith({
      loadCarrierId: 'lc-1', driverName: 'Dee', driverPhone: '555-0100', truckNumber: 'T1', trailerNumber: 'R9',
    }))
  })

  it('shows the server’s refusal inside the driver dialog', async () => {
    const actions = actionsOf()
    vi.mocked(actions.enterDriverInfo).mockRejectedValue(new Error('Setup is not complete.'))
    await renderTab(bundleOf([leg()]), actions)
    fireEvent.click(btn('ENTER_DRIVER_INFO'))
    const dialog = await screen.findByRole('dialog')
    for (const [label, value] of [['Driver name', 'Dee'], ['Driver phone', '5'], ['Truck #', 'T'], ['Trailer #', 'R']]) {
      fireEvent.change(within(dialog).getByLabelText(label!), { target: { value } })
    }
    fireEvent.click(screen.getByTestId('driver-info-save'))
    expect((await screen.findByTestId('driver-info-error')).textContent).toBe('Setup is not complete.')
  })

  it('Mark signed refuses anything but a PDF, uploads the PDF as the rate con, then marks it signed with that document', async () => {
    mocks.prepare.mockResolvedValue({ uploadUrl: 'https://s3/put', s3Key: 'k', documentId: 'doc-9' })
    mocks.put.mockResolvedValue(undefined)
    mocks.commit.mockResolvedValue({ bundle: {}, document: {} })
    const actions = await renderTab(bundleOf([leg({ assignmentStatus: 'RATE_CON_SENT', rateConStatus: 'SENT' })]))
    fireEvent.click(btn('MARK_SIGNED'))
    await screen.findByRole('dialog')
    const input = screen.getByLabelText('Signed rate confirmation PDF')

    fireEvent.change(input, { target: { files: [new File(['x'], 'scan.png', { type: 'image/png' })] } })
    expect((await screen.findByTestId('mark-signed-error')).textContent).toMatch(/not a PDF/)
    expect((screen.getByTestId('mark-signed-confirm') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { files: [new File(['%PDF-1'], 'signed.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect((screen.getByTestId('mark-signed-confirm') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('mark-signed-confirm'))

    await waitFor(() => expect(actions.markRateConSigned).toHaveBeenCalledWith({ loadCarrierId: 'lc-1', documentId: 'doc-9' }))
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: 'shp-1', type: 'RATE_CON', contentType: 'application/pdf' }))
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc-9', type: 'RATE_CON', loadCarrierId: 'lc-1', loadId: 'load-1' }))
  })

  it('Remove carrier asks whether to re-post to DAT, off unless ticked, and sends the choice', async () => {
    const actions = await renderTab(bundleOf([leg()]))
    fireEvent.click(screen.getByTestId('ladder-REMOVE'))
    const dialog = await screen.findByRole('dialog')
    const repost = within(dialog).getByLabelText('Re-post to DAT') as HTMLInputElement
    expect(repost.checked).toBe(false)
    expect(within(dialog).getByTestId('remove-carrier-effect').textContent).toMatch(/goes back to Open/)

    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'GAVE_BACK' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(actions.load.onRemoveCarrier).toHaveBeenCalledWith('lc-1', 'BOUNCED', 'GAVE_BACK', undefined, false))
  })

  it('Remove carrier with the box ticked asks for the repost', async () => {
    const actions = await renderTab(bundleOf([leg()]))
    fireEvent.click(screen.getByTestId('ladder-REMOVE'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByLabelText('Re-post to DAT'))
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'GAVE_BACK' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(actions.load.onRemoveCarrier).toHaveBeenCalledWith('lc-1', 'BOUNCED', 'GAVE_BACK', undefined, true))
  })

  it('a leg with no ladder (own fleet, legacy) shows no ladder card and keeps the old Dispatch behaviour', () => {
    render(<MemoryRouter><CarrierSection bundle={bundleOf([leg({ assignmentStatus: null })])} actions={actionsOf()} /></MemoryRouter>)
    expect(screen.queryByTestId('carrier-ladder')).toBeNull()
    expect((screen.getByRole('button', { name: /^Dispatch$/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})
