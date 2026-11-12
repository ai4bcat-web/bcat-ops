// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'
import * as api from '@/lib/apiClient'
import * as auth from '@/hooks/useAuth'
import type { OwnershipDivisionRecord } from '@/types/tms'
import { IntakeReviewPage } from './IntakeReviewPage'
import { toast } from 'sonner'
import { completeIntakeRow, intakeFields, intakeRow } from './testFixtures'
import { resetBuiltMatchCache } from './useBuiltMatches'

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
  dismissWorkflowRun: vi.fn(), listShipmentsBySearchKeys: vi.fn(), getIntakePdfUrl: vi.fn(), listIntakeLoads: vi.fn().mockResolvedValue([]), deleteIntake: vi.fn(), markIntakeNotDuplicate: vi.fn(),
}))
vi.mock('@/hooks/useOwnFleetRoster', () => ({
  useOwnFleetRoster: () => [{ id: 'drv1', name: 'Pat Driver', email: '', truckId: 't1', truckNumber: '12', trailerId: null, trailerNumber: '', workPhone: '', phone: '' }],
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

const moveButton = () => screen.getByRole('button', { name: 'Create shipment' })

describe('IntakeReviewPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetBuiltMatchCache()
    vi.mocked(api.getIntakeLoad).mockResolvedValue(intakeRow())
    vi.mocked(api.listCustomers).mockResolvedValue([CUSTOMER] as never)
    vi.mocked(api.getTmsSettings).mockResolvedValue(null)
    vi.mocked(api.getWorkflowRun).mockResolvedValue(null)
    vi.mocked(api.listIntakeLoads).mockResolvedValue([])
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

  it('a customer with no separate bill-to party is billed itself: Bill to is not required, not Missing and not selectable', async () => {
    vi.mocked(api.listCustomers).mockResolvedValue([{ ...CUSTOMER, billToParties: [] }] as never)
    renderPage()
    await screen.findByDisplayValue('PO-100')
    const row = screen.getByLabelText('Bill to').closest('.tms-intake-row') as HTMLElement
    expect(within(row).queryByText('Missing')).toBeNull()
    expect(row.querySelector('.tms-fg-star')).toBeNull()
    expect(screen.getByLabelText('Bill to')).toBeDisabled()
    expect(screen.queryByText(/Needs: .*Bill-to/)).toBeNull()
  })

  it('keeps Create shipment disabled with the exact list until the missing field is filled and the low-confidence one confirmed', async () => {
    renderPage()
    await screen.findByDisplayValue('PO-100')
    expect(moveButton()).toBeDisabled()
    expect(screen.getByText(/Needs: .*[Bb]ill/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Bill to'), { target: { value: 'b1' } })
    expect(moveButton()).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Confirm Weight (lb)'))
    await waitFor(() => expect(moveButton()).toBeEnabled())
  })

  it('has no Save, Mark reviewed or review line: Create shipment saves the edits itself, moves once, and lands on the new shipment', async () => {
    const saved = completeIntakeRow({ version: 2 })
    vi.mocked(api.saveIntakeDraft).mockResolvedValue(saved)
    vi.mocked(api.moveIntakeToActive).mockResolvedValue({ intake: saved, shipmentId: 'shp-9', shipmentNumber: 'PRO-9' })
    renderPage()
    await screen.findByDisplayValue('PO-100')
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Mark reviewed/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Bill to'), { target: { value: 'b1' } })
    fireEvent.click(screen.getByLabelText('Confirm Weight (lb)'))
    await waitFor(() => expect(moveButton()).toBeEnabled())
    fireEvent.click(moveButton())
    await waitFor(() => expect(api.moveIntakeToActive).toHaveBeenCalledTimes(1))
    expect(api.saveIntakeDraft).toHaveBeenCalledTimes(1)
    expect(api.saveIntakeDraft).toHaveBeenCalledWith(expect.objectContaining({
      intakeId: 'il:run-1',
      expectedVersion: 1,
      fields: expect.objectContaining({ billToId: 'b1' }),
      confirm: { add: ['weightLb'], remove: [] },
    }))
    expect(api.moveIntakeToActive).toHaveBeenCalledWith({ intakeId: 'il:run-1', expectedVersion: 2 })
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tms/shipments/shp-9'))
  })

  describe('when the reference is already on a shipment with a PRO', () => {
    async function readyToCreate() {
      const saved = completeIntakeRow({ version: 2 })
      vi.mocked(api.saveIntakeDraft).mockResolvedValue(saved)
      vi.mocked(api.moveIntakeToActive).mockResolvedValue({ intake: saved, shipmentId: 'shp-9', shipmentNumber: 'PRO-9' })
      vi.mocked(api.listShipmentsBySearchKeys).mockResolvedValue([
        { id: 'shp-43', number: '20043', customerId: 'c1', customerName: 'Acme Foods', searchKey: '20043 acme foods dallas po-100', voidedAt: null, deletedAt: null },
      ])
      renderPage()
      await screen.findByDisplayValue('PO-100')
      fireEvent.change(screen.getByLabelText('Bill to'), { target: { value: 'b1' } })
      fireEvent.click(screen.getByLabelText('Confirm Weight (lb)'))
      await waitFor(() => expect(moveButton()).toBeEnabled())
      await screen.findByTestId('intake-built-notice')
    }
    it('shows the notice, and Create shipment asks first, naming the PRO; Cancel creates nothing', async () => {
      await readyToCreate()
      expect(screen.getByTestId('intake-built-notice')).toHaveTextContent('PRO 20043')
      fireEvent.click(moveButton())
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent('PRO 20043')
      expect(dialog).toHaveTextContent('twice')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(api.moveIntakeToActive).not.toHaveBeenCalled()
    })

    it('"Create anyway" then creates the shipment', async () => {
      await readyToCreate()
      fireEvent.click(moveButton())
      fireEvent.click(await screen.findByTestId('intake-create-anyway'))
      await waitFor(() => expect(api.moveIntakeToActive).toHaveBeenCalledTimes(1))
    })
  })

  it('shows a non-reviewer the fields disabled and no Create shipment or Dismiss', async () => {
    renderPage(false)
    const reference = await screen.findByDisplayValue('PO-100')
    expect(reference).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Create shipment' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.getByText(/look but not change/i)).toBeInTheDocument()
  })

  it('a fully filled and confirmed load can be created without anyone reviewing it first', async () => {
    vi.mocked(api.getIntakeLoad).mockResolvedValue(completeIntakeRow())
    renderPage()
    await screen.findByDisplayValue('PO-100')
    expect(moveButton()).toBeEnabled()
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
    vi.mocked(api.getIntakeLoad).mockResolvedValue(completeIntakeRow())
    vi.mocked(api.saveIntakeDraft).mockRejectedValue(new Error('This intake load changed while you were editing — reload it'))
    renderPage()
    await screen.findByDisplayValue('PO-100')
    fireEvent.change(screen.getByLabelText('Commodity'), { target: { value: 'Paper' } })
    fireEvent.click(moveButton())
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

  it('always shows a pickup and a delivery with their numbers, date and time, marked required, and blocks Create until they are filled', async () => {
    const bare = intakeRow({ fields: intakeFields({ billToId: 'b1', pickupNumber: null, deliveryNumber: null, stops: [] }), confirmed: ['weightLb'], missingFields: [] })
    vi.mocked(api.getIntakeLoad).mockResolvedValue(bare)
    renderPage()
    await screen.findByDisplayValue('PO-100')
    for (const label of ['Pickup 1 street', 'Pickup 1 city', 'Pickup 1 state', 'Pickup 1 zip', 'Pickup 1 date', 'Pickup 1 appointment time', 'Pickup #',
      'Delivery 1 street', 'Delivery 1 zip', 'Delivery 1 date', 'Delivery 1 appointment time', 'Delivery #']) {
      const row = screen.getByLabelText(label).closest('.tms-intake-row') as HTMLElement
      expect(within(row).getByText('Missing')).toBeInTheDocument()
      expect(row.querySelector('.tms-fg-star')).not.toBeNull()
    }
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(moveButton()).toBeDisabled()
    expect(screen.getByText(/Needs: .*Pickup address/)).toBeInTheDocument()
    const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
    fill('Pickup #', 'PU-1'); fill('Delivery #', 'DL-1')
    for (const [kind, street, city, state, zip, date, time] of [['Pickup', '1 Dock Rd', 'Dallas', 'TX', '75201', '2026-11-10', '08:00'], ['Delivery', '9 Peach St', 'Atlanta', 'GA', '30301', '2026-11-12', '14:00']] as const) {
      fill(`${kind} 1 street`, street); fill(`${kind} 1 city`, city); fill(`${kind} 1 state`, state); fill(`${kind} 1 date`, date)
      expect(moveButton()).toBeDisabled()
      fill(`${kind} 1 zip`, zip)
      expect(moveButton()).toBeDisabled()
      fill(`${kind} 1 appointment time`, time)
    }
    await waitFor(() => expect(moveButton()).toBeEnabled())
  })

  it('books the picked own-fleet driver: the choice is saved on the draft, and a refused booking is shown without losing the move', async () => {
    const saved = completeIntakeRow({ version: 2 })
    vi.mocked(api.getIntakeLoad).mockResolvedValue(completeIntakeRow())
    vi.mocked(api.saveIntakeDraft).mockResolvedValue(saved)
    vi.mocked(api.moveIntakeToActive).mockResolvedValue({ intake: saved, shipmentId: 'shp-9', shipmentNumber: 'PRO-9', driverError: 'Pat Driver is inactive' })
    renderPage()
    await screen.findByDisplayValue('PO-100')
    expect(screen.getByText('Driver (optional)')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('intake-driver'), { target: { value: 'drv1' } })
    fireEvent.click(moveButton())
    await waitFor(() => expect(api.saveIntakeDraft).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.objectContaining({ driverId: 'drv1' }) })))
    await waitFor(() => expect(api.moveIntakeToActive).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('driver was not booked: Pat Driver is inactive')))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tms/shipments/shp-9'))
  })
})

describe('IntakeReviewPage: delete and duplicate', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getIntakeLoad).mockResolvedValue(intakeRow({ id: 'il:run-1' }))
    vi.mocked(api.listCustomers).mockResolvedValue([CUSTOMER] as never)
    vi.mocked(api.getTmsSettings).mockResolvedValue(null)
    vi.mocked(api.getWorkflowRun).mockResolvedValue(null)
    vi.mocked(api.listIntakeLoads).mockResolvedValue([
      intakeRow({ id: 'il:run-1', receivedAt: '2026-11-03T16:00:00.000Z' }),
      intakeRow({ id: 'il:run-0', receivedAt: '2026-11-03T15:00:00.000Z', fromEmail: 'other@acme.example' }),
    ])
  })

  function renderReview(isOwner: boolean) {
    vi.spyOn(auth, 'useAuth').mockReturnValue({ isOwner, isAdmin: false, hasPageAccess: () => true } as unknown as auth.AuthContextValue)
    return render(
      <MemoryRouter initialEntries={['/tms/shipments/intake/il:run-1']}>
        <Routes><Route path="/tms/shipments/intake/:intakeId" element={<IntakeReviewPage />} /></Routes>
      </MemoryRouter>,
    )
  }

  it('shows the duplicate question with a link to the original, and Delete to an owner/ADMIN only', async () => {
    renderReview(true)
    expect(await screen.findByTestId('intake-dup-notice')).toHaveTextContent('Delete this one?')
    expect(screen.getByTestId('intake-delete')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See the original' }).getAttribute('href')).toContain('il%3Arun-0')
  })

  it('a reviewer who is not owner/ADMIN sees the badge but no delete', async () => {
    renderReview(false)
    expect(await screen.findByTestId('intake-dup-notice')).toBeInTheDocument()
    expect(screen.queryByTestId('intake-delete')).not.toBeInTheDocument()
    expect(screen.queryByTestId('intake-dup-delete')).not.toBeInTheDocument()
  })
})
