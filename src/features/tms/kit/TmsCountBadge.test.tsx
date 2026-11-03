// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { TmsCountBadge } from './TmsCountBadge'

describe('TmsCountBadge', () => {
  it('renders nothing for zero and negative counts', () => {
    const zero = render(<TmsCountBadge count={0} />)
    expect(zero.container.firstChild).toBeNull()
    const neg = render(<TmsCountBadge count={-3} />)
    expect(neg.container.firstChild).toBeNull()
  })

  it('caps at max with a plus sign', () => {
    const a = render(<TmsCountBadge count={150} />)
    expect(a.container.textContent).toBe('99+')
    const b = render(<TmsCountBadge count={12} max={9} tone="amber" />)
    expect(b.container.textContent).toBe('9+')
    expect(b.container.firstElementChild?.className).toContain('tms-count-amber')
  })

  it('shows the exact count at or below max', () => {
    const a = render(<TmsCountBadge count={99} />)
    expect(a.container.textContent).toBe('99')
  })
})
