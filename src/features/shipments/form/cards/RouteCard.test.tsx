// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('aws-amplify/data', () => ({ generateClient: vi.fn(() => ({ graphql: vi.fn() })) }))
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { LocationRecord } from '@/types/tms'
import { RouteCard } from './RouteCard'
import { renderCard } from './cardTestKit'
import { pushRecent } from './recents'

const milesMock = vi.fn()
vi.mock('../sections/routeMilesApi', () => ({ getRouteMiles: (...a: unknown[]) => milesMock(...a) }))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ userId: 'u1', email: 'rep@bcat.test', groups: [] }) }))

const loc = (id: string, name: string, city: string, state: string, extra: object = {}) => ({
  id, name, street: '5 Dock Rd', city, state, zip: '60431', country: 'US', hours: '6-2', active: true,
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', ...extra,
}) as unknown as LocationRecord
const DOCK = loc('l1', 'Joliet Dock', 'Joliet', 'IL', { apptContactName: 'Dana Dock' })
const DEPOT = loc('l2', 'Joliet Depot', 'Joliet', 'IL')

beforeEach(() => { localStorage.clear(); milesMock.mockReset(); milesMock.mockResolvedValue({ miles: null, source: null }) })

const setup = (seed?: Parameters<typeof renderCard>[1] extends infer O ? (O extends { seed?: infer S } ? S : never) : never) =>
  renderCard(RouteCard, { ctx: () => ({ directory: { customers: [], locations: [DOCK, DEPOT], carriers: [], staff: [] } }), seed })

describe('RouteCard', () => {
  it('picking a location fills address, hours and contact, and shows the address summary', () => {
    const host = setup()
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'Joliet Dock' } })
    fireEvent.click(within(screen.getByRole('listbox')).getAllByTestId('f-pickup-name-option')[0])
    expect(host.current!.getValues().stops[0]).toMatchObject({ locationId: 'l1', city: 'Joliet', state: 'IL', hours: '6-2', contact: 'Dana Dock' })
    expect(screen.getByTestId('f-pickup-addressLine').textContent).toBe('5 Dock Rd, Joliet, IL 60431')
    expect(localStorage.getItem('tms:ship-form:recent:location:rep@bcat.test')).toBe('["l1"]')
  })

  it('offers recent locations first on an empty focus', () => {
    pushRecent('location', 'rep@bcat.test', 'l2')
    setup()
    fireEvent.focus(screen.getByTestId('f-pickup-name'))
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Joliet DepotJoliet, IL'])
  })

  it('adds stops only where the route stays pickup-first, delivery-last', () => {
    const host = setup()
    expect((screen.getByTestId('f-route-addPickup-2') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('f-route-addDelivery-2'))
    fireEvent.click(screen.getByTestId('f-route-addPickup-1'))
    expect(host.current!.getValues().stops.map((s) => s.type)).toEqual(['pickup', 'pickup', 'delivery', 'delivery'])
    // test ids follow the position, as the AH sections named them
    expect(screen.getByTestId('f-stop-1-name')).toBeTruthy()
    expect(screen.getByTestId('f-consignee-name')).toBeTruthy()
  })

  it('deleting a stop can be undone; the only pickup cannot be deleted', () => {
    const host = setup((v) => ({ ...v, stops: [v.stops[0], { ...v.stops[1], name: 'Mid', type: 'delivery' as const }, { ...v.stops[1], id: 'end', name: 'End' }] }))
    expect((screen.getByTestId('f-route-remove-0') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('f-route-remove-1'))
    expect(host.current!.getValues().stops.map((s) => s.name)).toEqual(['', 'End'])
    fireEvent.click(screen.getByTestId('f-route-undoButton'))
    expect(host.current!.getValues().stops.map((s) => s.name)).toEqual(['', 'Mid', 'End'])
    expect(screen.queryByTestId('f-route-undo')).toBeNull()
  })

  it('arrow keys on the handle reorder, but not past the pickup-first rule', () => {
    const host = setup((v) => ({ ...v, stops: [v.stops[0], { ...v.stops[1], id: 'a', name: 'A' }, { ...v.stops[1], id: 'b', name: 'B' }] }))
    fireEvent.keyDown(screen.getByTestId('f-route-handle-1'), { key: 'ArrowDown' })
    expect(host.current!.getValues().stops.map((s) => s.name)).toEqual(['', 'B', 'A'])
    fireEvent.keyDown(screen.getByTestId('f-route-handle-1'), { key: 'ArrowUp' })
    expect(host.current!.getValues().stops.map((s) => s.name)).toEqual(['', 'B', 'A'])
  })

  it('auto-fills miles with an est. label, keeps a typed override, and shows transit', async () => {
    milesMock.mockResolvedValue({ miles: 912, source: 'estimate' })
    const host = setup((v) => ({
      ...v,
      stops: v.stops.map((s, i) => ({ ...s, city: i ? 'Dallas' : 'Chicago', state: i ? 'TX' : 'IL' })),
    }))
    await waitFor(() => expect(host.current!.getValues().ship.customerMiles).toBe('912'), { timeout: 3000 })
    expect(host.current!.getValues().ship.truckMiles).toBe('912')
    expect(screen.getByTestId('f-shipping-customerMiles-est')).toBeTruthy()
    expect(screen.getByTestId('f-route-transit').textContent).toContain('2 days')
    expect(screen.getByTestId('f-route-lane').textContent).toBe('Chicago, IL → Dallas, TX')
    await act(async () => { fireEvent.change(screen.getByTestId('f-shipping-customerMiles'), { target: { value: '950' } }) })
    expect(screen.queryByTestId('f-shipping-customerMiles-est')).toBeNull()
    expect(host.current!.getValues().ship.customerMiles).toBe('950')
  })

  it('does not measure while Disable mileage is on', async () => {
    setup((v) => ({
      ...v, ship: { ...v.ship, disableMileage: true },
      stops: v.stops.map((s, i) => ({ ...s, city: i ? 'Dallas' : 'Chicago', state: i ? 'TX' : 'IL' })),
    }))
    await new Promise((r) => setTimeout(r, 800))
    expect(milesMock).not.toHaveBeenCalled()
  })

  it('never overwrites miles that were saved or typed, and does not measure an incomplete route', async () => {
    milesMock.mockResolvedValue({ miles: 912, source: 'google' })
    const host = setup((v) => ({
      ...v, ship: { ...v.ship, customerMiles: '640' },
      stops: v.stops.map((s, i) => ({ ...s, city: i ? 'Dallas' : 'Chicago', state: i ? 'TX' : 'IL' })),
    }))
    await waitFor(() => expect(milesMock).toHaveBeenCalled(), { timeout: 3000 })
    await waitFor(() => expect(host.current!.getValues().ship.truckMiles).toBe('912'))
    expect(host.current!.getValues().ship.customerMiles).toBe('640')
    expect(screen.getByTestId('f-shipping-milesSource').textContent).toMatch(/Miles from the stop addresses/)
    milesMock.mockClear()
    setup()
    await new Promise((r) => setTimeout(r, 800))
    expect(milesMock).not.toHaveBeenCalled()
  })

  it('invites typing when the route cannot be measured', async () => {
    milesMock.mockResolvedValue({ miles: null, source: null, error: 'boom' })
    const host = setup((v) => ({ ...v, stops: v.stops.map((s, i) => ({ ...s, city: i ? 'Dallas' : 'Chicago', state: i ? 'TX' : 'IL' })) }))
    await waitFor(() => expect(screen.getByTestId('f-shipping-milesSource').textContent).toMatch(/type the miles/))
    expect(host.current!.getValues().ship.customerMiles).toBe('')
  })

  it('typed location text that matches nothing is kept; renaming a linked stop drops its link and pin', () => {
    const host = setup((v) => ({ ...v, stops: v.stops.map((s, i) => (i ? s : { ...s, name: 'Joliet Dock', locationId: 'l1', geo: { lat: 1, lng: 2 } } as typeof s)) }))
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'Joliet Dock East' } })
    expect(host.current!.getValues().stops[0]).toMatchObject({ name: 'Joliet Dock East', locationId: '', geo: null })
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'Nowhere Ltd' } })
    expect(host.current!.getValues().stops[0].name).toBe('Nowhere Ltd')
  })

  it('Pick Up Name and Ready are the red fields; the consignee has Must Deliver instead of Ready', () => {
    setup()
    expect(screen.getByLabelText('Name (required)')).toBeTruthy()
    expect(screen.getByLabelText('Ready (required)')).toBeTruthy()
    expect(screen.getByTestId('f-consignee-mustDeliver')).toBeTruthy()
    expect(screen.queryByTestId('f-consignee-ready')).toBeNull()
  })

  it('masks the phone as typed and keeps zip to digits', () => {
    const host = setup((v) => ({ ...v, stops: v.stops.map((s, i) => (i ? s : { ...s, city: '' })) }))
    fireEvent.change(screen.getByTestId('f-pickup-phone'), { target: { value: '3125550100' } })
    expect(host.current!.getValues().stops[0].phone).toBe('(312) 555-0100')
    fireEvent.change(screen.getByTestId('f-pickup-zip'), { target: { value: '60a6-01' } })
    expect(host.current!.getValues().stops[0].zip).toBe('60601')
  })

  it('a stop the truck has already reached cannot be removed or have its place changed', () => {
    renderCard(RouteCard, {
      ctx: () => ({ directory: { customers: [], locations: [DOCK], carriers: [], staff: [] }, locked: { fields: {}, stops: { mid: 'The truck has arrived here' }, voided: false } }),
      seed: (v) => ({ ...v, stops: [v.stops[0], { ...v.stops[1], id: 'mid', name: 'Mid', type: 'pickup' as const }, { ...v.stops[1], id: 'end' }] }),
    })
    expect((screen.getByTestId('f-route-remove-1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('f-stop-1-name') as HTMLInputElement).disabled).toBe(true)
  })
})
