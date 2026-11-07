// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'

const deployed = vi.hoisted(() => ({ models: new Set<string>() }))
vi.mock('@/lib/modelAvailability', () => ({
  modelAvailable: (name: string) => deployed.models.has(name),
  modelsAvailable: (names: readonly string[]) => names.every((n) => deployed.models.has(n)),
}))

import { LifecycleTabs } from './LifecycleTabs'
import { LIFECYCLE_TABS } from '@/lib/lifecycleTabs'
import { DORMANT_PAGES } from '@/lib/dormantPages'

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function setup(pathname = '/tms/customers') {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <LifecycleTabs pathname={pathname} canOpenPage={() => true} badgeCounts={{ quotesToReply: 4, carrierSales: 2 }} />
      <Where />
    </MemoryRouter>,
  )
}

describe('LifecycleTabs while the shipment tables are not deployed', () => {
  beforeEach(() => { deployed.models = new Set() })

  it('shows all six steps, disabled with the merge tooltip, and none is a link', () => {
    setup()
    const nav = screen.getByRole('navigation', { name: 'Shipment lifecycle' })
    expect(nav.querySelectorAll('a')).toHaveLength(0)
    for (const tab of LIFECYCLE_TABS) {
      const el = screen.getByTestId(`lifecycle-tab-${tab.key}`)
      expect(el).toHaveAttribute('aria-disabled', 'true')
      expect(el).toHaveAttribute('title', 'Switches on during the merge')
      expect(el).toHaveTextContent(tab.label)
      expect(el).not.toHaveAttribute('href')
    }
  })

  it('draws no count badge on a disabled step', () => {
    setup()
    expect(screen.queryByTestId('lifecycle-badge-quote')).toBeNull()
    expect(screen.queryByTestId('lifecycle-badge-book')).toBeNull()
  })

  it('does not navigate on click or on its Alt+number shortcut', () => {
    setup()
    fireEvent.click(screen.getByTestId('lifecycle-tab-view'))
    fireEvent.keyDown(window, { code: 'Digit3', altKey: true })
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/customers')
  })

  it('turns a step on as soon as its page has its models, leaving the others disabled', () => {
    deployed.models = new Set(DORMANT_PAGES.quotes.models)
    setup()
    const quote = screen.getByTestId('lifecycle-tab-quote')
    expect(quote.tagName).toBe('A')
    expect(quote).not.toHaveAttribute('aria-disabled')
    expect(screen.getByTestId('lifecycle-badge-quote')).toBeInTheDocument()
    expect(screen.getByTestId('lifecycle-tab-review')).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(window, { code: 'Digit1', altKey: true })
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/rates/spot')
  })
})
