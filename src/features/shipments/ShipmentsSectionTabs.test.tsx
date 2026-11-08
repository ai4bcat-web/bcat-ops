// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'
import { ShipmentsSectionTabs } from './ShipmentsSectionTabs'

vi.mock('./intake/useIntakeLoads', () => ({ useOpenIntakeCount: () => 4 }))

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{loc.pathname + loc.search}</div>
}

function renderTabs(current: 'active' | 'all' | 'intake') {
  return render(
    <MemoryRouter initialEntries={['/start']}>
      <Routes>
        <Route path="*" element={<><ShipmentsSectionTabs current={current} activeCount={12} allCount={30} /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ShipmentsSectionTabs', () => {
  it('marks the current tab and shows each count, Intake from the open-intake hook', () => {
    renderTabs('all')
    expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Active/ })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: /Active/ })).toHaveTextContent('12')
    expect(screen.getByRole('tab', { name: /All/ })).toHaveTextContent('30')
    expect(screen.getByRole('tab', { name: /Intake/ })).toHaveTextContent('4')
  })

  it('navigates Active, All and Intake to their URLs', () => {
    renderTabs('active')
    fireEvent.click(screen.getByRole('tab', { name: /All/ }))
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/shipments?list=all')
    fireEvent.click(screen.getByRole('tab', { name: /Intake/ }))
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/shipments/intake')
  })

  it('sends Active to the bare list URL', () => {
    renderTabs('all')
    fireEvent.click(screen.getByRole('tab', { name: /Active/ }))
    expect(screen.getByTestId('where').textContent).toBe('/tms/shipments')
  })
})
