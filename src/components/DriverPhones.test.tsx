// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DriverPhones } from './DriverPhones'
import type { DriverPhones as Phones } from '@/lib/workPhone'

const base: Phones = { truckId: 't12', truckNumber: '12', work: null, personal: '+13125550199', personalRaw: '+13125550199' }

describe('DriverPhones', () => {
  it('stacked: shows the work and personal numbers as tel links', () => {
    const { container } = render(<DriverPhones variant="stacked" phones={{ ...base, work: { number: '+13125550100', label: null } }} />)
    expect(container.querySelector('[data-testid="driver-phone-work"]')).toHaveTextContent('Work (truck 12): (312) 555-0100')
    expect(container.querySelector('[data-testid="driver-phone-personal"]')).toHaveTextContent('Personal: (312) 555-0199')
    expect(container.querySelector('a[href="tel:+13125550100"]')).not.toBeNull()
  })

  it('a truck without a phone says none, in the warning colour, and still shows personal', () => {
    const { container } = render(<DriverPhones variant="inline" phones={base} />)
    const work = container.querySelector('[data-testid="driver-phone-work"]')
    expect(work).toHaveTextContent('Work (truck 12): none')
    expect(work).toHaveStyle({ color: 'var(--tms-badge-orange)' })
    expect(container).toHaveTextContent('Personal: (312) 555-0199')
  })

  it('no truck shows only the personal number', () => {
    const { container } = render(<DriverPhones variant="stacked" phones={{ ...base, truckId: null, truckNumber: null }} />)
    expect(container.querySelector('[data-testid="driver-phone-work"]')).toBeNull()
    expect(container).toHaveTextContent('Personal: (312) 555-0199')
  })

  it('compact: work only, personal in the tooltip', () => {
    const { container } = render(<DriverPhones variant="compact" phones={{ ...base, work: { number: '+13125550100', label: null } }} />)
    expect(container).toHaveTextContent('Work (truck 12): (312) 555-0100')
    expect(container.querySelector('[data-testid="driver-phone-personal"]')).toBeNull()
    expect(container.querySelector('[title="Personal: (312) 555-0199"]')).not.toBeNull()
  })
})
