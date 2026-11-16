// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const listUnlinkedShipments = vi.fn()
const listCustomers = vi.fn()
vi.mock('@/lib/apiClient', () => ({
  financeAction: vi.fn(), setDeliveredDate: vi.fn(), setShipmentCustomer: vi.fn(),
  listUnlinkedShipments: (...a: unknown[]) => listUnlinkedShipments(...a),
  listCustomers: (...a: unknown[]) => listCustomers(...a),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const updateOpenQuestionRow = vi.fn()
vi.mock('@/lib/openQuestionsClient', () => ({ listOpenQuestionRows: vi.fn(async () => []), updateOpenQuestionRow: (...a: unknown[]) => updateOpenQuestionRow(...a) }))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'ryne@bcatcorp.com' }), useAuth: () => ({ isAdmin: true, isOwner: true }) }))
vi.mock('@/features/shipments/components/RepointCustomerDialog', () => ({ RepointCustomerDialog: () => null }))

import { NeedsReviewList } from './NeedsReview'
import { invalidateUnlinkedShipments } from '@/features/directory/useUnlinkedShipments'
import type { OpenQuestion } from '@/features/openQuestions/openQuestions'

const q = (pro: string, shipmentId: string, party: string): OpenQuestion => ({
  id: `oq-link-customer-${pro}`, question: `${pro}: link "${party}"?`, status: 'OPEN', notes: '', createdAt: '2026-11-16T14:00:00Z', updatedAt: null,
  details: { area: 'LOAD', refs: [{ pro, shipmentId, party }], source: 'Unlinked-customer sweep 2026-11-16' },
})
const saved = (id: string) => ({ id, page: 'accounting-open-question', summary: 's', details: JSON.stringify({ area: 'LOAD', refs: [] }), status: 'DONE', adminNotes: 'x', createdAt: null, updatedAt: null })

describe('Needs review: unlinked-customer questions', () => {
  beforeEach(() => {
    invalidateUnlinkedShipments()
    listUnlinkedShipments.mockReset(); listCustomers.mockReset(); updateOpenQuestionRow.mockReset()
    listCustomers.mockResolvedValue([{ id: 'cus-1', name: 'KING OF FREIGHT 3RD PARTY', aliases: [], active: true }])
  })

  it('shows the one-click link buttons on an unlinked-customer question', async () => {
    listUnlinkedShipments.mockResolvedValue({ rows: [{ id: 'shp-a', number: '14559', customerName: 'KING OF FREIGHT', originCity: null, destinationCity: null, pickupAppt: null, deliveryAppt: null, status: 'DELIVERED', inLoadReview: false, updatedAt: null }], total: 1 })
    render(<MemoryRouter><NeedsReviewList side="AR" rows={[]} error={null} onCleared={() => {}} questions={[q('14559', 'shp-a', 'KING OF FREIGHT')]} /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Link to KING OF FREIGHT 3RD PARTY' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose another…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create customer…' })).toBeTruthy()
    expect(updateOpenQuestionRow).not.toHaveBeenCalled()
  })

  it('resolves a question by itself once its load is no longer unlinked, wherever the link was made', async () => {
    listUnlinkedShipments.mockResolvedValue({ rows: [{ id: 'shp-b', number: '14000', customerName: 'COYNE', originCity: null, destinationCity: null, pickupAppt: null, deliveryAppt: null, status: 'DELIVERED', inLoadReview: false, updatedAt: null }], total: 1 })
    updateOpenQuestionRow.mockResolvedValue(saved('oq-link-customer-14559'))
    const onQuestionSaved = vi.fn()
    render(<MemoryRouter><NeedsReviewList side="AR" rows={[]} error={null} onCleared={() => {}} onQuestionSaved={onQuestionSaved}
      questions={[q('14559', 'shp-a', 'KING OF FREIGHT'), q('14000', 'shp-b', 'COYNE')]} /></MemoryRouter>)
    await waitFor(() => expect(updateOpenQuestionRow).toHaveBeenCalledTimes(1))
    expect(updateOpenQuestionRow.mock.calls[0][0]).toBe('oq-link-customer-14559')
    expect((updateOpenQuestionRow.mock.calls[0][1] as { status: string }).status).toBe('DONE')
    expect(onQuestionSaved).toHaveBeenCalled()
  })

  it('does not resolve anything when the unlinked list could not be read in full', async () => {
    listUnlinkedShipments.mockResolvedValue({ rows: [], total: 5 })
    render(<MemoryRouter><NeedsReviewList side="AR" rows={[]} error={null} onCleared={() => {}} questions={[q('14559', 'shp-a', 'KING OF FREIGHT')]} /></MemoryRouter>)
    await screen.findByRole('button', { name: 'Choose another…' })
    await new Promise((r) => setTimeout(r, 50))
    expect(updateOpenQuestionRow).not.toHaveBeenCalled()
  })
})
