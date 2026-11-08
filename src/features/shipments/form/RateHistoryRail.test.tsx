// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateHistoryRail } from './RateHistoryRail'
import { readRailOpen } from './railOpen'
import type { CardProps } from './cards/cardRegistry'

vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ userId: 'u1', email: 'rep@bcat.test', groups: [] }) }))
const common = {} as CardProps
const Body = () => <div data-testid="rh-body" />

beforeEach(() => { localStorage.clear(); Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true }) })

describe('RateHistoryRail', () => {
  it('is open by default on the wide rail and closed in the bottom sheet', () => {
    expect(readRailOpen('u', true)).toBe(true)
    expect(readRailOpen('u', false)).toBe(false)
    Object.defineProperty(window, 'innerWidth', { value: 1100, configurable: true })
    render(<RateHistoryRail common={common} Body={Body} />)
    expect(screen.queryByTestId('rh-body')).toBeNull()
  })
  it('remembers the choice per user', () => {
    const { unmount } = render(<RateHistoryRail common={common} Body={Body} />)
    expect(screen.getByTestId('rh-body')).toBeTruthy()
    fireEvent.click(screen.getByTestId('rail-rate-history-toggle'))
    expect(screen.queryByTestId('rh-body')).toBeNull()
    expect(localStorage.getItem('tms:ship-form:rail-rate-history:rep@bcat.test')).toBe('closed')
    unmount()
    render(<RateHistoryRail common={common} Body={Body} />)
    expect(screen.queryByTestId('rh-body')).toBeNull()
    expect(screen.getByTestId('rail-rate-history-toggle').getAttribute('aria-expanded')).toBe('false')
  })
})
