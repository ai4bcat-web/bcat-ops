// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { emptyValues, type ShipmentFormValues } from '../model'
import type { FormCtx } from '../sectionProps'
import { RolesSection } from './RolesSection'
import { ValuesHost, type Host } from './SectionHost'
import { makeCtx, sliceChange } from './sectionTestKit'

vi.mock('@/hooks/useStaff', () => ({ useStaff: () => ({ staff: [], loading: false }) }))

function setup(over: Partial<FormCtx> = {}, seed?: (v: ShipmentFormValues) => ShipmentFormValues) {
  const host: { current: Host | null } = { current: null }
  render(
    <ValuesHost onHost={(h) => { host.current = h }} initial={seed ? seed(emptyValues()) : undefined}>
      {(values, update, form) => (
        <RolesSection value={values.roles} onChange={sliceChange(update, 'roles')} ctx={makeCtx(over)} form={form} />
      )}
    </ValuesHost>,
  )
  return host
}

describe('RolesSection', () => {
  it('shows exactly Sales Representative, Service Representative and Dispatcher Assigned', () => {
    setup()
    const labels = [...document.querySelectorAll('[data-testid^="f-roles-"]')].map((n) => n.getAttribute('data-testid'))
    expect(labels).toEqual(['f-roles-salesRepId', 'f-roles-serviceRepId', 'f-roles-dispatcherAssignedId'])
    for (const gone of ['Dispatcher Actual', 'Tariff', 'Quote']) expect(screen.queryByLabelText(gone)).toBeNull()
  })
})
