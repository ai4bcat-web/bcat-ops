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
  setPayToProfile: vi.fn(),
  setCarrierPayTo: vi.fn(),
}))
const auth = vi.hoisted(() => ({ isAdmin: true, hasPageAccess: (_: string) => true }))

vi.mock('@/lib/apiClient', () => ({ ...api, graphqlErrorText: (e: unknown) => String(e) }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))
const carrierState = vi.hoisted(() => ({
  base: [
    { id: 'c1', name: 'Direct Haul', mcNumber: '111', status: 'ACTIVE' },
    { id: 'c2', name: 'Factored Freight', mcNumber: '222', status: 'ACTIVE' },
    { id: 'c3', name: 'No Email Direct', mcNumber: '333', status: 'ACTIVE' },
  ],
  extra: [] as Array<{ id: string; name: string; mcNumber: string; status: string }>,
}))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ loading: false, error: null, carriers: [...carrierState.base, ...carrierState.extra] }),
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
  carrierState.extra = []
  auth.isAdmin = true
  api.listCarrierRemitEmails.mockResolvedValue(methods)
  api.getFactorRemitEmails.mockResolvedValue({})
  api.setFactorRemitEmail.mockResolvedValue({ factorKey: 'RTS FINANCIAL', factorName: 'RTS Financial', email: 'new@rts.test' })
  api.setPayeeRemitEmail.mockResolvedValue({ paymentMethodId: 'p', carrierId: 'c3', email: 'ap@x.test' })
  api.setPayToProfile.mockResolvedValue({ key: 'RTS FINANCIAL', name: 'RTS Financial', profile: null })
  api.setCarrierPayTo.mockResolvedValue({ carrierId: 'c2', paymentMethodId: 'p', payTo: 'Direct Haul', via: 'DIRECT' })
})

describe('RemitDirectoryPage', () => {
  it('lists carriers with the address of their pay to and counts the payees missing one', async () => {
    renderPage()
    expect(await screen.findByText('ap@direct.test')).toBeTruthy()
    expect(screen.getByText('cash@rts.test')).toBeTruthy()
    expect(screen.getAllByText('RTS Financial').length).toBeGreaterThan(0)
    expect(screen.queryByText(/via RTS/)).toBeNull()
    // Missing counts are payees, not carriers: one payee (No Email Direct) has no address.
    expect(screen.getByRole('tab', { name: /Pay to · 1 to fix/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Carriers' })).toBeTruthy()
  })

  it('filters to carriers missing a remit e-mail', async () => {
    renderPage()
    await screen.findByText('ap@direct.test')
    fireEvent.click(screen.getByLabelText('Missing remit e-mail only'))
    expect(screen.queryByText('Direct Haul')).toBeNull()
    expect(screen.getAllByText('No Email Direct').length).toBeGreaterThan(0)
  })

  it('reads a carrier\'s address read-only and sends the edit to the pay to', async () => {
    renderPage()
    await screen.findByText('ap@direct.test')
    expect(screen.queryByLabelText('Remit e-mail for No Email Direct')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add at No Email Direct' }))
    // Now on the Pay to table, narrowed to that payee.
    const row = (await screen.findByText('No Email Direct')).closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: 'Add remit e-mail' }))
    const input = screen.getByLabelText('Remit e-mail for No Email Direct')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'nope' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'ap@x.test' } })
    fireEvent.click(save)
    await waitFor(() => expect(api.setFactorRemitEmail).toHaveBeenCalledWith({ payeeName: 'No Email Direct', email: 'ap@x.test' }))
  })

  it('edits a factoring company once, for every carrier paid to it', async () => {
    renderPage()
    await screen.findByText('ap@direct.test')
    fireEvent.click(screen.getByRole('tab', { name: /Pay to/ }))
    const row = (await screen.findByText('RTS Financial')).closest('tr')!
    expect(within(row).getByText('From carriers')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Remit e-mail for RTS Financial'), { target: { value: 'new@rts.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.setFactorRemitEmail).toHaveBeenCalledWith({ payeeName: 'RTS Financial', email: 'new@rts.test' }))
  })

  it('lists factoring companies and direct payees in one Pay to table, with the carriers paid to each', async () => {
    carrierState.extra = [{ id: 'c4', name: 'Second Factored', mcNumber: '444', status: 'ACTIVE' }]
    api.listCarrierRemitEmails.mockResolvedValue([
      ...methods,
      { carrierId: 'c4', recipientType: 'FACTOR', factorName: 'RTS Financial', payeeEmail: 'cash@rts.test', isPreferred: true },
    ])
    renderPage()
    await screen.findByText('ap@direct.test')
    fireEvent.click(screen.getByRole('tab', { name: /Pay to/ }))
    const rts = (await screen.findByText('RTS Financial')).closest('tr')!
    expect(within(rts).getByText('Factoring company')).toBeTruthy()
    expect(within(rts).getByText('2')).toBeTruthy() // two carriers share the one pay to
    const direct = screen.getByText('Direct Haul').closest('tr')!
    expect(within(direct).getByText('Direct')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'DIRECT' } })
    expect(screen.queryByText('RTS Financial')).toBeNull()
    expect(screen.getByText('Direct Haul')).toBeTruthy()
  })

  it('shows the address filed for a direct pay to on its carrier, over the carrier\'s own copy', async () => {
    api.getFactorRemitEmails.mockResolvedValue({ 'DIRECT HAUL': { name: 'Direct Haul', email: 'filed@direct.test' } })
    renderPage()
    expect(await screen.findByText('filed@direct.test')).toBeTruthy()
    expect(screen.queryByText('ap@direct.test')).toBeNull()
  })

  it('shows a conflict when carriers paid to one name carry different addresses', async () => {
    carrierState.extra = [{ id: 'c5', name: 'Direct Haul', mcNumber: '555', status: 'ACTIVE' }]
    api.listCarrierRemitEmails.mockResolvedValue([
      { carrierId: 'c1', recipientType: 'CARRIER', payeeEmail: 'a@direct.test', isPreferred: true },
      { carrierId: 'c5', recipientType: 'CARRIER', payeeEmail: 'b@direct.test', isPreferred: true },
    ])
    renderPage()
    await screen.findAllByText('Direct Haul')
    fireEvent.click(screen.getByRole('tab', { name: /Pay to/ }))
    expect(await screen.findAllByText('Carriers disagree')).toBeTruthy()
  })

  it('sorts the Pay to table from its headers and filters by status', async () => {
    carrierState.extra = [{ id: 'c9', name: 'Zed Carrier', mcNumber: '999', status: 'ACTIVE' }]
    api.listCarrierRemitEmails.mockResolvedValue([
      ...methods,
      { carrierId: 'c9', recipientType: 'FACTOR', factorName: 'Zed Funding', payeeEmail: null, isPreferred: true },
    ])
    renderPage()
    await screen.findByText('ap@direct.test')
    fireEvent.click(screen.getByRole('tab', { name: /Pay to/ }))
    await screen.findByText('Zed Funding')
    const order = () => screen.getAllByRole('row').map((r) => r.textContent ?? '').filter((t) => /Zed Funding|RTS Financial/.test(t))
    expect(order()[0]).toMatch(/RTS Financial/) // default: same carrier count, A to Z
    fireEvent.click(screen.getByTitle('Sort by Pay to'))
    fireEvent.click(screen.getByTitle('Sort by Pay to'))
    await waitFor(() => expect(order()[0]).toMatch(/Zed Funding/))
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'NONE' } })
    expect(screen.queryByText('RTS Financial')).toBeNull()
    expect(screen.getByText('Zed Funding')).toBeTruthy()
  })

  it('offers no edit links to someone who cannot pay carriers', async () => {
    auth.isAdmin = false
    auth.hasPageAccess = () => false
    renderPage()
    await screen.findByText('ap@direct.test')
    expect(screen.queryByRole('button', { name: /Edit|Add remit e-mail|Add at/ })).toBeNull()
    auth.hasPageAccess = () => true
  })

  describe('pay-to profile', () => {
    async function openRts() {
      api.listCarrierRemitEmails.mockResolvedValue([
        ...methods.map((m) => (m.carrierId === 'c2' ? { ...m, id: 'm2', bankDetailsOnFileAt: '2026-11-01T00:00:00Z', accountLast4: '4321' } : m)),
      ])
      api.getFactorRemitEmails.mockResolvedValue({
        'RTS FINANCIAL': { name: 'RTS Financial', email: 'cash@rts.test', aliases: ['RTS Fin'], remitAddress: '9 Elm St, Tulsa OK', paymentMethod: 'ACH' },
      })
      renderPage()
      await screen.findByText('cash@rts.test')
      fireEvent.click(screen.getByRole('tab', { name: /Pay to/ }))
      fireEvent.click(await screen.findByRole('button', { name: 'RTS Financial' }))
      return screen.findByRole('dialog')
    }

    it('opens the profile with its fields, linked carriers and a bank status that shows only the last four', async () => {
      const dialog = await openRts()
      expect((within(dialog).getByLabelText('Remit address') as HTMLInputElement).value).toBe('9 Elm St, Tulsa OK')
      expect((within(dialog).getByLabelText('Payment method') as HTMLSelectElement).value).toBe('ACH')
      expect(within(dialog).getByText('RTS Fin')).toBeTruthy()
      expect(within(dialog).getByText('Complete')).toBeTruthy()
      expect(within(dialog).getByText(/account ending 4321/)).toBeTruthy()
      expect(within(dialog).getByText('Linked carriers (1)')).toBeTruthy()
      expect(within(dialog).getByText('Factored Freight')).toBeTruthy()
    })

    it('saves the edited fields and an added spelling in one call', async () => {
      const dialog = await openRts()
      fireEvent.change(within(dialog).getByLabelText('Remit address'), { target: { value: '1 New Rd, Dallas TX' } })
      fireEvent.change(within(dialog).getByLabelText('Add another spelling'), { target: { value: 'RTS Financial Services' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add spelling' }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }))
      await waitFor(() => expect(api.setPayToProfile).toHaveBeenCalledTimes(1))
      expect(api.setPayToProfile).toHaveBeenCalledWith({
        payeeName: 'RTS Financial', name: 'RTS Financial', email: 'cash@rts.test',
        aliases: ['RTS Fin', 'RTS Financial Services'], remitAddress: '1 New Rd, Dallas TX', paymentMethod: 'ACH',
      })
    })

    it('refuses a bad e-mail in the form, and moves a carrier without sending any bank field', async () => {
      const dialog = await openRts()
      fireEvent.change(within(dialog).getByLabelText('Remit e-mail'), { target: { value: 'not an address' } })
      expect((within(dialog).getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled).toBe(true)
      fireEvent.change(within(dialog).getByLabelText('Remit e-mail'), { target: { value: 'cash@rts.test' } })
      fireEvent.change(within(dialog).getByLabelText('Move Factored Freight to another pay to'), { target: { value: 'Direct Haul' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
      await waitFor(() => expect(api.setCarrierPayTo).toHaveBeenCalledWith({ carrierId: 'c2', payToName: 'Direct Haul' }))
    })

    it('is read-only for someone who cannot pay carriers', async () => {
      auth.isAdmin = false
      auth.hasPageAccess = () => false
      const dialog = await openRts()
      expect(within(dialog).queryByRole('button', { name: 'Save profile' })).toBeNull()
      expect((within(dialog).getByLabelText('Remit address') as HTMLInputElement).disabled).toBe(true)
      auth.hasPageAccess = () => true
    })
  })
})
