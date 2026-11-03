// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'
import * as api from '@/lib/apiClient'
import * as auth from '@/hooks/useAuth'
import type { OwnershipDivisionRecord } from '@/types/tms'
import { IntakeReviewPage } from './IntakeReviewPage'
import { intakeRow } from './testFixtures'

const BRK = {
  id: 'BRK', code: 'BRK', name: 'Brokerage', brand: null, parentId: null, color: null, sortOrder: 0, active: true,
  owners: null, flows: null, createdBy: 's', updatedBy: 's', version: 1, createdAt: '', updatedAt: '', intakeEmail: 'brk@example.invalid',
} as OwnershipDivisionRecord

vi.mock('@/features/tms/useOwnershipDivisions', () => ({
  useOwnershipDivisions: () => ({ divisions: [BRK], loading: false, error: null, refresh: () => undefined }),
}))
vi.mock('@/components/RepPicker', () => ({ RepPicker: ({ value }: { value: string | null }) => <span>rep:{value}</span> }))
vi.mock('@/lib/apiClient', () => ({
  getIntakeLoad: vi.fn(), saveIntakeDraft: vi.fn(), moveIntakeToActive: vi.fn(), dismissIntake: vi.fn(),
  listCustomers: vi.fn(), getTmsSettings: vi.fn(), getWorkflowRun: vi.fn(), linkWorkflowRun: vi.fn(),
  dismissWorkflowRun: vi.fn(), getIntakePdfUrl: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const CUSTOMER = { id: 'c1', name: 'Acme Foods', active: true, billToParties: [{ id: 'b1', name: 'Acme Billing' }] }

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{loc.pathname}</div>
}

function renderPage(canReview = true) {
  vi.spyOn(auth, 'useAuth').mockReturnValue({
    isOwner: false, isAdmin: false, hasPageAccess: (k: string) => (k === 'intakeReview' ? canReview : true),
  } as unknown as auth.AuthContextValue)
  return render(
    <MemoryRouter initialEntries={['/tms/shipments/intake/il%3Arun-1']}>
      <Routes>
        <Route path="/tms/shipments/intake/:intakeId" element={<IntakeReviewPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

const moveButton = () => screen.getByRole('button', { name: 'Move to active' })

describe('IntakeReviewPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getIntakeLoad).mockResolvedValue(intakeRow())
    vi.mocked(api.listCustomers).mockResolvedValue([CUSTOMER] as never)
    vi.mocked(api.getTmsSettings).mockResolvedValue(null)
    vi.mocked(api.getWorkflowRun).mockResolvedValue(null)
  })

  it('labels each field by what automation knew: auto-filled, check this, missing', async () => {
    renderPage()
    await screen.findByDisplayValue('PO-100')
    const status = (label: string) => (screen.getByLabelText(label).closest('.tms-intake-row') as HTMLElement)
    expect(within(status('Reference / PO')).getByText('Auto-filled')).toBeInTheDocument()
    expect(within(status('Weight (lb)')).getByText('Check this')).toBeInTheDocument()
    expect(within(status('Bill to')).getByText('Missing')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Commodity'), { target: { value: 'Paper' } })
    expect(within(status('Commodity')).getByText('Confirmed')).toBeInTheDocument()
  })

  it('keeps Move disabled with the exact list until the missing field is filled and the low-confidence one confirmed', async () => {
    renderPage()
    await screen.findByDisplayValue('PO-100')
    expect(moveButton()).toBeDisabled()
    expect(screen.getByText(/Needs: .*[Bb]ill/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Bill to'), { target: { value: 'b1' } })
    expect(moveButton()).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Confirm Weight (lb)'))
    expect(moveButton()).toBeEnabled()
  })

  it('saves the edits, moves once, and lands on the new shipment', async () => {
    const saved = intakeRow({ version: 2 })
    vi.mocked(api.saveIntakeDraft).mockResolvedValue(saved)
    vi.mocked(api.moveIntakeToActive).mockResolvedValue({ intake: saved, shipmentId: 'shp-9', shipmentNumber: 'PRO-9' })
    renderPage()
    await screen.findByDisplayValue('PO-100')
    fireEvent.change(screen.getByLabelText('Bill to'), { target: { value: 'b1' } })
    fireEvent.click(screen.getByLabelText('Confirm Weight (lb)'))
    fireEvent.click(moveButton())
    await waitFor(() => expect(api.moveIntakeToActive).toHaveBeenCalledTimes(1))
    expect(api.saveIntakeDraft).toHaveBeenCalledWith(expect.objectContaining({
      intakeId: 'il:run-1',
      expectedVersion: 1,
      fields: expect.objectContaining({ billToId: 'b1' }),
      confirm: { add: ['weightLb'], remove: [] },
    }))
    expect(api.moveIntakeToActive).toHaveBeenCalledWith({ intakeId: 'il:run-1', expectedVersion: 2 })
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tms/shipments/shp-9'))
  })

  it('shows a non-reviewer the fields disabled and no Move, Save or Dismiss', async () => {
    renderPage(false)
    const reference = await screen.findByDisplayValue('PO-100')
    expect(reference).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Move to active' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.getByText(/look but not change/i)).toBeInTheDocument()
  })

  it('needs a reason to dismiss', async () => {
    vi.mocked(api.dismissIntake).mockResolvedValue(intakeRow({ status: 'DISMISSED', version: 2 }))
    renderPage()
    await screen.findByDisplayValue('PO-100')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Dismiss' })
    expect(confirm).toBeDisabled()
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'duplicate tender' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(api.dismissIntake).toHaveBeenCalledWith({ intakeId: 'il:run-1', expectedVersion: 1, reason: 'duplicate tender' }))
  })

  it('reloads the row after a version conflict', async () => {
    vi.mocked(api.saveIntakeDraft).mockRejectedValue(new Error('This intake load changed while you were editing — reload it'))
    renderPage()
    await screen.findByDisplayValue('PO-100')
    fireEvent.change(screen.getByLabelText('Commodity'), { target: { value: 'Paper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.getIntakeLoad).toHaveBeenCalledTimes(2))
  })

  it('shows the source e-mail with subject, sender, body and the run link', async () => {
    renderPage()
    const card = (await screen.findByText('Source e-mail')).closest('section') as HTMLElement
    expect(within(card).getByText('Tender PO-100 Dallas to Atlanta')).toBeInTheDocument()
    expect(within(card).getByText(/ship@acme.example/)).toBeInTheDocument()
    expect(within(card).getByText('Please cover PO-100.')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Open in Workflows' })).toHaveAttribute('href', '/tms/workflows/runs/run-1')
  })
})
