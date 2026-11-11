// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('aws-amplify/data', () => ({ generateClient: vi.fn(() => ({ graphql: vi.fn() })) }))
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LocationRecord } from '@/types/tms'
import { RouteCard } from './RouteCard'
import { renderCard } from './cardTestKit'
import { FromEmailContext } from '../fromEmail'
import { ValuesHost } from '../sections/SectionHost'
import { makeCtx } from '../sections/sectionTestKit'
import { emptyValues } from '../model'

const api = vi.hoisted(() => ({
  createLocation: vi.fn(),
  geocodeAddress: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => ({ createLocation: api.createLocation, geocodeAddress: api.geocodeAddress, graphqlErrorText: () => '' }))
vi.mock('../sections/routeMilesApi', () => ({ getRouteMiles: vi.fn(async () => ({ miles: null, source: null })) }))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ userId: 'u1', email: 'rep@bcat.test', groups: [] }) }))

const loc = (id: string, name: string, over: Partial<LocationRecord> = {}) => ({
  id, name, street: '1 Dock Rd', city: 'Joliet', state: 'IL', zip: '60431', country: 'US', active: true, createdAt: '', updatedAt: '', ...over,
}) as unknown as LocationRecord
const EXISTING = loc('l1', 'ZZ Dock')

const setup = (over: Parameters<typeof makeCtx>[0] = {}, locations = [EXISTING]) => {
  const addLocation = vi.fn()
  const host = renderCard(RouteCard, { ctx: () => ({ directory: { customers: [], locations, carriers: [], staff: [] }, canCreateLocation: true, addLocation, ...over }) })
  return { host, addLocation }
}
const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } })
const fillValid = (p = 'pickup') => {
  type(`f-${p}-new-street`, '9 Yard Ln'); type(`f-${p}-new-zip`, '60432'); type(`f-${p}-new-city`, 'Joliet'); fireEvent.change(screen.getByTestId(`f-${p}-new-state`), { target: { value: 'IL' } })
}

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks()
  api.geocodeAddress.mockResolvedValue({ city: 'Joliet', state: 'IL', lat: 41.5, lng: -88.1, placeId: 'p', timezone: 'America/Chicago', geocodedAt: 'a', geocodeExpiresAt: 'b', geocodeToken: 'tok' })
  api.createLocation.mockImplementation(async (i: Record<string, unknown>) => loc('l-new', String(i.name), { zip: String(i.zip), street: String(i.street) }))
})

describe('stop card: add a new location inline', () => {
  it('shows "+ Add <typed> as a new location" only when nothing matches, and the row opens the form prefilled', () => {
    setup()
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'ZZ Dock' } })
    expect(screen.queryByTestId('f-pickup-addRow')).toBeNull()
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'ZZ Brand New' } })
    const row = screen.getByTestId('f-pickup-addRow')
    expect(row.textContent).toBe('+ Add ZZ Brand New as a new location')
    fireEvent.click(row)
    expect((screen.getByTestId('f-pickup-new-name') as HTMLInputElement).value).toBe('ZZ Brand New')
    expect((screen.getByTestId('f-pickup-new-type') as HTMLSelectElement).value).toBe('SHIPPER')
  })

  it('while the form is open the stop does not ask for the address and contact a second time', () => {
    setup()
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'ZZ Brand New' } })
    // A stop with an incomplete address shows its own address fields...
    expect(screen.getByTestId('f-pickup-city')).toBeTruthy()
    // ...which fold away while the new-location form (the one place the address is typed) is open.
    fireEvent.click(screen.getByTestId('f-pickup-addRow'))
    expect(screen.getByTestId('f-pickup-new-city')).toBeTruthy()
    expect(screen.queryByTestId('f-pickup-city')).toBeNull()
    expect(screen.queryByTestId('f-pickup-zip')).toBeNull()
    expect(screen.queryByTestId('f-pickup-state')).toBeNull()
    fireEvent.click(screen.getByTestId('f-pickup-new-cancel'))
  })

  it('Enter on no match does the same; a delivery stop defaults to Receiver', () => {
    setup()
    fireEvent.change(screen.getByTestId('f-consignee-name'), { target: { value: 'ZZ Nowhere' } })
    fireEvent.keyDown(screen.getByTestId('f-consignee-name'), { key: 'Enter' })
    expect(screen.getByTestId('f-consignee-newLocation')).toBeTruthy()
    expect((screen.getByTestId('f-consignee-new-type') as HTMLSelectElement).value).toBe('RECEIVER')
  })

  it('validates inline, autofills city and state from the zip, then saves, geocodes, selects and tells the page', async () => {
    const { host, addLocation } = setup()
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'ZZ Yard' } })
    fireEvent.click(screen.getByTestId('f-pickup-addRow'))
    fireEvent.click(screen.getByTestId('f-pickup-new-save'))
    expect(api.createLocation).not.toHaveBeenCalled()
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
    type('f-pickup-new-zip', '60544')
    await waitFor(() => expect((screen.getByTestId('f-pickup-new-city') as HTMLInputElement).value).toBe('Plainfield'))
    expect((screen.getByTestId('f-pickup-new-state') as HTMLSelectElement).value).toBe('IL')
    type('f-pickup-new-street', '9 Yard Ln')
    fireEvent.click(screen.getByTestId('f-pickup-new-save'))
    await waitFor(() => expect(api.createLocation).toHaveBeenCalledTimes(1))
    expect(api.createLocation.mock.calls[0]![0]).toMatchObject({ name: 'ZZ Yard', zip: '60544', createdFrom: 'shipment-form', geocodeToken: 'tok', lat: 41.5 })
    await waitFor(() => expect(host.current!.getValues().stops[0]).toMatchObject({ locationId: 'l-new', name: 'ZZ Yard' }))
    expect(addLocation).toHaveBeenCalledWith(expect.objectContaining({ id: 'l-new' }))
    expect(screen.queryByTestId('f-pickup-newLocation')).toBeNull()
  })

  it('a failed geocode still saves the postal address (no pin)', async () => {
    api.geocodeAddress.mockRejectedValue(new Error('no key'))
    setup()
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'ZZ Yard' } })
    fireEvent.click(screen.getByTestId('f-pickup-addRow'))
    fillValid()
    fireEvent.click(screen.getByTestId('f-pickup-new-save'))
    await waitFor(() => expect(api.createLocation).toHaveBeenCalledTimes(1))
    expect(api.createLocation.mock.calls[0]![0]).not.toHaveProperty('geocodeToken')
  })

  it('Use once keeps the typed address on the stop and creates no directory row', async () => {
    const { host, addLocation } = setup()
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'Qwerty Yard' } })
    fireEvent.click(screen.getByTestId('f-pickup-addRow'))
    fillValid()
    fireEvent.click(screen.getByTestId('f-pickup-new-once'))
    expect(host.current!.getValues().stops[0]).toMatchObject({ name: 'Qwerty Yard', locationId: '', address1: '9 Yard Ln', zip: '60432', city: 'Joliet', state: 'IL' })
    expect(api.createLocation).not.toHaveBeenCalled()
    expect(addLocation).not.toHaveBeenCalled()
    expect(screen.queryByTestId('f-pickup-newLocation')).toBeNull()
  })

  it('a duplicate offers Use existing and blocks Save; Use existing selects that row', () => {
    const { host } = setup()
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'ZZ Yard' } })
    fireEvent.click(screen.getByTestId('f-pickup-addRow'))
    type('f-pickup-new-name', 'zz  dock'); type('f-pickup-new-zip', '60431'); type('f-pickup-new-city', 'Joliet'); type('f-pickup-new-street', '5 Other St')
    fireEvent.change(screen.getByTestId('f-pickup-new-state'), { target: { value: 'IL' } })
    expect(screen.getByTestId('f-pickup-new-duplicate').textContent).toContain('ZZ Dock')
    expect((screen.getByTestId('f-pickup-new-save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('f-pickup-new-useExisting'))
    expect(host.current!.getValues().stops[0]).toMatchObject({ locationId: 'l1', name: 'ZZ Dock' })
    expect(api.createLocation).not.toHaveBeenCalled()
  })

  it('Cancel closes the form and leaves the typed name', () => {
    const { host } = setup()
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'ZZ Maybe' } })
    fireEvent.click(screen.getByTestId('f-pickup-addRow'))
    fireEvent.click(screen.getByTestId('f-pickup-new-cancel'))
    expect(screen.queryByTestId('f-pickup-newLocation')).toBeNull()
    expect(host.current!.getValues().stops[0].name).toBe('ZZ Maybe')
  })

  it('without the directory create permission only Use once is offered', () => {
    setup({ canCreateLocation: false })
    fireEvent.change(screen.getByTestId('f-pickup-name'), { target: { value: 'ZZ Yard' } })
    fireEvent.click(screen.getByTestId('f-pickup-addRow'))
    expect(screen.queryByTestId('f-pickup-new-save')).toBeNull()
    expect(screen.getByTestId('f-pickup-new-once')).toBeTruthy()
  })

  it('works on a saved shipment (edit mode): the pencil opens the same form', () => {
    setup({ mode: 'edit' })
    fireEvent.click(screen.getByTestId('f-pickup-addLocation'))
    expect(screen.getByTestId('f-pickup-newLocation')).toBeTruthy()
  })

  it('an intake-prefilled stop with no directory match opens the form on its own, name and address filled, source "intake"', async () => {
    const values = { ...emptyValues(), stops: emptyValues().stops.map((s, i) => (i ? s : { ...s, name: 'ZZ Extracted Co', address1: '4 Extract Rd', city: 'Joliet', state: 'IL', zip: '60431' })) }
    const ctx = makeCtx({ directory: { customers: [], locations: [EXISTING], carriers: [], staff: [] }, canCreateLocation: true })
    render(
      <>
        <FromEmailContext.Provider value={new Set(['f-pickup-name'])}>
          <ValuesHost initial={values}>{(v, update, form) => <RouteCard values={v} update={update} form={form} issues={[]} mode="create" locked={ctx.locked} ctx={ctx} />}</ValuesHost>
        </FromEmailContext.Provider>
      </>,
    )
    await waitFor(() => expect(screen.getByTestId('f-pickup-newLocation')).toBeTruthy())
    expect((screen.getByTestId('f-pickup-new-name') as HTMLInputElement).value).toBe('ZZ Extracted Co')
    expect((screen.getByTestId('f-pickup-new-street') as HTMLInputElement).value).toBe('4 Extract Rd')
    fireEvent.click(screen.getByTestId('f-pickup-new-save'))
    await waitFor(() => expect(api.createLocation).toHaveBeenCalled())
    expect(api.createLocation.mock.calls[0]![0].createdFrom).toBe('intake')
  })

  it('an extracted stop that DOES match the directory does not open the form', async () => {
    const values = { ...emptyValues(), stops: emptyValues().stops.map((s, i) => (i ? s : { ...s, name: 'ZZ Dock', city: 'Joliet' })) }
    const ctx = makeCtx({ directory: { customers: [], locations: [EXISTING], carriers: [], staff: [] }, canCreateLocation: true })
    render(
      <>
        <FromEmailContext.Provider value={new Set(['f-pickup-name'])}>
          <ValuesHost initial={values}>{(v, update, form) => <RouteCard values={v} update={update} form={form} issues={[]} mode="create" locked={ctx.locked} ctx={ctx} />}</ValuesHost>
        </FromEmailContext.Provider>
      </>,
    )
    await new Promise((r) => setTimeout(r, 100))
    expect(screen.queryByTestId('f-pickup-newLocation')).toBeNull()
  })
})
