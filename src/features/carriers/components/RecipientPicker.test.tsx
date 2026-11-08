// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'

import { RecipientPicker } from './RecipientPicker'
import type { RecipientOption } from './rateConRecipients'

const options: RecipientOption[] = [
  { email: 'dana@swift.com', label: 'Dana · Dispatch' },
  { email: 'main@swift.com', label: 'Carrier e-mail' },
]

/** Hosts the controlled state and prints the result so assertions read what a user sees. */
function Host({ initial }: { initial: string[] }) {
  const [selected, setSelected] = useState(initial)
  const [extras, setExtras] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  return (
    <>
      <RecipientPicker
        options={options}
        selected={selected}
        extras={extras}
        draft={draft}
        onDraftChange={setDraft}
        onSelectedChange={setSelected}
        onExtrasChange={setExtras}
      />
      <output data-testid="state">{JSON.stringify({ selected, extras })}</output>
    </>
  )
}

const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}') as { selected: string[]; extras: string[] }
const box = () => screen.getByLabelText('Add another address')
const type = (text: string) => { fireEvent.change(box(), { target: { value: text } }); fireEvent.keyDown(box(), { key: 'Enter' }) }

describe('RecipientPicker', () => {
  it('renders known addresses as checkboxes with the defaults ticked', () => {
    render(<Host initial={['dana@swift.com']} />)
    expect(screen.getByLabelText(/dana@swift\.com/)).toBeChecked()
    expect(screen.getByLabelText(/main@swift\.com/)).not.toBeChecked()
  })

  it('refuses an invalid address with an alert and adds nothing', () => {
    render(<Host initial={[]} />)
    type('bad@')
    expect(screen.getByRole('alert')).toHaveTextContent('"bad@" is not a valid email address.')
    expect(state().extras).toEqual([])
  })

  it('adds a typed address as a chip once, whatever its case, and lets it be removed', () => {
    render(<Host initial={[]} />)
    type('New@Carrier.com')
    type('new@carrier.COM')
    expect(state().extras).toEqual(['New@Carrier.com'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove New@Carrier.com' }))
    expect(state().extras).toEqual([])
  })

  it('ticks the matching option instead of duplicating a known address', () => {
    render(<Host initial={[]} />)
    type('MAIN@swift.com')
    expect(screen.getByLabelText(/main@swift\.com/)).toBeChecked()
    expect(state()).toEqual({ selected: ['main@swift.com'], extras: [] })
  })
})
