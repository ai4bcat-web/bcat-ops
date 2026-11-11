// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { Field } from './Field'

describe('Field required marker', () => {
  it('shows a red asterisk after the label of a required field only', () => {
    const { container, rerender } = render(<Field label="Customer ref" span={6} required><input /></Field>)
    expect(container.querySelector('.tms-fg-star')).toHaveTextContent('*')
    expect(container.querySelector('.tms-fg-label-text')).toHaveTextContent(/^Customer ref$/)
    rerender(<Field label="Customer ref" span={6}><input /></Field>)
    expect(container.querySelector('.tms-fg-star')).toBeNull()
  })
})
