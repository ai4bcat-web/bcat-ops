// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { InstructionsTab } from './InstructionsTab'
import { UpdatesTab } from './UpdatesTab'
import { emptyValues, type ShipmentFormValues } from '../../model'
import { makeCtx, makeForm } from '../../sections/ah5TestKit'
import type { CardProps } from '../cardRegistry'

// The real apiClient builds its Amplify client on import; stub the client so nothing needs Amplify.configure().
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))
vi.mock('@/features/shipments/components/HistorySection', () => ({ HistorySection: () => <div>history</div> }))

function props(more: Partial<ShipmentFormValues['more']>): CardProps & { update: ReturnType<typeof vi.fn> } {
  const values = { ...emptyValues(), more: { ...emptyValues().more, ...more } }
  const form = makeForm(values)
  return { values, update: vi.fn(), ctx: makeCtx(), form, issues: [], mode: 'create', locked: makeCtx().locked } as never
}

describe('InstructionsTab', () => {
  it('counts down the 420 / 2000 / 260 character limits', () => {
    render(<InstructionsTab {...props({ specialInstructions: 'x'.repeat(20), rateConNotes: 'r'.repeat(5), bolNotes: 'y'.repeat(10) })} />)
    expect(screen.getByTestId('more-special-counter').textContent).toBe('400 characters remaining')
    expect(screen.getByTestId('more-ratecon-counter').textContent).toBe('1995 characters remaining')
    expect(screen.getByTestId('more-bol-counter').textContent).toBe('250 characters remaining')
  })

  it('never cuts stored BOL text silently: an over-limit note can shrink but not grow', () => {
    const long = 'z'.repeat(300)
    const p = props({ bolNotes: long })
    render(<InstructionsTab {...p} />)
    expect(screen.getByTestId('more-bol-counter').textContent).toBe('40 over')
    const box = screen.getByLabelText('Bill of Lading Notes')
    fireEvent.change(box, { target: { value: long + 'q' } })
    expect(p.update).not.toHaveBeenCalled()
    fireEvent.change(box, { target: { value: long.slice(0, 299) } })
    const fn = p.update.mock.calls[0][0] as (v: ShipmentFormValues) => ShipmentFormValues
    expect(fn(p.values).more.bolNotes).toBe(long.slice(0, 299))
  })
})

describe('UpdatesTab', () => {
  it('says nothing exists before the first save', () => {
    render(<UpdatesTab {...props({})} />)
    expect(screen.getByText('Updates appear after the first save.')).toBeTruthy()
  })
})
