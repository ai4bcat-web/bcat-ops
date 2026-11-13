// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomerRecord } from '@/types/tms'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const api = vi.hoisted(() => ({ previewDeleteCustomer: vi.fn(), deleteCustomer: vi.fn(), mergeCustomer: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)

import { CustomerRemoveDialog } from './CustomerRemoveDialog'

const dup = { id: 'c1', name: 'ROYAL GROUP', active: true } as unknown as CustomerRecord
const keep = { id: 'c2', name: 'Royal Group', active: true } as unknown as CustomerRecord
const blank = (key: string, count: number, blocking = true) => ({ key, label: key, count, blocking })

describe('CustomerRemoveDialog', () => {
  beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()) })

  it('offers delete only when nothing has history, and needs the name typed', async () => {
    api.previewDeleteCustomer.mockResolvedValue({ customer: { id: 'c1', name: 'ROYAL GROUP', active: true }, links: [blank('shipments', 0)], blockingTotal: 0, canHardDelete: true })
    api.deleteCustomer.mockResolvedValue({ deleted: true, id: 'c1' })
    const onRemoved = vi.fn()
    render(<CustomerRemoveDialog queue={[dup]} customers={[dup, keep]} onArchive={vi.fn()} onRemoved={onRemoved} onClose={vi.fn()} />)
    await screen.findByText('Nothing points at this customer.')
    const confirm = screen.getByTestId('customer-remove-confirm') as HTMLButtonElement
    expect(confirm.textContent).toBe('Delete permanently')
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Type the customer name to confirm'), { target: { value: 'royal group' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('c1'))
    expect(api.deleteCustomer).toHaveBeenCalledWith('c1', 'royal group')
  })

  it('with history: no delete option, merge pre-picks the same-name survivor', async () => {
    api.previewDeleteCustomer.mockResolvedValue({ customer: { id: 'c1', name: 'ROYAL GROUP', active: true }, links: [blank('shipments', 3)], blockingTotal: 3, canHardDelete: false })
    api.mergeCustomer.mockResolvedValue({ status: 'DONE', sourceId: 'c1', targetId: 'c2', moved: { shipments: 3 } })
    const onRemoved = vi.fn()
    render(<CustomerRemoveDialog queue={[dup]} customers={[dup, keep]} onArchive={vi.fn()} onRemoved={onRemoved} onClose={vi.fn()} />)
    await screen.findByTestId('customer-remove-links')
    expect(screen.queryByText(/Delete permanently/)).toBeNull()
    expect((screen.getByTestId('customer-merge-target') as HTMLSelectElement).value).toBe('c2')
    fireEvent.change(screen.getByLabelText('Type the customer name to confirm'), { target: { value: 'ROYAL GROUP' } })
    fireEvent.click(screen.getByTestId('customer-remove-confirm'))
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('c1'))
    expect(api.mergeCustomer).toHaveBeenCalledWith('c1', 'c2', 'ROYAL GROUP')
  })

  it('archive needs no typing and goes through the page archive', async () => {
    api.previewDeleteCustomer.mockResolvedValue({ customer: { id: 'c1', name: 'ROYAL GROUP', active: true }, links: [blank('invoices', 1)], blockingTotal: 1, canHardDelete: false })
    const onArchive = vi.fn(async () => ({}))
    render(<CustomerRemoveDialog queue={[dup]} customers={[dup, keep]} onArchive={onArchive} onRemoved={vi.fn()} onClose={vi.fn()} />)
    await screen.findByTestId('customer-remove-links')
    fireEvent.click(screen.getByLabelText(/Archive — hidden/))
    fireEvent.click(screen.getByTestId('customer-remove-confirm'))
    await waitFor(() => expect(onArchive).toHaveBeenCalledWith(dup))
  })
})
