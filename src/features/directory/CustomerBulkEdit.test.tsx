// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CustomerRecord, Division, UserProfileRecord } from '@/types/tms'
import { CustomerBulkEdit } from './CustomerBulkEdit'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const customers = [{ id: 'a', name: 'Acme' }, { id: 'b', name: 'Bolt' }] as unknown as CustomerRecord[]
const divisions = [{ key: 'BROKERAGE', name: 'Brokerage' }] as unknown as Division[]
const staff = [{ id: 'u1', name: 'Ryne' }] as unknown as UserProfileRecord[]

describe('CustomerBulkEdit', () => {
  it('applies the chosen fields to every selected customer, one by one', async () => {
    const save = vi.fn(async () => ({}))
    const onDone = vi.fn()
    render(<CustomerBulkEdit customers={customers} divisions={divisions} staff={staff} save={save} onDone={onDone} onClear={vi.fn()} />)
    expect((screen.getByTestId('customer-bulk-apply') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Bulk billing method'), { target: { value: 'FACTOR' } })
    fireEvent.change(screen.getByLabelText('Bulk payment terms (days)'), { target: { value: '30' } })
    fireEvent.click(screen.getByTestId('customer-bulk-apply'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledWith(customers[0], { billingMethod: 'FACTOR', paymentTermsDays: 30 })
  })
  it('renders nothing with no selection', () => {
    const { container } = render(<CustomerBulkEdit customers={[]} divisions={divisions} staff={staff} save={vi.fn()} onDone={vi.fn()} onClear={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })
})
