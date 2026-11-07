// @vitest-environment jsdom
/** Smoke test: the Pricing Margin page renders from a stubbed config and computes the example. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { PricingMarginPage } from './PricingMarginPage'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ percent: 10, flatAmount: 0, mode: 'percent', updatedAt: '2030-01-01T00:00:00Z' }),
  })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('PricingMarginPage renders', () => {
  it('shows the heading and primary controls once the config loads', async () => {
    render(<PricingMarginPage />)
    expect(await screen.findByRole('heading', { name: 'Pricing Margin Control' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Save & Push/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Percentage/ })).toBeTruthy()
  })

  it('Show Example applies the loaded 10% margin to the illustrative $850 rate', async () => {
    render(<PricingMarginPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Show Example/ }))
    expect(screen.getByText('$935')).toBeTruthy()
  })
})
