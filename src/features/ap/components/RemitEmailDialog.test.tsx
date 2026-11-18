// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RemitEmailDialog } from './RemitEmailDialog'

const api = vi.hoisted(() => ({ setPayeeRemitEmail: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ ...api, graphqlErrorText: (e: unknown) => String(e) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  api.setPayeeRemitEmail.mockResolvedValue({ paymentMethodId: 'p', carrierId: 'c', email: 'x@y.test' })
})

function renderDialog(props: Partial<Parameters<typeof RemitEmailDialog>[0]> = {}) {
  return render(<RemitEmailDialog payee="RTS Financial" billId="b1" open onOpenChange={() => {}} onDone={() => {}} {...props} />)
}

describe('RemitEmailDialog (the address belongs to the pay to)', () => {
  it('says the address is used for every carrier paid to that name', () => {
    renderDialog({ carriersUsing: 3 })
    expect(screen.getByText(/every carrier paid to RTS Financial/)).toBeTruthy()
    expect(screen.getByText(/3 carriers use this address/)).toBeTruthy()
  })

  it('lets staff pick between the addresses the carriers carry when they disagree', async () => {
    const onDone = vi.fn()
    renderDialog({ copies: ['a@rts.test', 'b@rts.test'], onDone })
    expect(screen.getByText(/carry different addresses/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'b@rts.test' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save e-mail' }))
    await waitFor(() => expect(api.setPayeeRemitEmail).toHaveBeenCalledWith({ billId: 'b1', carrierId: undefined, email: 'b@rts.test' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('shows no picker when the carriers agree', () => {
    renderDialog({ copies: ['a@rts.test'] })
    expect(screen.queryByText(/carry different addresses/)).toBeNull()
  })
})
