// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { PastDueReminderResult } from '@/lib/apiClient'

const { pastDueReminder } = vi.hoisted(() => ({ pastDueReminder: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  pastDueReminder,
  graphqlErrorText: (err: unknown) => String((err as Error)?.message ?? err),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { PastDueReminderDialog } from './PastDueReminderDialog'

const preview: PastDueReminderResult = {
  preview: true, to: ['ap@acme.com'], cc: ['billing@bcatcorp.com'], subject: 'Past due', body: 'Hi, the invoice below is 12 days past due. Can you please advise when payment will be made?\n\nrow',
  rows: [{ invoiceId: 'i1', invoiceNumber: '14051', pro: '14051', po: null, invoiceDate: '2026-08-05', dueAt: '2026-11-05', totalCents: 22995, balanceCents: 22995, daysPastDue: 12 }],
  recent: [], summary: { customerId: 'c1', customerName: 'Acme', count: 1, totalCents: 22995, companyName: 'BCAT' },
}
const groups = [{ customerId: 'c1', customerName: 'Acme', invoiceIds: ['i1'] }]

describe('PastDueReminderDialog', () => {
  beforeEach(() => pastDueReminder.mockReset())

  it('previews first and sends nothing until Send is pressed', async () => {
    pastDueReminder.mockResolvedValue(preview)
    render(<PastDueReminderDialog groups={groups} onClose={vi.fn()} onSent={vi.fn()} />)
    await waitFor(() => expect((screen.getByLabelText('To for Acme') as HTMLInputElement).value).toBe('ap@acme.com'))
    expect(screen.getByText(/12 days past due/)).toBeTruthy()
    expect(pastDueReminder).toHaveBeenCalledTimes(1)
    expect(pastDueReminder.mock.calls[0][0]).toEqual({ invoiceIds: ['i1'] })
  })

  it('warns when there is no address and blocks Send', async () => {
    pastDueReminder.mockResolvedValue({ ...preview, to: [] })
    render(<PastDueReminderDialog groups={groups} onClose={vi.fn()} onSent={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/No invoice e-mail on file/)).toBeTruthy())
    expect((screen.getByTestId('past-due-send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends the edited recipients on Send, and needs the box ticked after a recent reminder', async () => {
    pastDueReminder.mockResolvedValueOnce({ ...preview, recent: [{ invoiceNumber: '14051', sentAt: '2026-11-16T12:00:00Z' }] })
    render(<PastDueReminderDialog groups={groups} onClose={vi.fn()} onSent={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('past-due-recent')).toBeTruthy())
    const send = screen.getByTestId('past-due-send') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('past-due-recent').querySelector('input') as HTMLInputElement)
    fireEvent.change(screen.getByLabelText('To for Acme'), { target: { value: 'pay@acme.com, ap2@acme.com' } })
    pastDueReminder.mockResolvedValueOnce({ ...preview, preview: false, emailStatus: 'SENT' })
    fireEvent.click(send)
    await waitFor(() => expect(pastDueReminder).toHaveBeenCalledTimes(2))
    expect(pastDueReminder.mock.calls[1][0]).toEqual({ invoiceIds: ['i1'], send: true, to: ['pay@acme.com', 'ap2@acme.com'], cc: ['billing@bcatcorp.com'], confirmRecent: true })
  })
})
