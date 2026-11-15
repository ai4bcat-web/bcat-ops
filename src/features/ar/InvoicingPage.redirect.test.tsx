// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPageAccess: () => true }) }))
vi.mock('./ArPage', () => ({ ArPage: () => <p>AR page</p> }))
vi.mock('@/features/ap/ApPage', () => ({ ApPage: () => <p>AP page</p> }))
vi.mock('@/features/factoring/FactoringPage', () => ({ FactoringPage: () => <p>Factoring page</p> }))

import { InvoicingPage } from './InvoicingPage'

function Where() {
  const { pathname, search } = useLocation()
  return <p>at {pathname}{search}</p>
}

describe('Invoicing → Payments received redirect', () => {
  it('sends the old Payments & credits tab link to the Payments received page, keeping the customer', () => {
    render(
      <MemoryRouter initialEntries={['/tms/invoicing?tab=payments&customer=c1']}>
        <Routes>
          <Route path="/tms/invoicing" element={<InvoicingPage />} />
          <Route path="/tms/payments-received" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('at /tms/payments-received?customer=c1')).toBeTruthy()
  })

  it('leaves other Receivable tabs alone', () => {
    render(<MemoryRouter initialEntries={['/tms/invoicing?tab=aging']}><Routes><Route path="/tms/invoicing" element={<InvoicingPage />} /></Routes></MemoryRouter>)
    expect(screen.getByText('AR page')).toBeTruthy()
  })
})
