// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RemitDirectoryPage } from './RemitDirectoryPage'

const api = vi.hoisted(() => ({
  listCarrierRemitEmails: vi.fn(),
  getFactorRemitEmails: vi.fn(),
  setFactorRemitEmail: vi.fn(),
  setPayeeRemitEmail: vi.fn(),
}))
const auth = vi.hoisted(() => ({ isAdmin: true, hasPageAccess: (_: string) => true }))

vi.mock('@/lib/apiClient', () => ({ ...api, graphqlErrorText: (e: unknown) => String(e) }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({
    loading: false,
    error: null,
    carriers: [
      { id: 'c1', name: 'Direct Haul', mcNumber: '111', status: 'ACTIVE' },
      { id: 'c2', name: 'Factored Freight', mcNumber: '222', status: 'ACTIVE' },
      { id: 'c3', name: 'No Email Direct', mcNumber: '333', status: 'ACTIVE' },
    ],
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const methods = [
  { carrierId: 'c1', recipientType: 'CARRIER', payeeEmail: 'ap@direct.test', isPreferred: true },
  { carrierId: 'c2', recipientType: 'FACTOR', factorName: 'RTS Financial', payeeEmail: 'cash@rts.test', isPreferred: true },
  { carrierId: 'c3', recipientType: 'CARRIER', payeeEmail: null, isPreferred: true },
]

function renderPage() {
  return render(<MemoryRouter><RemitDirectoryPage /></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.isAdmin = true
  api.listCarrierRemitEmails.mockResolvedValue(methods)
  api.getFactorRemitEmails.mockResolvedValue({})
  api.setFactorRemitEmail.mockResolvedValue({ factorKey: 'RTS FINANCIAL', factorName: 'RTS Financial', email: 'new@rts.test' })
  api.setPayeeRemitEmail.mockResolvedValue({ paymentMethodId: 'p', carrierId: 'c3', email: 'ap@x.test' })
})

describe('RemitDirectoryPage', () => {
  it('lists carriers with their own or inherited address and counts the ones missing one', async () => {
    renderPage()
    expect(await screen.findByText('ap@direct.test')).toBeTruthy()
    expect(screen.getByText('cash@rts.test')).toBeTruthy()
    expect(screen.getByText('via RTS Financial')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Carriers · 1 missing/ })).toBeTruthy()
  })

  it('filters to carriers missing a remit e-mail', async () => {
    renderPage()
    await screen.findByText('ap@direct.test')
    fireEvent.click(screen.getByLabelText('Missing remit e-mail only'))
    expect(screen.queryByText('Direct Haul')).toBeNull()
    expect(screen.getByText('No Email Direct')).toBeTruthy()
  })

  it('adds a direct carrier\'s address inline', async () => {
    renderPage()
    await screen.findByText('ap@direct.test')
    fireEvent.click(screen.getByRole('button', { name: 'Add remit e-mail' }))
    const input = screen.getByLabelText('Remit e-mail for No Email Direct')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'nope' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'ap@x.test' } })
    fireEvent.click(save)
    await waitFor(() => expect(api.setPayeeRemitEmail).toHaveBeenCalledWith({ carrierId: 'c3', email: 'ap@x.test' }))
  })

  it('edits a factoring company once, for every carrier it funds', async () => {
    renderPage()
    await screen.findByText('ap@direct.test')
    fireEvent.click(screen.getByRole('tab', { name: /Factoring companies/ }))
    const row = (await screen.findByText('RTS Financial')).closest('tr')!
    expect(within(row).getByText('From carriers')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Remit e-mail for RTS Financial'), { target: { value: 'new@rts.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.setFactorRemitEmail).toHaveBeenCalledWith({ factorName: 'RTS Financial', email: 'new@rts.test' }))
  })

  it('offers no edit links to someone who cannot pay carriers', async () => {
    auth.isAdmin = false
    auth.hasPageAccess = () => false
    renderPage()
    await screen.findByText('ap@direct.test')
    expect(screen.queryByRole('button', { name: /Edit|Add remit e-mail/ })).toBeNull()
    auth.hasPageAccess = () => true
  })
})
