// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierInformationSection } from './CarrierInformationSection'
import { emptyValues, type ShipmentFormValues } from '../model'
import type { FormCtx } from '../sectionProps'
import type { CarrierRecord } from '@/types/tms'
import { makeCtx, makeForm, savedBundle } from './ah5TestKit'

vi.mock('@/hooks/useDrivers', () => ({
  useDrivers: () => ({
    drivers: [
      { id: 'd1', name: 'Alvaro Ruiz', phone: '+13125550101', email: 'alvaro@example.invalid', active: true },
      { id: 'd2', name: 'Brokered Freight', phone: '', active: true, type: 'broker' },
      { id: 'd3', name: 'Gone Driver', phone: '', active: false },
    ],
  }),
}))

const carrier = (over: Partial<CarrierRecord> = {}): CarrierRecord => ({
  id: 'car-1', name: 'Reliable Freight', type: 'TL', status: 'ACTIVE', mcNumber: '123456', dotNumber: '7654321',
  insurancePolicies: [{ id: 'p', type: 'CARGO', limitCents: 10_000_000, expiresAt: '2031-01-01' }],
  email: 'ops@example.invalid',
  createdBy: 'a', updatedBy: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
} as CarrierRecord)

function setup(patch: Partial<ShipmentFormValues['carrier']> = {}, ctxOver: Partial<FormCtx> = {}, values = emptyValues()) {
  const v = { ...values, carrier: { ...values.carrier, ...patch } }
  const onChange = vi.fn()
  const ctx = makeCtx({ directory: { customers: [], locations: [], staff: [], carriers: [carrier()] }, ...ctxOver })
  render(
    <MemoryRouter>
      <CarrierInformationSection value={v.carrier} onChange={onChange} ctx={ctx} form={makeForm(v)} />
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

  it('needs Origin City and State before Cover on a saved SOURCING shipment', () => {
    const { ctx } = setup({ carrierId: 'car-1' }, { mode: 'edit', bundle: savedBundle() })
    expect(cover().disabled).toBe(true)
    expect(screen.getByTestId('carrier-cover-reason').textContent).toContain('Origin City and Origin State')
    expect(ctx.actions.cover).not.toHaveBeenCalled()
  })

  it('refuses to open the booking dialog without a carrier rate', () => {
    const { ctx } = setup({ carrierId: 'car-1', originCity: 'Joliet', originState: 'IL' }, { mode: 'edit', bundle: savedBundle() })
    fireEvent.click(cover())
    expect(screen.getByTestId('carrier-cover-hint').textContent).toContain('carrier rate')
    expect(ctx.actions.cover).not.toHaveBeenCalled()
  })

  it('opens the booking dialog once the carrier rate is entered', () => {
    const v = emptyValues()
    v.rates.carrier.lhRate = '900'
    const { ctx } = setup({ carrierId: 'car-1', originCity: 'Joliet', originState: 'IL' }, { mode: 'edit', bundle: savedBundle() }, v)
    fireEvent.click(cover())
    expect(ctx.actions.cover).toHaveBeenCalledTimes(1)
  })

  it('Ivan Cartage gets the roster picker (no brokers, no inactive) and no Driver 2', () => {
    const { onChange } = setup({ isOwnFleet: true })
    const picker = screen.getByLabelText('Driver 1') as HTMLSelectElement
    expect([...picker.options].map((o) => o.text)).toEqual(['Pick a driver', 'Alvaro Ruiz'])
    expect(screen.queryByLabelText('Driver 2')).toBeNull()
    fireEvent.change(picker, { target: { value: 'd1' } })
    const update = onChange.mock.calls[0][0] as (p: ShipmentFormValues['carrier']) => ShipmentFormValues['carrier']
    expect(update(emptyValues().carrier).driver1).toEqual({ name: 'Alvaro Ruiz', phone: '+13125550101', email: 'alvaro@example.invalid' })
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
})
