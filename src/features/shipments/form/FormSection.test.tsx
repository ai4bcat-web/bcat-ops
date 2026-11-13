// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FormSection } from './FormSection'

describe('FormSection covered state', () => {
  it('a complete (covered) card turns green and says Covered', () => {
    render(<FormSection id="carrier" number={4} title="Carrier & Tracking" errorCount={0} state="complete"><p>body</p></FormSection>)
    expect(screen.getByTestId('section-carrier').className).toContain('tms-ship-card--saved')
    expect(screen.getByTestId('section-carrier-saved').textContent).toBe('✓ Covered')
  })

  it('neutral shows no chip and keeps the normal look', () => {
    render(<FormSection id="rates" number={3} title="Rates" errorCount={0}><p>body</p></FormSection>)
    expect(screen.getByTestId('section-rates').className).not.toContain('tms-ship-card--saved')
    expect(screen.queryByTestId('section-rates-saved')).toBeNull()
  })
})
