// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { OPEN_QUESTION_PAGE } from './openQuestions'

const rows = [
  {
    id: 'oq-ap-14619', page: OPEN_QUESTION_PAGE, summary: 'Was the $1,000 to GIGI LINE paid?', status: 'NEW', adminNotes: null,
    details: JSON.stringify({ area: 'AP', refs: [{ pro: '14619', shipmentId: 'shp-1', billId: 'cb-1', party: 'GIGI LINE INC', amount: '$1,000.00' }], aljex: 'Open $1,000.00', bcat: 'Paid' }),
  },
  {
    id: 'oq-docs-20008', page: OPEN_QUESTION_PAGE, summary: 'Which rate con to keep?', status: 'DONE', adminNotes: '2026-11-15 · Ryne: keep the first',
    details: JSON.stringify({ area: 'DOCS', refs: [{ pro: '20008' }] }),
  },
]
const update = vi.fn()

vi.mock('@/lib/openQuestionsClient', () => ({
  listOpenQuestionRows: () => Promise.resolve(rows),
  updateOpenQuestionRow: (id: string, patch: Record<string, unknown>) => {
    update(id, patch)
    return Promise.resolve({ ...rows.find((r) => r.id === id)!, ...patch })
  },
}))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'ryne@bcatcorp.com', userId: 'u', groups: [] }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { OpenQuestionsPage } from './OpenQuestionsPage'

describe('OpenQuestionsPage', () => {
  beforeEach(() => update.mockClear())

  it('lists the open questions with their PRO links and what each system says', async () => {
    render(<MemoryRouter><OpenQuestionsPage /></MemoryRouter>)
    expect(await screen.findByText('Was the $1,000 to GIGI LINE paid?')).toBeTruthy()
    expect(screen.queryByText('Which rate con to keep?')).toBeNull()
    expect(screen.getByRole('link', { name: '14619' }).getAttribute('href')).toBe('/tms/shipments/shp-1/edit')
    expect(screen.getByRole('link', { name: 'Bill' }).getAttribute('href')).toBe('/tms/invoicing/payable/bills/cb-1')
    expect(screen.getByText('Open $1,000.00')).toBeTruthy()
  })

  it('saves an answer stamped with who wrote it and resolves', async () => {
    render(<MemoryRouter><OpenQuestionsPage /></MemoryRouter>)
    fireEvent.change(await screen.findByLabelText('Your answer'), { target: { value: 'Not paid yet' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and resolve' }))
    await waitFor(() => expect(update).toHaveBeenCalled())
    const [id, patch] = update.mock.calls[0]!
    expect(id).toBe('oq-ap-14619')
    expect(patch.status).toBe('DONE')
    expect(patch.adminNotes).toMatch(/^\d{4}-\d{2}-\d{2} · Ryne: Not paid yet$/)
  })
})
