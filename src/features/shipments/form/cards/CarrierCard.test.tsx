// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierCard } from './CarrierCard'
import { emptyValues } from '../model'
import { makeCtx, makeForm } from '../sections/ah5TestKit'

vi.mock('@/hooks/useOwnFleetRoster', () => ({ useOwnFleetRoster: () => [] }))

function show(code: string, update = vi.fn()) {
  const values = emptyValues()
  values.ship.revDivision = code
  const division = { id: 'd1', code, name: code === 'IVAN' ? 'Ivan Cartage' : 'Brokerage', active: true } as never
  render(
    <MemoryRouter>
      <CarrierCard values={values} update={update} form={makeForm(values)} issues={[]} mode="create"
        ctx={makeCtx({ divisions: [{ division, depth: 0 }] })} locked={makeCtx().locked} />
    </MemoryRouter>,
  )
}

describe('CarrierCard', () => {
  it('the Ivan Cartage division marks the leg own-fleet so the roster driver picker shows; other divisions do not', () => {
    const own = vi.fn()
    show('IVAN', own)
    const next = own.mock.calls[0][0]((emptyValues()))
    expect(next.carrier.isOwnFleet).toBe(true)
    const none = vi.fn()
    show('BROKER', none)
    expect(none).not.toHaveBeenCalled()
  })

  it('stays collapsed for a brokerage division', () => {
    show('BROKER')
    expect(screen.getByTestId('carrier-empty')).toBeTruthy()
  })

  it('opens straight to the own-fleet choice for the Ivan Cartage division', () => {
    show('IVAN')
    expect(screen.queryByTestId('carrier-empty')).toBeNull()
    expect(screen.getByTestId('carrier-own-fleet')).toBeTruthy()
  })
})
