// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SelectAllBox } from './SelectAllBox'

function Harness({ ids, initial = [] }: { ids: string[]; initial?: string[] }) {
  const [selected, setSelected] = useState<string[]>(initial)
  return (
    <>
      <SelectAllBox ids={ids} selected={selected} onSelect={setSelected} noun="invoices" />
      <output data-testid="picked">{selected.join(',')}</output>
    </>
  )
}

describe('SelectAllBox', () => {
  it('ticks every shown id, and clears just those again', () => {
    render(<Harness ids={['a', 'b']} initial={['z']} />)
    const box = screen.getByRole('checkbox', { name: 'Select all 2 invoices shown' }) as HTMLInputElement
    fireEvent.click(box)
    expect(screen.getByTestId('picked').textContent).toBe('z,a,b')
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    // A row ticked earlier that is not shown stays ticked.
    expect(screen.getByTestId('picked').textContent).toBe('z')
  })

  it('is indeterminate when only some shown ids are ticked, and a click ticks the rest', () => {
    render(<Harness ids={['a', 'b', 'c']} initial={['b']} />)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(box.indeterminate).toBe(true)
    fireEvent.click(box)
    expect(screen.getByTestId('picked').textContent).toBe('b,a,c')
  })

  it('draws nothing when no shown row can be ticked', () => {
    render(<Harness ids={[]} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
