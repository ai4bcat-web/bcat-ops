// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { CarriersHub } from './CarriersHub'

vi.mock('./CarriersPage', () => ({ CarriersPage: () => <div data-testid="list-body" /> }))
vi.mock('./find/FindInvitePage', () => ({ FindInvitePage: () => <div data-testid="find-body" /> }))

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Where />
      <Routes>
        <Route path="/tms/carriers" element={<CarriersHub tab="list" />} />
        <Route path="/tms/carriers/find" element={<CarriersHub tab="find" />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CarriersHub', () => {
  it('lists Find & Invite first and Carrier list second', () => {
    renderAt('/tms/carriers/find')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Find & Invite', 'Carrier list'])
  })

  it('shows the Find & Invite body and lights its tab on /tms/carriers/find', () => {
    renderAt('/tms/carriers/find')
    expect(screen.getByTestId('find-body')).toBeTruthy()
    expect(screen.queryByTestId('list-body')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Find & Invite' }).getAttribute('aria-selected')).toBe('true')
  })

  it('shows the list body on /tms/carriers and moves between tabs through the URL', () => {
    renderAt('/tms/carriers')
    expect(screen.getByTestId('list-body')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Carrier list' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Find & Invite' }))
    expect(screen.getByTestId('where').textContent).toBe('/tms/carriers/find')
    expect(screen.getByTestId('find-body')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Carrier list' }))
    expect(screen.getByTestId('where').textContent).toBe('/tms/carriers')
  })
})
