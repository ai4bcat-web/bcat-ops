// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FormSection } from './FormSection'

describe('FormSection saved state', () => {
  it('a complete card turns green and says Saved', () => {
    render(<FormSection id="freight" number={1} title="Freight" errorCount={0} state="complete"><p>body</p></FormSection>)
    const card = screen.getByTestId('section-freight')
    expect(card.className).toContain('tms-ship-card--saved')
    expect(screen.getByTestId('section-freight-saved').textContent).toBe('✓ Saved')
  })

  it('an unsaved card keeps the normal look with an Unsaved chip', () => {
    render(<FormSection id="route" number={2} title="Route" errorCount={0} state="unsaved"><p>body</p></FormSection>)
    expect(screen.getByTestId('section-route').className).not.toContain('tms-ship-card--saved')
    expect(screen.getByTestId('section-route-unsaved')).toBeTruthy()
  })

  it('neutral shows neither chip', () => {
    render(<FormSection id="rates" number={3} title="Rates" errorCount={0}><p>body</p></FormSection>)
    expect(screen.queryByTestId('section-rates-saved')).toBeNull()
    expect(screen.queryByTestId('section-rates-unsaved')).toBeNull()
  })
})
