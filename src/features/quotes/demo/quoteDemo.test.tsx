// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, renderHook, screen, act } from '@testing-library/react'
import { DEMO_QUOTES } from '../demoQuotes'
import { demoRows, demoTotals } from './quoteDemoModel'
import { demoShown, quoteDemoKey, readDemoChoice, useQuoteDemo, writeDemoChoice } from './useQuoteDemo'
import { DemoToggle, QuoteDemoPanel } from './QuoteDemoPanel'

const auth = vi.hoisted(() => ({ email: 'rep@example.test' as string | null }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: auth.email ? { email: auth.email } : null }) }))

beforeEach(() => { window.localStorage.clear(); auth.email = 'rep@example.test' })

describe('demo model', () => {
  it('sorts newest first and derives the totals from the rows', () => {
    const rows = demoRows()
    expect(rows).toHaveLength(DEMO_QUOTES.length)
    for (let i = 1; i < rows.length; i += 1) expect(rows[i - 1]!.date >= rows[i]!.date).toBe(true)
    const t = demoTotals()
    expect(t.received).toBe(DEMO_QUOTES.length)
    expect(t.won).toBe(DEMO_QUOTES.filter((q) => q.outcome === 'won').length)
    expect(t.winRate).toBeCloseTo(t.won / t.received)
    expect(t.wonCents).toBe(DEMO_QUOTES.filter((q) => q.outcome === 'won').reduce((s, q) => s + (q.finalCents ?? 0), 0))
    const outcomes = new Set(DEMO_QUOTES.map((q) => q.outcome))
    for (const o of ['won', 'lost', 'pending', 'expired']) expect(outcomes.has(o as never)).toBe(true)
  })
})

describe('when demo data shows', () => {
  it('is on only while the real count is known to be zero, and a saved choice always wins', () => {
    expect(demoShown(null, 0)).toBe(true)
    expect(demoShown(null, 5)).toBe(false)
    expect(demoShown(null, null)).toBe(false) // still loading: never flash demo rows over real ones
    expect(demoShown(true, 5)).toBe(true)
    expect(demoShown(false, 0)).toBe(false)
  })

  it('remembers the choice per user and tolerates storage failing', () => {
    const { result, rerender } = renderHook(({ n }) => useQuoteDemo(n), { initialProps: { n: 3 as number | null } })
    expect(result.current.on).toBe(false)
    act(() => result.current.setOn(true))
    expect(result.current.on).toBe(true)
    expect(window.localStorage.getItem(quoteDemoKey('rep@example.test'))).toBe('on')
    rerender({ n: 0 })
    expect(result.current.on).toBe(true)
    // another user on the same browser has their own (empty) choice
    auth.email = 'other@example.test'
    rerender({ n: 3 })
    expect(result.current.on).toBe(false)
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => writeDemoChoice('k', true)).not.toThrow()
    spy.mockRestore()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readDemoChoice('k')).toBeNull()
    vi.restoreAllMocks()
  })
})

describe('QuoteDemoPanel', () => {
  it('labels everything as demo, opens a conversation, and every action is disabled', () => {
    render(<QuoteDemoPanel tab="inbox" />)
    expect(screen.getByRole('note')).toHaveTextContent(/made-up demo data/)
    expect(screen.getAllByTestId('demo-badge').length).toBeGreaterThan(DEMO_QUOTES.length)
    const actions = screen.getAllByTestId('demo-action')
    expect(actions.length).toBe(DEMO_QUOTES.length)
    for (const a of actions) { expect(a).toBeDisabled(); expect(a).toHaveAttribute('title', 'Demo data') }
    expect(screen.getByTestId('demo-totals')).toHaveTextContent('Win rate')
    const first = demoRows()[0]!
    fireEvent.click(screen.getAllByText(`${first.origin} → ${first.destination}`)[0]!)
    expect(screen.getByTestId('thread')).toBeInTheDocument()
  })

  it('the toggle reports its checked state', () => {
    const onChange = vi.fn()
    render(<DemoToggle on={false} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Show demo data'))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
