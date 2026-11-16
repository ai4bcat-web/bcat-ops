// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { EmailChipsInput } from './EmailChipsInput'

function Harness({ initial = [] as string[], spy }: { initial?: string[]; spy: (l: string[]) => void }) {
  const [list, setList] = useState<string[]>(initial)
  return <EmailChipsInput label="AP e-mail" value={list} onChange={(l) => { setList(l); spy(l) }} />
}

describe('EmailChipsInput', () => {
  it('pasting a comma list makes one chip per address', () => {
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    const input = screen.getByLabelText('AP e-mail')
    fireEvent.paste(input, { clipboardData: { getData: () => 'gomara@whimsytrucking.com, jgudel@whimsytrucking.com' } })
    expect(screen.getAllByTestId('email-chip').map((c) => c.textContent)).toEqual(['gomara@whimsytrucking.com', 'jgudel@whimsytrucking.com'])
    expect(spy).toHaveBeenLastCalledWith(['gomara@whimsytrucking.com', 'jgudel@whimsytrucking.com'])
  })

  it('Enter and blur commit typed text; an invalid address is shown red, not dropped', () => {
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    const input = screen.getByLabelText('AP e-mail')
    fireEvent.change(input, { target: { value: 'a@x.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'oops' } })
    fireEvent.blur(input)
    const chips = screen.getAllByTestId('email-chip')
    expect(chips.map((c) => c.textContent)).toEqual(['a@x.com', 'oops'])
    expect(chips[1].getAttribute('data-invalid')).toBe('true')
  })

  it('removes a chip with its button', () => {
    const spy = vi.fn()
    render(<Harness initial={['a@x.com', 'b@x.com']} spy={spy} />)
    fireEvent.click(screen.getByLabelText('Remove a@x.com'))
    expect(spy).toHaveBeenLastCalledWith(['b@x.com'])
  })
})
