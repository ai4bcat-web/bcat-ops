// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { TrackingSummary } from './trackingSummary'
import { TrackingSummaryStrip } from './TrackingSummaryStrip'

const summary = {
  driver: { name: 'John', truckNumber: '12' },
  phones: { work: null, personal: null },
  lastKnown: { place: 'Joliet, IL', ageMinutes: 14, source: 'LINK' },
  eta: { at: '2026-11-04T23:00:00.000Z', estimated: false, lateMinutes: null },
  nextCheck: { state: 'NONE', minutes: null, at: null },
  pod: null,
  carrier: { label: 'Own fleet', contactName: null, phone: null, email: null },
} as unknown as TrackingSummary

const SEGMENTS = ['strip-driver', 'strip-phones', 'last-known', 'delivery-eta', 'strip-next-check', 'strip-pod', 'strip-carrier']

describe('TrackingSummaryStrip', () => {
  it('with a prefs slot is two lines: the facts first, the slot second', () => {
    const { container } = render(<TrackingSummaryStrip summary={summary} busy={false} onSetNextCheck={vi.fn()} prefs={<span data-testid="slot" />} />)
    const lines = container.querySelectorAll('.tms-strip-line')
    expect(lines).toHaveLength(2)
    for (const id of SEGMENTS) expect(lines[0].querySelector(`[data-testid="${id}"]`)).not.toBeNull()
    expect(lines[1]).toContainElement(screen.getByTestId('slot'))
  })

  it('without a prefs slot stays one line (the check-call form mounts it that way)', () => {
    const { container } = render(<TrackingSummaryStrip summary={summary} busy={false} onSetNextCheck={vi.fn()} />)
    expect(container.querySelectorAll('.tms-strip-line')).toHaveLength(1)
  })
})
