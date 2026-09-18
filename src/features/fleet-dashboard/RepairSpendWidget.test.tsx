import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/store/useAppStore', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({
    equipment: [],
    maintenanceInvoices: [
      { id: 'posted', status: 'POSTED', amount: 12300 },
      { id: 'pending', status: 'PENDING', amount: 45600 },
      { id: 'archived', status: 'ARCHIVED', amount: 78900 },
      { id: 'legacy', amount: 1000 },
    ].map((invoice) => ({ ...invoice, equipmentId: 'truck', date: '2026-09-10', createdAt: '2026-09-10T12:00:00Z' })),
  }),
}))
import { RepairSpendWidget } from './RepairSpendWidget'

it('shows posted and legacy spending without pending or archived repairs', () => {
  const html = renderToStaticMarkup(<MemoryRouter><RepairSpendWidget /></MemoryRouter>)
  expect(html).toContain('$133 total · 2 invoices')
})
