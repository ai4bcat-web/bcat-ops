// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { FLAG_COLUMNS, LABEL, SHIPPING_TAB_ORDER } from '../labels'
import { emptyStop, emptyValues, type ShipmentFormValues } from '../model'
import type { DivisionTreeRow } from '@/features/tms/settings/taxonomyDrafts'
import { ShippingRequirementsSection } from './ShippingRequirementsSection'
import { ValuesHost, type Host } from './SectionHost'
import { makeCtx, sliceChange } from './sectionTestKit'
import type { FormCtx } from '../sectionProps'

function setup(ctx: FormCtx = makeCtx(), seed?: (v: ShipmentFormValues) => ShipmentFormValues) {
  const host: { current: Host | null } = { current: null }
  const modeChange = vi.fn()
  const initial = seed ? seed(emptyValues()) : undefined
  render(
    <ValuesHost onHost={(h) => { host.current = h }} initial={initial}>
      {(values, update, form) => (
        <ShippingRequirementsSection
          value={values.ship} onChange={sliceChange(update, 'ship')} ctx={ctx} form={form}
          mode={values.mode} onModeChange={(m) => { modeChange(m); update((p) => ({ ...p, mode: m })) }}
        />
      )}
    </ValuesHost>,
  )
  return { host, modeChange }
}

const ids = (...keys: string[]) => keys.map((k) => `f-shipping-${k}`)

describe('ShippingRequirementsSection', () => {
  it('lays controls out in Aljex tab order, then the two flag columns left before right', () => {
    setup()
    const body = screen.getByTestId('section-shipping-body')
    const order = Array.from(body.querySelectorAll<HTMLElement>('[data-testid^="f-shipping-"]')).map((el) => el.dataset.testid)
    const expected = SHIPPING_TAB_ORDER.map((k) => (LABEL.shipping as Record<string, { testId: string }>)[k].testId)
    const present = order.filter((id) => expected.includes(id as string))
    expect(present).toEqual(expected)
    const flags = within(screen.getByTestId('f-shipping-flags')).getAllByRole('checkbox').map((el) => el.getAttribute('data-testid'))
    expect(flags).toEqual([...FLAG_COLUMNS.left, ...FLAG_COLUMNS.right].map((k) => LABEL.flags[k].testId))
  })

  it('names the Aljex-red controls "(required)"', () => {
    setup()
    for (const l of ['Equipment', 'Revenue Type', 'Weight', 'Description']) {
      expect(screen.getByLabelText(`${l} (required)`)).toBeTruthy()
    }
    expect(screen.getByLabelText('Footage')).toBeTruthy()
  })

  it('keeps Temp, Pallet and Tarp inputs disabled until ticked and clears them when unticked', () => {
    setup()
    const min = screen.getByLabelText('Min Temp') as HTMLInputElement
    expect(min.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Temp Control'))
    expect(min.disabled).toBe(false)
    fireEvent.change(min, { target: { value: '-4x' } })
    expect(min.value).toBe('-4')
    fireEvent.click(screen.getByLabelText('Temp Control'))
    fireEvent.click(screen.getByLabelText('Temp Control'))
    expect((screen.getByLabelText('Min Temp') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByLabelText('Tarps'))
    fireEvent.change(screen.getByLabelText('Tarp Size'), { target: { value: '8 ft' } })
    fireEvent.click(screen.getByLabelText('Tarps'))
    expect((screen.getByLabelText('Tarp Size') as HTMLInputElement).value).toBe('')
  })

  it('stores N/A, Yes and No as null, true and false', () => {
    const { host } = setup()
    const lift = screen.getByLabelText('Liftgate')
    fireEvent.change(lift, { target: { value: 'yes' } })
    expect(host.current?.getValues().ship.liftgate).toBe(true)
    fireEvent.change(lift, { target: { value: 'no' } })
    expect(host.current?.getValues().ship.liftgate).toBe(false)
    fireEvent.change(lift, { target: { value: 'na' } })
    expect(host.current?.getValues().ship.liftgate).toBeNull()
  })

  it('Calculate Totals from Picks sums the pickups, and says so when nothing can be counted', () => {
    const { host } = setup(makeCtx(), (v) => ({
      ...v,
      stops: [{ ...emptyStop('pickup'), pieces: '10', weightLbs: '1000' }, { ...emptyStop('pickup'), pieces: '5', weightLbs: '500' }, emptyStop('delivery')],
    }))
    fireEvent.click(screen.getByLabelText('Calculate Totals from Picks'))
    expect(host.current?.getValues().ship.pieces).toBe('15')
    expect(host.current?.getValues().ship.weightLbs).toBe('1500')
    expect(screen.getByTestId('f-shipping-hint').textContent).toContain('2 picks counted')
  })

  it('Calculate with no pick numbers leaves Pieces and Weight alone and explains', () => {
    const { host } = setup(makeCtx(), (v) => ({ ...v, ship: { ...v.ship, weightLbs: '900' } }))
    fireEvent.click(screen.getByLabelText('Calculate Totals from Picks'))
    expect(host.current?.getValues().ship.weightLbs).toBe('900')
    expect(screen.getByTestId('f-shipping-hint').textContent).toMatch(/No pick/)
  })

  it('Suggest miles is hidden by Disable Mileage and refuses without coordinates', () => {
    setup()
    fireEvent.click(screen.getByTestId('f-shipping-suggestMiles'))
    expect((screen.getByLabelText('Customer Miles') as HTMLInputElement).value).toBe('')
    expect(screen.getByTestId('f-shipping-hint').textContent).toMatch(/coordinates/)
    fireEvent.click(screen.getByLabelText('Disable Mileage'))
    expect(screen.queryByTestId('f-shipping-suggestMiles')).toBeNull()
  })

  it('picking a sub-division records its top-level parent as the division', () => {
    const top = { id: 'd1', code: 'LOGISTICS', name: 'Logistics', parentId: null, active: true }
    const sub = { id: 'd2', code: 'REEFER', name: 'Reefer', parentId: 'd1', active: true }
    const divisions = [{ division: top, depth: 0 }, { division: sub, depth: 1 }] as unknown as DivisionTreeRow[]
    const { host } = setup(makeCtx({ divisions }))
    fireEvent.change(screen.getByLabelText('Revenue Type (required)'), { target: { value: 'REEFER' } })
    expect(host.current?.getValues().ship.revDivision).toBe('LOGISTICS')
    expect(host.current?.getValues().ship.revSubdivision).toBe('REEFER')
    fireEvent.change(screen.getByLabelText('Revenue Type (required)'), { target: { value: 'LOGISTICS' } })
    expect(host.current?.getValues().ship.revSubdivision).toBe('')
  })

  it('locks Mode once submitted but keeps the other controls editable, and TONU is derived', () => {
    const ctx = makeCtx({ mode: 'edit', locked: { fields: { mode: 'Mode is fixed once the order is submitted.' }, stops: {}, voided: false } })
    const { modeChange } = setup(ctx)
    const mode = screen.getByLabelText('Mode') as HTMLSelectElement
    expect(mode.disabled).toBe(true)
    expect(mode.title).toMatch(/fixed/)
    expect((screen.getByLabelText('Weight (required)') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('TONU') as HTMLInputElement).disabled).toBe(true)
    expect(modeChange).not.toHaveBeenCalled()
  })

  it('disables every control while a pipeline is running', () => {
    setup(makeCtx({ busy: true }))
    for (const id of ids('equipmentType', 'description', 'weightLbs')) {
      expect((screen.getByTestId(id) as HTMLInputElement).disabled).toBe(true)
    }
    expect((screen.getByTestId('f-shipping-flag-hot') as HTMLInputElement).disabled).toBe(true)
  })

  it('shows the blocking message on the control it belongs to', () => {
    setup(makeCtx({ issues: [{ id: 'shipping:weight', section: 'shipping', fieldKey: 'f-shipping-weightLbs', label: 'Weight', message: 'Weight is required', severity: 'error' }] }))
    expect(screen.getByText('Weight is required')).toBeTruthy()
  })
})
