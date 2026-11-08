// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TrackingPrefsFields } from './TrackingPrefsFields'

const set = { trackingMode: 'AGENT', trackingMethod: 'BOTH', driverSmsTarget: 'WORK_THEN_PERSONAL' } as const
const unset = { trackingMode: '', trackingMethod: '', driverSmsTarget: '' } as const

describe('TrackingPrefsFields', () => {
  it('reports only the control that changed', () => {
    const onChange = vi.fn()
    render(<TrackingPrefsFields value={set} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'E-mail thread (dispatcher)' }))
    expect(onChange).toHaveBeenLastCalledWith({ trackingMethod: 'EMAIL' })
    fireEvent.change(screen.getByLabelText('Driver SMS goes to'), { target: { value: 'WORK_ONLY' } })
    expect(onChange).toHaveBeenLastCalledWith({ driverSmsTarget: 'WORK_ONLY' })
  })

  it('explains an unset choice only when asked to (legacy customers)', () => {
    const { rerender } = render(<TrackingPrefsFields value={unset} onChange={vi.fn()} />)
    expect(screen.queryByText(/Not set/)).toBeNull()
    rerender(<TrackingPrefsFields value={unset} onChange={vi.fn()} legacyHint />)
    expect(screen.getByText(/Not set — follows Settings › Tracking automation/)).toBeTruthy()
    rerender(<TrackingPrefsFields value={set} onChange={vi.fn()} legacyHint />)
    expect(screen.queryByText(/Not set — follows/)).toBeNull()
  })

  it('offers the three driver SMS targets', () => {
    render(<TrackingPrefsFields value={set} onChange={vi.fn()} />)
    const opts = Array.from((screen.getByLabelText('Driver SMS goes to') as HTMLSelectElement).options).map((o) => o.value)
    expect(opts).toEqual(['WORK_THEN_PERSONAL', 'WORK_ONLY', 'PERSONAL'])
  })
})
