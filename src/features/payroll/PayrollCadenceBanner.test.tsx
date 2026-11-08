// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PayrollCadenceBanner } from './PayrollCadenceBanner'

describe('PayrollCadenceBanner', () => {
  afterEach(() => vi.useRealTimers())

  it('states the Wednesday rhythm, next pay date and the covered week', () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T18:00:00Z') }) // Thursday in Chicago
    render(<PayrollCadenceBanner />)
    expect(screen.getByTestId('payroll-cadence')).toHaveTextContent(
      'Payroll runs every Wednesday · Next pay date Wed Nov 11 · Covers Sun Nov 1 – Sat Nov 7',
    )
  })
})
