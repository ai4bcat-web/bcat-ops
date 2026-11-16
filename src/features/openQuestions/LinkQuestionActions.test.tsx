// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const setShipmentCustomer = vi.fn()
vi.mock('@/lib/apiClient', () => ({ setShipmentCustomer: (...a: unknown[]) => setShipmentCustomer(...a), listUnlinkedShipments: vi.fn() }))
const updateOpenQuestionRow = vi.fn()
vi.mock('@/lib/openQuestionsClient', () => ({ updateOpenQuestionRow: (...a: unknown[]) => updateOpenQuestionRow(...a), listOpenQuestionRows: vi.fn(async () => []) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/shipments/components/RepointCustomerDialog', () => ({
  RepointCustomerDialog: (p: { startCreating?: boolean; onRepointed?: (id: string) => void }) => (
    <div data-testid="link-dialog" data-create={String(Boolean(p.startCreating))}><button type="button" onClick={() => p.onRepointed?.('cus-2')}>pick</button></div>
  ),
}))

import { LinkQuestionActions } from './LinkQuestionActions'
import type { OpenQuestion } from './openQuestions'
import type { CustomerRecord } from '@/types/tms'

const question = (over: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: 'oq-link-customer-14559', question: '14559: link "KING OF FREIGHT" to "KING OF FREIGHT 3RD PARTY"?', status: 'OPEN', notes: '', createdAt: null, updatedAt: null,
  details: { area: 'LOAD', refs: [{ pro: '14559', shipmentId: 'shp-74d0', party: 'KING OF FREIGHT' }], source: 'Unlinked-customer sweep 2026-11-16' }, ...over,
})
const customers = [
  { id: 'cus-1', name: 'KING OF FREIGHT 3RD PARTY', aliases: [], active: true },
  { id: 'cus-2', name: 'Something Else LLC', aliases: [], active: true },
] as CustomerRecord[]
const saved = { id: 'oq-link-customer-14559', page: 'accounting-open-question', summary: 'x', details: JSON.stringify({ area: 'LOAD', refs: [] }), status: 'DONE', adminNotes: 'Linked', createdAt: null, updatedAt: null }

describe('LinkQuestionActions', () => {
  beforeEach(() => { setShipmentCustomer.mockReset(); updateOpenQuestionRow.mockReset() })

  it('links to the suggested customer in one click and resolves the question with the answer', async () => {
    setShipmentCustomer.mockResolvedValue({})
    updateOpenQuestionRow.mockResolvedValue(saved)
    const onResolved = vi.fn()
    render(<LinkQuestionActions question={question()} customers={customers} who="Ryne" onResolved={onResolved} />)
    fireEvent.click(screen.getByRole('button', { name: 'Link to KING OF FREIGHT 3RD PARTY' }))
    await waitFor(() => expect(onResolved).toHaveBeenCalled())
    expect(setShipmentCustomer).toHaveBeenCalledWith({ shipmentId: 'shp-74d0', customerId: 'cus-1' })
    const patch = updateOpenQuestionRow.mock.calls[0][1] as { adminNotes: string; status: string }
    expect(patch.status).toBe('DONE')
    expect(patch.adminNotes).toContain('Linked 14559 to KING OF FREIGHT 3RD PARTY.')
  })

  it('leaves the question open when the link fails', async () => {
    setShipmentCustomer.mockRejectedValue(new Error('already linked'))
    const onResolved = vi.fn()
    render(<LinkQuestionActions question={question()} customers={customers} who="Ryne" onResolved={onResolved} />)
    fireEvent.click(screen.getByRole('button', { name: 'Link to KING OF FREIGHT 3RD PARTY' }))
    await waitFor(() => expect(setShipmentCustomer).toHaveBeenCalled())
    expect(updateOpenQuestionRow).not.toHaveBeenCalled()
    expect(onResolved).not.toHaveBeenCalled()
  })

  it('opens the picker for "Choose another…" and the create form for "Create customer…"', async () => {
    updateOpenQuestionRow.mockResolvedValue(saved)
    const onResolved = vi.fn()
    render(<LinkQuestionActions question={question()} customers={customers} who="Ryne" onResolved={onResolved} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose another…' }))
    expect(screen.getByTestId('link-dialog').getAttribute('data-create')).toBe('false')
    fireEvent.click(screen.getByText('pick'))
    await waitFor(() => expect(onResolved).toHaveBeenCalled())
    expect((updateOpenQuestionRow.mock.calls[0][1] as { adminNotes: string }).adminNotes).toContain('Linked 14559 to Something Else LLC.')
    fireEvent.click(screen.getByRole('button', { name: 'Create customer…' }))
    expect(screen.getByTestId('link-dialog').getAttribute('data-create')).toBe('true')
  })

  it('offers no suggestion button when nothing is close, and nothing at all on a resolved question', () => {
    const { rerender } = render(<LinkQuestionActions question={question({ details: { area: 'LOAD', refs: [{ pro: '1', shipmentId: 's', party: 'ZZZZ QQQQ' }] } })} customers={customers} who="Ryne" onResolved={() => {}} />)
    expect(screen.queryByText(/^Link to /)).toBeNull()
    expect(screen.getByRole('button', { name: 'Choose another…' })).toBeTruthy()
    rerender(<LinkQuestionActions question={question({ status: 'RESOLVED' })} customers={customers} who="Ryne" onResolved={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
