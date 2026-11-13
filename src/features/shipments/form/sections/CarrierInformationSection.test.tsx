// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierInformationSection } from './CarrierInformationSection'
import { emptyValues, type ShipmentFormValues } from '../model'
import type { FormCtx } from '../sectionProps'
import type { CarrierRecord } from '@/types/tms'
import { makeCtx, makeForm, savedBundle } from './ah5TestKit'

const api = vi.hoisted(() => ({ getCarrier: vi.fn(), pullMcpCarrier: vi.fn() }))
vi.mock('@/lib/apiClient', async (orig) => ({ ...(await orig<object>()), getCarrier: api.getCarrier, pullMcpCarrier: api.pullMcpCarrier }))

vi.mock('@/hooks/useDrivers', () => ({
  useDrivers: () => ({
    drivers: [
      { id: 'd1', name: 'Alvaro Ruiz', phone: '+13125550101', email: 'alvaro@example.invalid', active: true, assignedTruckId: 't1', assignedTrailerId: 'tr1' },
      { id: 'd2', name: 'Brokered Freight', phone: '', active: true, type: 'broker' },
      { id: 'd3', name: 'Gone Driver', phone: '', active: false },
    ],
  }),
}))
vi.mock('@/hooks/useTrucks', () => ({
  useTrucks: () => ({
    equipment: [
      { id: 't1', type: 'truck', unitNumber: '12', active: true },
      { id: 'tr1', type: 'trailer', unitNumber: 'R-7', active: true },
    ],
  }),
}))
vi.mock('@/hooks/useTruckConfigs', () => ({
  useTruckConfigs: () => ({ byId: new Map([['t1', { truckId: 't1', unitNumber: '12', phone: '+13125550100' }]]) }),
}))

const carrier = (over: Partial<CarrierRecord> = {}): CarrierRecord => ({
  id: 'car-1', name: 'Reliable Freight', type: 'TL', status: 'ACTIVE', mcNumber: '123456', dotNumber: '7654321',
  insurancePolicies: [{ id: 'p', type: 'CARGO', limitCents: 10_000_000, expiresAt: '2031-01-01' }],
  email: 'ops@example.invalid',
  createdBy: 'a', updatedBy: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
} as CarrierRecord)

function setup(patch: Partial<ShipmentFormValues['carrier']> = {}, ctxOver: Partial<FormCtx> = {}, values = emptyValues(), expanded = false) {
  const v = { ...values, carrier: { ...values.carrier, ...patch } }
  const onChange = vi.fn()
  const ctx = makeCtx({ directory: { customers: [], locations: [], staff: [], carriers: [carrier()] }, ...ctxOver })
  render(
    <MemoryRouter>
      <CarrierInformationSection value={v.carrier} onChange={onChange} ctx={ctx} form={makeForm(v)} expanded={expanded} />
    </MemoryRouter>,
  )
  return { onChange, ctx }
}

const cover = () => screen.getByTestId('f-carrier-cover') as HTMLButtonElement

describe('CarrierInformationSection', () => {
  it('keeps Cover off until the shipment is saved, and says so', () => {
    setup({ carrierId: 'car-1', originCity: 'Joliet', originState: 'IL' })
    expect(cover().disabled).toBe(true)
    expect(screen.getByTestId('carrier-cover-reason').textContent).toBe('Save the draft first')
  })

  it('is collapsed to "No carrier yet" with Cover and Assign until a carrier is picked', () => {
    const { onChange } = setup({}, { mode: 'edit', bundle: savedBundle() })
    expect(screen.getByTestId('carrier-empty').textContent).toBe('No carrier yet')
    expect(screen.queryByLabelText('Truck #')).toBeNull()
    expect(cover().disabled).toBe(false)
    fireEvent.click(screen.getByTestId('carrier-assign'))
    expect(screen.getByLabelText('Carrier')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Cover opens the AM ladder for a saved SOURCING shipment without needing a carrier, origin or typed rate', () => {
    const { ctx } = setup({}, { mode: 'edit', bundle: savedBundle() })
    fireEvent.click(cover())
    expect(ctx.actions.cover).toHaveBeenCalledTimes(1)
  })

  it('the Ivan Cartage division opens the card without a click on Assign', () => {
    setup({}, {}, emptyValues(), true)
    expect(screen.getByTestId('carrier-own-fleet')).toBeTruthy()
  })

  it('Ivan Cartage gets the roster picker (no brokers, no inactive), no Driver 2, and a selection fills phone, truck and trailer', () => {
    const { onChange } = setup({ isOwnFleet: true })
    const picker = screen.getByLabelText('Driver 1') as HTMLSelectElement
    expect(picker.tagName).toBe('SELECT')
    // The truck's work phone (Step AK) is the number shown and filled, not the driver's own.
    expect([...picker.options].map((o) => o.text)).toEqual(['Pick a driver', 'Alvaro Ruiz · Truck 12 · Trailer R-7 · (312) 555-0100'])
    expect(screen.queryByLabelText('Driver 2')).toBeNull()
    fireEvent.change(picker, { target: { value: 'd1' } })
    const update = onChange.mock.calls[0][0] as (p: ShipmentFormValues['carrier']) => ShipmentFormValues['carrier']
    expect(update(emptyValues().carrier)).toMatchObject({
      driver1: { name: 'Alvaro Ruiz', phone: '+13125550100', email: 'alvaro@example.invalid' },
      truckNo: '12',
      trailerNo: 'R-7',
    })
  })

  it('the same driver is on pickup and delivery by default; "Different driver on the delivery" opens a delivery picker that sets the delivery driver, and unticking puts it back', () => {
    const { onChange } = setup({ isOwnFleet: true, driver1: { name: 'Alvaro Ruiz', phone: '', email: '' } })
    expect(screen.queryByLabelText('Delivery driver')).toBeNull()
    fireEvent.click(screen.getByTestId('carrier-split-driver'))
    const picker = screen.getByLabelText('Delivery driver') as HTMLSelectElement
    fireEvent.change(picker, { target: { value: 'd1' } })
    expect(onChange).toHaveBeenCalledWith({ deliveryDriverId: 'd1' })
    fireEvent.click(screen.getByTestId('carrier-split-driver'))
    expect(onChange).toHaveBeenLastCalledWith({ deliveryDriverId: '' })
    expect(screen.queryByLabelText('Delivery driver')).toBeNull()
  })

  it('a load that already has two drivers opens with the delivery picker showing', () => {
    setup({ isOwnFleet: true, driver1: { name: 'Alvaro Ruiz', phone: '', email: '' }, deliveryDriverId: 'd1' })
    expect((screen.getByTestId('carrier-split-driver') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Delivery driver') as HTMLSelectElement).value).toBe('d1')
  })

  it('own fleet: nothing about the driver, truck or trailer can be typed', () => {
    setup({ isOwnFleet: true, driver1: { name: 'Alvaro Ruiz', phone: '+13125550100', email: '' }, truckNo: '12', trailerNo: 'R-7' })
    expect(screen.queryByRole('textbox', { name: 'Driver 1' })).toBeNull()
    for (const label of ['Driver 1 Cell', 'Truck #', 'Trailer #']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).readOnly).toBe(true)
    }
  })

  it('a brokered carrier keeps the free-text driver fields', () => {
    const { onChange } = setup({ carrierId: 'car-1' })
    const name = screen.getByLabelText('Driver 1') as HTMLInputElement
    expect(name.tagName).toBe('INPUT')
    fireEvent.change(name, { target: { value: 'Typed Name' } })
    expect(onChange).toHaveBeenCalled()
    expect((screen.getByLabelText('Truck #') as HTMLInputElement).readOnly).toBe(false)
    expect(screen.getByLabelText('Driver 2')).toBeTruthy()
  })

  it('routes a typed "Ivan Cartage" to the own-fleet picker instead of recording a name', () => {
    const { onChange } = setup({ useTyped: true, typedName: 'Acme' })
    fireEvent.change(screen.getByLabelText('Carrier name'), { target: { value: 'Ivan Cartage' } })
    expect(onChange).toHaveBeenCalledWith({ typedName: '', useTyped: false, isOwnFleet: true })
  })

  it('offers a setup packet for an unvetted carrier and sends it to the typed address', async () => {
    const { ctx } = setup({ carrierId: 'car-1' }, { mode: 'edit', bundle: savedBundle() })
    fireEvent.click(screen.getByTestId('carrier-send-setup-packet'))
    await waitFor(() => expect(ctx.actions.sendSetupPacket).toHaveBeenCalledWith('car-1', 'ops@example.invalid'))
  })

  it('hides the invite once the MyCarrierPackets packet is complete', () => {
    setup({ carrierId: 'car-1' }, {
      directory: { customers: [], locations: [], staff: [], carriers: [carrier({ mcpStatus: 'ACCEPTABLE' })] },
    })
    expect(screen.queryByTestId('carrier-find-invite')).toBeNull()
  })

  it('Dispatch / Send Rate Conf / Send Info need a booked carrier', () => {
    setup({ carrierId: 'car-1' }, { mode: 'edit', bundle: savedBundle() })
    for (const id of ['carrier-dispatch', 'f-carrier-sendRateConf', 'f-carrier-sendInfo']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('a covered load shows the covering carrier as a card even when the form value was never set (Cover ran from the dialog)', () => {
    const booked = [{ id: 'lc-1', loadId: 'load-1', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car-1', carrierName: 'Reliable Freight' }]
    setup({}, {
      mode: 'edit', bundle: savedBundle({ loadStatus: 'BOOKED', loadCarriers: booked }),
      directory: { customers: [], locations: [], staff: [], carriers: [carrier({ mcpStatus: 'ACCEPTABLE', mcpSyncedAt: '2026-11-13T20:15:35.758Z', safetyRating: 'SATISFACTORY', mcpRiskScore: 29500 })] },
    })
    expect(screen.getByTestId('carrier-covered-card-name').textContent).toBe('Reliable Freight')
    expect(screen.getByTestId('carrier-covered-card-ids').textContent).toContain('MC 123456 · DOT 7654321')
    expect(screen.getByTestId('carrier-covered-card-insurance-CARGO').textContent).toBe('Cargo $100,000 · active to 01/01/2031')
    expect(screen.getByTestId('carrier-covered-card-insurance-AUTO_LIABILITY').textContent).toContain('not on file')
    expect(screen.getByTestId('carrier-covered-card-vetting').textContent).toContain('Risk 29500 pts')
    expect(screen.getByTestId('carrier-covered-card-status').textContent).toBe('Set up · Active')
    expect(screen.queryByLabelText('MC #')).toBeNull()
    expect(screen.queryByPlaceholderText('Name, MC, DOT or SCAC')).toBeNull()
    expect(api.pullMcpCarrier).not.toHaveBeenCalled()
  })

  it('a covered carrier MyCarrierPackets never synced is pulled once and the card fills in', async () => {
    const booked = [{ id: 'lc-1', loadId: 'load-1', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car-1', carrierName: 'Reliable Freight' }]
    api.pullMcpCarrier.mockResolvedValue({ carrierId: 'car-1', result: 'SYNCED' })
    api.getCarrier.mockResolvedValue(carrier({
      mcpStatus: 'NOT_INVITED', mcpSyncedAt: '2026-11-13T20:15:35.758Z', updatedAt: '2026-11-13T20:15:35.759Z',
      insurancePolicies: [{ id: 'a', type: 'AUTO_LIABILITY', limitCents: 100_000_000, expiresAt: '2027-06-01T00:00:00.000Z' }],
    }))
    setup({}, {
      mode: 'edit', bundle: savedBundle({ loadStatus: 'BOOKED', loadCarriers: booked }),
      directory: { customers: [], locations: [], staff: [], carriers: [carrier({ insurancePolicies: [] })] },
    })
    await waitFor(() => expect(screen.getByTestId('carrier-covered-card-insurance-AUTO_LIABILITY').textContent).toBe('Auto liability $1,000,000 · active to 06/01/2027'))
    expect(api.pullMcpCarrier).toHaveBeenCalledTimes(1)
    expect(api.pullMcpCarrier).toHaveBeenCalledWith('car-1')
  })
})
