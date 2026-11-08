// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CustomerRecord } from '@/types/tms'
import { BillingSetupPage } from './BillingSetupPage'

const h = vi.hoisted(() => ({
  customers: [] as unknown[],
  saveCustomer: vi.fn(),
  shipments: vi.fn(),
}))

vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: () => ({
    customers: h.customers, locations: [], loading: false, error: null,
    refresh: vi.fn(), saveCustomer: h.saveCustomer,
  }),
}))
vi.mock('@/lib/apiClient', () => ({ listShipmentsByMonthFiltered: (m: string) => h.shipments(m) }))
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }))

const c = (o: Partial<CustomerRecord> & { id: string; name: string }) =>
  ({ createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', ...o }) as CustomerRecord

const renderPage = () => render(<MemoryRouter><BillingSetupPage /></MemoryRouter>)

beforeEach(() => {
  cleanup()
  h.saveCustomer.mockReset().mockResolvedValue({})
  h.shipments.mockReset().mockResolvedValue([])
  h.customers = [
    c({ id: 'a', name: 'ZZ Alpha', aljexCode: '900001', billingMethod: 'FACTOR' }),
    c({ id: 'b', name: 'ZZ Beta', aljexCode: '900002', billingMethod: 'MANUAL', apEmail: 'ap@beta.example' }),
    c({ id: 'c', name: 'ZZ Gamma', aljexCode: '900003' }),
    c({ id: 'e', name: 'ZZ Eps', aljexCode: '900005', billingMethod: 'MANUAL', apEmail: 'e@eps.example', billingNeedsReview: 'internal billing address' }),
  ]
})

describe('BillingSetupPage', () => {
  it('shows the header counts and the Missing filter', async () => {
    renderPage()
    expect(screen.getByTestId('count-factor')).toHaveTextContent('1')
    expect(screen.getByTestId('count-manual')).toHaveTextContent('2')
    expect(screen.getByTestId('count-not-set')).toHaveTextContent('1')
    expect(screen.getByTestId('count-needs-review')).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('tab', { name: /Missing/ }))
    expect(screen.queryByText('ZZ Alpha')).toBeNull()
    expect(screen.getByText('ZZ Gamma')).toBeInTheDocument()
    expect(screen.getByText('ZZ Eps')).toBeInTheDocument()
  })

  it('shows loads from the last 12 months', async () => {
    h.shipments.mockImplementation(async (m: string) => (m === 'x' ? [] : [{ customerId: 'a' }]))
    renderPage()
    const row = screen.getByText('ZZ Alpha').closest('tr') as HTMLElement
    await waitFor(() => expect(within(row).getByText('12')).toBeInTheDocument())
  })

  it('refuses to save MANUAL without an AP e-mail, then saves and clears the review flag', async () => {
    renderPage()
    const row = screen.getByText('ZZ Eps').closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: /Edit ZZ Eps/ }))
    fireEvent.change(screen.getByLabelText('ZZ Eps AP e-mail'), { target: { value: '' } })
    expect(within(row).getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('ZZ Eps AP e-mail'), { target: { value: 'New@Eps.example' } })
    fireEvent.change(screen.getByLabelText('ZZ Eps copy list'), { target: { value: 'cc@eps.example; cc@eps.example' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.saveCustomer).toHaveBeenCalledTimes(1))
    expect(h.saveCustomer.mock.calls[0][1]).toEqual({
      billingMethod: 'MANUAL', apEmail: 'new@eps.example', invoiceCopyEmails: ['cc@eps.example'], billingNeedsReview: null,
    })
  })

  it('import applies changed rows, holds needs-review rows until ticked', async () => {
    renderPage()
    const csv = [
      'customer,aljexCode,method,apEmail,copyList',
      'ZZ Gamma,900003,MANUAL,ap@gamma.example,',
      'ZZ Eps,900005,MANUAL,other@eps.example,',
    ].join('\n')
    const file = new File([csv], 'in.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'text', { value: async () => csv })
    fireEvent.change(screen.getByTestId('billing-import-file'), { target: { files: [file] } })
    await screen.findByText('Import preview')
    expect(screen.getByTestId('import-counts')).toHaveTextContent('1 will change · 1 needs review')
    const apply = screen.getByRole('button', { name: /Apply 1 change$/ })
    fireEvent.click(apply)
    await waitFor(() => expect(h.saveCustomer).toHaveBeenCalledTimes(1))
    expect((h.saveCustomer.mock.calls[0][0] as CustomerRecord).id).toBe('c')
  })

  it('import applies a held row once it is confirmed', async () => {
    renderPage()
    const csv = 'customer,aljexCode,method,apEmail,copyList\nZZ Eps,900005,MANUAL,other@eps.example,'
    const file = new File([csv], 'in.csv')
    Object.defineProperty(file, 'text', { value: async () => csv })
    fireEvent.change(screen.getByTestId('billing-import-file'), { target: { files: [file] } })
    await screen.findByText('Import preview')
    expect(screen.getByRole('button', { name: /Apply 0 changes/ })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Confirm line 2'))
    fireEvent.click(screen.getByRole('button', { name: /Apply 1 change$/ }))
    await waitFor(() => expect(h.saveCustomer).toHaveBeenCalledTimes(1))
    expect(h.saveCustomer.mock.calls[0][1]).toMatchObject({ apEmail: 'other@eps.example', billingNeedsReview: null })
  })
})
