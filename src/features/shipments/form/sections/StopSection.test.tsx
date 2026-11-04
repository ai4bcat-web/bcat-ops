// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { LocationRecord } from '@/types/tms'
import { emptyValues, type ShipmentFormValues } from '../model'
import type { FormCtx } from '../sectionProps'
import { StopSection } from './StopSection'
import { ValuesHost, type Host } from './SectionHost'
import { makeCtx } from './sectionTestKit'

const now = Date.now()
const DOCK = {
  id: 'loc-1', name: 'Joliet Dock', street: '5 Dock Rd', street2: 'Bay 4', city: 'Joliet', state: 'il', zip: '60431', country: 'USA',
  apptContactName: 'Dana Dock', apptContactPhone: '+13125550111', apptContactEmail: 'dock@example.invalid', hours: '6-2',
  lat: 41.5, lng: -88.1, timezone: 'America/Chicago', geocodeExpiresAt: new Date(now + 86_400_000).toISOString(),
  active: true, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
} as unknown as LocationRecord

function setup(kind: 'pickup' | 'consignee', over: Partial<FormCtx> = {}, seed?: (v: ShipmentFormValues) => ShipmentFormValues) {
  const host: { current: Host | null } = { current: null }
  render(
    <ValuesHost onHost={(h) => { host.current = h }} initial={seed ? seed(emptyValues()) : undefined}>
      {(values, update, form) => {
        const index = kind === 'pickup' ? 0 : values.stops.length - 1
        const ctx = makeCtx({ directory: { customers: [], locations: [DOCK], carriers: [], staff: [] }, ...over })
        return (
          <StopSection
            kind={kind} index={index} stop={values.stops[index]} ctx={ctx} form={form}
            onChange={(patch) => update((p) => ({
              ...p, stops: p.stops.map((s, i) => (i === index ? (typeof patch === 'function' ? patch(s) : { ...s, ...patch }) : s)),
            }))}
          />
        )
      }}
    </ValuesHost>,
  )
  return host
}

describe('StopSection', () => {
  it('Pick Up has red Name and Ready; Consignee has Must Deliver instead of Ready', () => {
    setup('pickup')
    expect(screen.getByLabelText('Name (required)')).toBeTruthy()
    expect(screen.getByLabelText('Ready (required)')).toBeTruthy()
    expect(screen.queryByLabelText('Must Deliver')).toBeNull()
  })

  it('Consignee name is optional and Must Deliver replaces Ready', () => {
    setup('consignee')
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.queryByLabelText('Name (required)')).toBeNull()
    expect(screen.getByLabelText('Must Deliver')).toBeTruthy()
    expect(screen.queryByLabelText('Ready')).toBeNull()
    expect(screen.getByLabelText('Appt')).toBeTruthy()
  })

  it('choosing a directory location prefills address, contact, masked phone, hours and the booked pin', () => {
    const host = setup('pickup')
    fireEvent.change(screen.getByLabelText('Name (required)'), { target: { value: 'jol' } })
    fireEvent.click(screen.getByTestId('f-pickup-name-option'))
    const s = host.current!.getValues().stops[0]
    expect(s).toMatchObject({
      name: 'Joliet Dock', locationId: 'loc-1', address1: '5 Dock Rd', address2: 'Bay 4', city: 'Joliet', state: 'IL',
      zip: '60431', country: 'US', contact: 'Dana Dock', phone: '(312) 555-0111', email: 'dock@example.invalid', hours: '6-2',
    })
    expect(s.geo).toMatchObject({ lat: 41.5, lng: -88.1 })
  })

  it('editing the name away from the linked location drops the link and its pin', () => {
    const host = setup('pickup', undefined, (v) => ({
      ...v, stops: [{ ...v.stops[0], name: 'Joliet Dock', locationId: 'loc-1', geo: { lat: 1, lng: 2 } }, v.stops[1]],
    }))
    fireEvent.change(screen.getByLabelText('Name (required)'), { target: { value: 'Joliet Dockx' } })
    const s = host.current!.getValues().stops[0]
    expect(s.locationId).toBe('')
    expect(s.geo).toBeNull()
    expect(s.name).toBe('Joliet Dockx')
  })

  it('typed text that matches no location is kept as typed', () => {
    const host = setup('consignee')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Brand New Receiver' } })
    expect(host.current!.getValues().stops[1]).toMatchObject({ name: 'Brand New Receiver', locationId: '' })
  })

  it('masks the phone as typed and keeps zip to digits', () => {
    const host = setup('pickup')
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '3125550100' } })
    fireEvent.change(screen.getByLabelText('Zip'), { target: { value: '60a431-1234' } })
    const s = host.current!.getValues().stops[0]
    expect(s.phone).toBe('(312) 555-0100')
    expect(s.zip).toBe('604311234')
  })

  it('Ready and Appt are separate fields', () => {
    const host = setup('pickup')
    fireEvent.change(screen.getByLabelText('Ready (required)'), { target: { value: '2026-05-01T08:00' } })
    expect(host.current!.getValues().stops[0]).toMatchObject({ ready: '2026-05-01T08:00', appt: '' })
    fireEvent.change(screen.getByLabelText('Appt'), { target: { value: '2026-05-01T09:30' } })
    expect(host.current!.getValues().stops[0]).toMatchObject({ ready: '2026-05-01T08:00', appt: '2026-05-01T09:30' })
  })

  it('a Batory customer gets the request-through-appointments note; others do not', () => {
    const batory = { id: 'c', name: 'BATORY FOODS INC', apptWorkflow: 'BATORY' } as unknown as FormCtx['customer']
    setup('pickup', { customer: batory })
    expect(screen.getByTestId('f-pickup-batory').textContent).toMatch(/request\s+them through the appointments page/)
  })

  it('no note for a normal customer', () => {
    setup('pickup', { customer: { id: 'c', name: 'Acme', apptWorkflow: 'NONE' } as unknown as FormCtx['customer'] })
    expect(screen.queryByTestId('f-pickup-batory')).toBeNull()
  })

  it('fixes the place once the truck has been there', () => {
    const lock = { fields: {}, stops: {} as Record<string, string>, voided: false }
    const host = { current: null as Host | null }
    render(
      <ValuesHost onHost={(h) => { host.current = h }}>
        {(values, _u, form) => {
          lock.stops[values.stops[0].id] = 'The truck has been here'
          return <StopSection kind="pickup" index={0} stop={values.stops[0]} ctx={makeCtx({ locked: lock })} form={form} onChange={() => {}} />
        }}
      </ValuesHost>,
    )
    expect(screen.getByLabelText('Name (required)')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Contact')).toHaveProperty('disabled', false)
  })
})
