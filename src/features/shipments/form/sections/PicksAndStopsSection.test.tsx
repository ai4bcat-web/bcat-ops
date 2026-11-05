// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { emptyStop, emptyValues, type FormStop, type ShipmentFormValues } from '../model'
import { PicksAndStopsSection } from './PicksAndStopsSection'
import { ValuesHost, type Host } from './SectionHost'
import { makeCtx, sliceChange } from './sectionTestKit'
import type { FormCtx } from '../sectionProps'
import type { FormApi } from '../sectionRegistry'

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))  // clients build at import
function stop(type: FormStop['type'], name: string, city = 'Joliet', state = 'IL'): FormStop {
  return { ...emptyStop(type), name, city, state, ready: '2026-05-01T08:00' }
}
const names = (host: { current: Host | null }) => host.current!.getValues().stops.map((s) => s.name)

function setup(stops: FormStop[], ctx: FormCtx = makeCtx()) {
  const host: { current: Host | null } = { current: null }
  let formApi: FormApi | null = null
  render(
    <ValuesHost onHost={(h) => { host.current = h }} initial={{ ...emptyValues(), stops } as ShipmentFormValues}>
      {(values, update, form) => {
        formApi = form
        return <PicksAndStopsSection value={values.stops} onChange={sliceChange(update, 'stops')} ctx={ctx} form={form} />
      }}
    </ValuesHost>,
  )
  return { host, form: () => formApi! }
}

describe('PicksAndStopsSection', () => {
  const two = () => [stop('pickup', 'Origin'), stop('delivery', 'Dest', 'Danville')]

  it('lists stops as "n. Pick/Delivery · name, City ST · Ref # x"', () => {
    const s = two()
    s[0].refNo = 'PU-1'
    setup(s)
    expect(screen.getByTestId('f-picks-row-0').textContent).toContain('1. Pick · Origin, Joliet IL · Ref # PU-1')
    expect(screen.getByTestId('f-picks-row-1').textContent).toContain('2. Delivery · Dest, Danville IL')
  })

  it('flags a row with a missing required field', () => {
    const s = two()
    s[1].state = ''
    setup(s)
    expect(screen.getByTestId('f-picks-row-0').getAttribute('data-incomplete')).toBe('false')
    expect(screen.getByTestId('f-picks-row-1').getAttribute('data-incomplete')).toBe('true')
  })

  it('Insert Pick adds a pickup before the final delivery and Insert Stop a delivery after the selection', () => {
    const { host } = setup(two())
    fireEvent.click(screen.getByLabelText('Insert Pick'))
    const types = () => host.current!.getValues().stops.map((s) => s.type)
    expect(types()).toEqual(['pickup', 'pickup', 'delivery'])
    expect(host.current!.getValues().stops[2].name).toBe('Dest')
    // the inserted pick is selected; Insert Stop lands right after it, still before the consignee
    fireEvent.click(screen.getByLabelText('Insert Stop'))
    expect(types()).toEqual(['pickup', 'pickup', 'delivery', 'delivery'])
    expect(host.current!.getValues().stops[3].name).toBe('Dest')
  })

  it('moves and removes inserted stops only, never the Pick Up or Consignee', () => {
    const mid1 = stop('pickup', 'M1')
    const mid2 = stop('delivery', 'M2')
    const { host } = setup([stop('pickup', 'Origin'), mid1, mid2, stop('delivery', 'Dest')])
    expect(screen.queryByLabelText('Remove stop 1')).toBeNull()
    expect(screen.queryByLabelText('Remove stop 4')).toBeNull()
    expect((screen.getByLabelText('Move stop 2 up') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Move stop 2 down'))
    expect(names(host)).toEqual(['Origin', 'M2', 'M1', 'Dest'])
    fireEvent.click(screen.getByLabelText('Remove stop 3'))
    expect(names(host)).toEqual(['Origin', 'M2', 'Dest'])
  })

  it('selecting the first or last row jumps to the Pick Up / Consignee block', () => {
    const { form } = setup(two())
    fireEvent.click(screen.getByText(/1\. Pick/))
    expect(form().focusField).toHaveBeenCalledWith('f-pickup-name', 'pickup')
    fireEvent.click(screen.getByText(/2\. Delivery/))
    expect(form().focusField).toHaveBeenCalledWith('f-consignee-name', 'consignee')
  })

  it('selecting an inserted row edits it in place', () => {
    const { host } = setup([stop('pickup', 'Origin'), stop('pickup', 'M1'), stop('delivery', 'Dest')])
    expect(screen.queryByTestId('stop-stop-1-fields')).toBeNull()
    fireEvent.click(screen.getByText(/2\. Pick/))
    fireEvent.change(screen.getByTestId('f-stop-1-refNo'), { target: { value: 'R9' } })
    expect(host.current!.getValues().stops[1].refNo).toBe('R9')
  })

  it('carries per-stop Pieces and Weight (digits only) for Calculate Totals', () => {
    const { host } = setup(two())
    fireEvent.change(screen.getByTestId('f-picks-pieces-0'), { target: { value: '1a2' } })
    fireEvent.change(screen.getByTestId('f-picks-weight-0'), { target: { value: '3,400' } })
    expect(host.current!.getValues().stops[0]).toMatchObject({ pieces: '12', weightLbs: '3400' })
  })

  it('will not remove a stop the truck has already visited', () => {
    const visited = stop('pickup', 'M1')
    const ctx = makeCtx({ locked: { fields: {}, stops: { [visited.id]: 'The truck has been here' }, voided: false } })
    setup([stop('pickup', 'Origin'), visited, stop('delivery', 'Dest')], ctx)
    expect((screen.getByLabelText('Remove stop 2') as HTMLButtonElement).disabled).toBe(true)
  })
})
