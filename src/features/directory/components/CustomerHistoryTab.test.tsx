// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ listAuditLogsFor: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ listAuditLogsFor: h.listAuditLogsFor }))

import { CustomerHistoryTab } from './CustomerHistoryTab'

describe('CustomerHistoryTab', () => {
  it('lists changes newest first with who, what changed and why, from both entity spellings', async () => {
    h.listAuditLogsFor.mockResolvedValue([
      { id: '1', entityType: 'CUSTOMER', entityId: 'c1', action: 'CUSTOMER_UPDATED', user: 'ryne@bcatcorp.com', createdAt: '2026-11-14T15:00:00Z',
        changes: { kind: 'customer-change', fields: [{ field: 'billingMethod', before: 'FACTOR', after: 'MANUAL' }], reason: 'OTR rejected: debtor not approved', source: 'OTR rejected → manual invoice' } },
      { id: '2', entityType: 'Customer', entityId: 'c1', action: 'AW_CUSTOMERS_ACTIVATE', user: 'system:awCustomersActivate', createdAt: '2026-11-01T15:00:00Z',
        changes: { status: { from: 'DORMANT', to: 'ACTIVE' } } },
    ])
    render(<CustomerHistoryTab customerId="c1" />)
    await waitFor(() => expect(screen.getAllByTestId('customer-history-entry')).toHaveLength(2))
    expect(h.listAuditLogsFor).toHaveBeenCalledWith([{ entityType: 'CUSTOMER', entityId: 'c1' }, { entityType: 'Customer', entityId: 'c1' }])
    const [first, second] = screen.getAllByTestId('customer-history-entry')
    expect(first.textContent).toContain('Payment method')
    expect(first.textContent).toContain('Factor')
    expect(first.textContent).toContain('Manual invoice')
    expect(first.textContent).toContain('Why: OTR rejected: debtor not approved')
    expect(second.textContent).toContain('Script awCustomersActivate')
    expect(second.textContent).toContain('DORMANT')
  })

  it('says so when nothing is recorded', async () => {
    h.listAuditLogsFor.mockResolvedValue([])
    render(<CustomerHistoryTab customerId="c2" />)
    await waitFor(() => expect(screen.getByText('No changes recorded yet')).toBeTruthy())
  })
})
