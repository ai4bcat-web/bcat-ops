// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TmsBadge } from './TmsBadge'
import { statusTone } from './statusTone'

describe('statusTone', () => {
  it('maps the shipment statuses onto the MVMNT badge colours', () => {
    expect(statusTone('DRAFT')).toBe('gray')
    expect(statusTone('TENDER_ACCEPTED')).toBe('purple')
    expect(statusTone('OPEN')).toBe('blue')
    expect(statusTone('ON_HOLD')).toBe('orange')
    expect(statusTone('BOOKED')).toBe('turquoise')
    expect(statusTone('PLANNED')).toBe('turquoise')
    expect(statusTone('IN_TRANSIT')).toBe('blue')
    expect(statusTone('OUT_FOR_DELIVERY')).toBe('blue')
    expect(statusTone('DELIVERED')).toBe('green')
    expect(statusTone('CANCELED')).toBe('red')
    expect(statusTone('VOIDED')).toBe('red')
  })

  it('maps the AR and AP vocabularies', () => {
    expect(statusTone('DOCS_NEEDED')).toBe('orange')
    expect(statusTone('UNBILLED')).toBe('purple')
    expect(statusTone('UNPAID')).toBe('blue')
    expect(statusTone('PAID')).toBe('green')
    expect(statusTone('AWAITING_INVOICE')).toBe('orange')
    expect(statusTone('IN_REVIEW')).toBe('purple')
    expect(statusTone('TO_BE_PAID')).toBe('blue')
  })

  it('falls back to gray for anything it does not know, including empty input', () => {
    expect(statusTone('LEGACY')).toBe('gray')
    expect(statusTone('')).toBe('gray')
    expect(statusTone('in_transit')).toBe('blue')
  })
})

describe('TmsBadge', () => {
  it('renders the tone class so the theme can colour it', () => {
    render(<TmsBadge tone={statusTone('DELIVERED')}>Delivered</TmsBadge>)
    expect(screen.getByText('Delivered')).toHaveClass('tms-badge', 'tms-badge-green')
  })
})
