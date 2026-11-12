// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'
import * as api from '@/lib/apiClient'
import * as auth from '@/hooks/useAuth'
import type { OwnershipDivisionRecord } from '@/types/tms'
import { IntakeBoard } from './IntakeBoard'
import { intakeFields, intakeRow } from './testFixtures'

const division = (code: string, name: string, over: Partial<OwnershipDivisionRecord> = {}): OwnershipDivisionRecord => ({
  id: code, code, name, brand: null, parentId: null, color: null, sortOrder: 0, active: true, owners: null, flows: null,
  createdBy: 's', updatedBy: 's', version: 1, createdAt: '', updatedAt: '', intakeEmail: `${code.toLowerCase()}@example.invalid`, ...over,
})

let divisions: OwnershipDivisionRecord[] = []
vi.mock('@/features/tms/useOwnershipDivisions', () => ({
  useOwnershipDivisions: () => ({ divisions, loading: false, error: null, refresh: () => undefined }),
}))
vi.mock('@/lib/apiClient', () => ({ listIntakeLoads: vi.fn(), countOpenIntakeLoads: vi.fn().mockResolvedValue(0), batchShipmentTask: vi.fn(), dismissIntake: vi.fn(), deleteIntake: vi.fn(), markIntakeNotDuplicate: vi.fn() }))

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{loc.pathname + loc.search}</div>
}

function NewWhere() {
  const loc = useLocation()
  return <div data-testid="new-state">{JSON.stringify(loc.state)}</div>
}

function renderBoard(url = '/tms/shipments/intake', isOwner = true) {
  vi.spyOn(auth, 'useAuth').mockReturnValue({ isOwner, isAdmin: false, hasPageAccess: () => true } as unknown as auth.AuthContextValue)
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/tms/shipments/intake" element={<><IntakeBoard /><Where /></>} />
        <Route path="/tms/shipments/intake/:id" element={<Where />} />
        <Route path="/tms/shipments/new" element={<NewWhere />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('IntakeBoard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    divisions = [
      division('BRK', 'Brokerage'),
      division('LOG', 'Logistics'),
      division('OLD', 'Old division', { active: false }),
      division('NOA', 'No address', { intakeEmail: null }),
    ]
    vi.mocked(api.listIntakeLoads).mockImplementation(async (opts) => {
      if (opts?.status === 'MOVED') return [intakeRow({ id: 'il:moved', status: 'MOVED', subject: 'Moved one' })]
      return [
        intakeRow({ id: 'il:a', subject: 'First tender' }),
        intakeRow({ id: 'il:b', subject: 'Second tender' }),
        intakeRow({ id: 'il:c', divisionCode: null, subject: 'Stray tender' }),
      ]
    })
  })

  it('has one sub-tab per active division with its open count, plus Unassigned, and none for archived divisions', async () => {
    renderBoard('/tms/shipments/intake?view=division')
    expect(await screen.findByRole('tab', { name: /Brokerage/ })).toHaveTextContent('2')
    expect(screen.getByRole('tab', { name: /Logistics/ })).toHaveTextContent('0')
    expect(screen.getByRole('tab', { name: /Unassigned/ })).toHaveTextContent('1')
    expect(screen.queryByRole('tab', { name: /Old division/ })).not.toBeInTheDocument()
    expect(await screen.findByText('First tender')).toBeInTheDocument()
    expect(screen.getByText('Stray tender')).toBeInTheDocument()
  })

  it('shows the Unrouted rows under the Unrouted tab', async () => {
    renderBoard('/tms/shipments/intake?division=unrouted')
    expect(await screen.findByText('Stray tender')).toBeInTheDocument()
    expect(screen.queryByText('First tender')).not.toBeInTheDocument()
  })

  it('explains a division with no intake address and lists it in the owner banner', async () => {
    renderBoard('/tms/shipments/intake?division=NOA')
    expect(await screen.findByText('No intake e-mail set for No address')).toBeInTheDocument()
    expect(screen.getByText(/cannot receive tender e-mails yet/)).toHaveTextContent('No address')
  })

  it('hides the missing-address banner from a viewer who is not owner/ADMIN', async () => {
    renderBoard('/tms/shipments/intake?view=division', false)
    await screen.findByText('First tender')
    expect(screen.queryByText(/cannot receive tender e-mails yet/)).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Unassigned/ })).toBeInTheDocument()
  })

  it('switches to Moved via the status chips and opens a row in the review page', async () => {
    renderBoard('/tms/shipments/intake?division=BRK')
    await screen.findByText('First tender')
    fireEvent.click(screen.getByRole('tab', { name: 'Moved' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('status=moved'))
    expect(await screen.findByText('Moved one')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('table')).getByText('Moved one'))
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/shipments/intake/il%3Amoved')
  })

  it('Create shipment on an open row opens that row\'s review screen (the e-mail and its PDF on the left, the fields on the right)', async () => {
    renderBoard('/tms/shipments/intake?division=BRK')
    await screen.findByText('First tender')
    fireEvent.click(screen.getAllByTestId('intake-create-shipment')[0])
    expect(screen.getByTestId('where')).toHaveTextContent(/\/tms\/shipments\/intake\/il%3A/)
  })

  it('has no Mark done: a row leaves Intake when its shipment is created', async () => {
    renderBoard('/tms/shipments/intake?division=BRK')
    await screen.findByText('First tender')
    expect(screen.queryByTestId('intake-mark-done')).toBeNull()
  })

  it('offers no Create shipment on a row that already moved', async () => {
    renderBoard('/tms/shipments/intake?division=BRK&status=moved')
    await screen.findByText('Moved one')
    expect(screen.queryByTestId('intake-create-shipment')).toBeNull()
  })

  it('shows completeness text for each row', async () => {
    renderBoard('/tms/shipments/intake?division=BRK')
    const row = (await screen.findByText('First tender')).closest('tr') as HTMLElement
    expect(row).toHaveTextContent(/of \d+ required · 1 to check/)
    expect(row).toHaveTextContent('Dallas, TX → Atlanta, GA')
  })

  it('has no Review column: there is no review step', async () => {
    renderBoard('/tms/shipments/intake?division=BRK')
    const first = (await screen.findByText('First tender')).closest('tr') as HTMLElement
    expect(first).not.toHaveTextContent('Needs review')
  })

  describe('Intake tabs (Step AV feedback 3)', () => {
    beforeEach(() => {
      window.localStorage.clear()
      vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
        intakeRow({ id: 'il:a', subject: 'First tender' }),
        intakeRow({ id: 'il:b', subject: 'Second tender' }),
        intakeRow({ id: 'il:c', divisionCode: 'LOG', subject: 'Zed tender', fields: intakeFields({ customerId: 'c2', customerName: 'Zed Co' }) }),
        intakeRow({ id: 'il:d', divisionCode: null, subject: 'Stray tender', fields: intakeFields({ customerId: null, customerName: 'Typed Name' }) }),
      ])
    })
    const selectedTabs = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('data-testid')).filter((id) => id != null)

    it('opens on All loads with every row, even when a different view was remembered', async () => {
      window.localStorage.setItem('tms:intake:view:anon', 'customer')
      renderBoard()
      await screen.findByText('First tender')
      expect(screen.getByTestId('intake-view-all')).toHaveAttribute('aria-selected', 'true')
      for (const t of ['First tender', 'Second tender', 'Zed tender', 'Stray tender']) expect(screen.getByText(t)).toBeInTheDocument()
      expect(screen.queryByTestId('intake-group-all')).toBeNull()
    })

    it('By rev division: sub-tabs with counts that sum to All, URL reflects the view and group, rows narrow to the group', async () => {
      renderBoard()
      await screen.findByText('First tender')
      fireEvent.click(screen.getByTestId('intake-view-division'))
      expect(screen.getByTestId('where')).toHaveTextContent('?view=division')
      expect(screen.getByTestId('intake-group-count-all')).toHaveTextContent('4')
      expect(screen.getByTestId('intake-group-count-BRK')).toHaveTextContent('2')
      expect(screen.getByTestId('intake-group-count-LOG')).toHaveTextContent('1')
      expect(screen.getByTestId('intake-group-count-unassigned')).toHaveTextContent('1')
      fireEvent.click(screen.getByTestId('intake-group-LOG'))
      expect(screen.getByTestId('where')).toHaveTextContent('view=division&group=LOG')
      expect(screen.getByText('Zed tender')).toBeInTheDocument()
      expect(screen.queryByText('First tender')).not.toBeInTheDocument()
      expect(selectedTabs()).toEqual(['intake-view-division', 'intake-group-LOG'])
    })

    it('By customer: most rows first, Not matched last, and the choice is remembered without changing the default', async () => {
      renderBoard('/tms/shipments/intake?view=customer')
      await screen.findByText('First tender')
      const order = screen.getAllByRole('tab').map((t) => t.getAttribute('data-testid')).filter((id) => id?.startsWith('intake-group-') && !id.includes('count'))
      expect(order).toEqual(['intake-group-all', 'intake-group-c1', 'intake-group-c2', 'intake-group-not-matched'])
      expect(screen.getByTestId('intake-group-not-matched')).toHaveTextContent('Not matched')
      fireEvent.click(screen.getByTestId('intake-group-not-matched'))
      expect(screen.getByText('Stray tender')).toBeInTheDocument()
      expect(screen.queryByText('First tender')).not.toBeInTheDocument()
      expect(window.localStorage.getItem('tms:intake:view:anon')).toBe('customer')
      fireEvent.click(screen.getByTestId('intake-view-all'))
      expect(screen.getByTestId('where').textContent).toBe('/tms/shipments/intake')
    })

    it('a stale group falls back to All of that view', async () => {
      renderBoard('/tms/shipments/intake?view=customer&group=gone')
      expect(await screen.findByText('First tender')).toBeInTheDocument()
      expect(screen.getByTestId('intake-group-all')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByText('Stray tender')).toBeInTheDocument()
    })

    it('column filters, search and status chips apply within the chosen tab; counts stay on the unfiltered queue', async () => {
      renderBoard('/tms/shipments/intake?view=division&group=BRK&demo=1')
      await screen.findByText(/No tender e-mails match|No tender e-mails waiting/)
      expect(screen.getByTestId('intake-group-count-BRK')).toHaveTextContent('2')
      expect(screen.getByTestId('intake-group-count-all')).toHaveTextContent('4')
    })
  })

  describe('Push to Load Review', () => {
    it('has Push to Load Review and no Release', async () => {
      renderBoard()
      await screen.findByText('First tender')
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select row il:a' }))
      expect(screen.getByRole('button', { name: 'Push to Load Review' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Release/ })).not.toBeInTheDocument()
    })

    it('refuses an intake row with no shipment yet, per row, without calling the server', async () => {
      renderBoard()
      await screen.findByText('First tender')
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select row il:a' }))
      fireEvent.click(screen.getByRole('button', { name: 'Push to Load Review' }))
      const result = await screen.findByTestId('batch-result-il:a')
      expect(result).toHaveTextContent('No shipment yet')
      expect(api.batchShipmentTask).not.toHaveBeenCalled()
    })

    it('pushes the shipment a moved row became and reports the server answer against that row', async () => {
      vi.mocked(api.batchShipmentTask).mockResolvedValue({ results: [{ shipmentId: 's-9', number: 'S-9', ok: false, message: 'x', reasons: ['Missing sales rep'] }] })
      vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
        intakeRow({ id: 'il:moved', status: 'MOVED', shipmentId: 's-9', shipmentNumber: 'S-9', subject: 'Moved one' }),
      ])
      renderBoard('/tms/shipments/intake?status=moved')
      await screen.findByText('Moved one')
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select row il:moved' }))
      fireEvent.click(screen.getByRole('button', { name: 'Push to Load Review' }))
      await waitFor(() => expect(screen.getByTestId('batch-result-il:moved')).toHaveTextContent('Missing sales rep'))
      expect(api.batchShipmentTask).toHaveBeenCalledWith({ task: 'PUSH_TO_LOAD_REVIEW', shipmentIds: ['s-9'], params: {} })
    })
  })
})

describe('IntakeBoard: delete and duplicates', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    divisions = [division('BRK', 'Brokerage')]
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
      intakeRow({ id: 'il:a', subject: 'First tender', receivedAt: '2026-11-03T15:00:00.000Z' }),
      intakeRow({ id: 'il:b', subject: 'Second tender', receivedAt: '2026-11-03T16:00:00.000Z', fromEmail: 'other@acme.example' }),
      intakeRow({ id: 'il:z', subject: 'Unrelated', fields: intakeFields({ reference: 'ZZ-1', customerId: 'c9', customerName: 'Zed' }) }),
    ])
  })

  it('badges both rows of a duplicate pair with the question, and not an unrelated row', async () => {
    renderBoard()
    await screen.findByText('First tender')
    const notices = screen.getAllByTestId('intake-dup-notice')
    expect(notices).toHaveLength(2)
    notices.forEach((n) => { expect(n).toHaveTextContent('Possible duplicate'); expect(n).toHaveTextContent('Delete this one?') })
  })

  it('an owner/ADMIN deletes a duplicate after a confirm that names the load and says Intake only', async () => {
    vi.mocked(api.deleteIntake).mockResolvedValue(intakeRow({ id: 'il:b', status: 'DISMISSED' }))
    renderBoard()
    await screen.findByText('Second tender')
    fireEvent.click(screen.getAllByTestId('intake-dup-delete')[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Acme Foods · PO-100')
    expect(dialog).toHaveTextContent('Intake only')
    fireEvent.click(within(dialog).getByTestId('intake-delete-confirm'))
    await waitFor(() => expect(api.deleteIntake).toHaveBeenCalledWith({ intakeId: 'il:b', expectedVersion: 1 }))
  })

  it('shows the delete control on every open row for an owner/ADMIN and never for anyone else', async () => {
    renderBoard()
    await screen.findByText('First tender')
    expect(screen.getAllByTestId('intake-delete')).toHaveLength(3)
    vi.restoreAllMocks()
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [intakeRow({ id: 'il:a', subject: 'First tender' }), intakeRow({ id: 'il:b', subject: 'Second tender', fromEmail: 'o@acme.example' })])
    document.body.innerHTML = ''
    renderBoard('/tms/shipments/intake', false)
    await screen.findByText('First tender')
    expect(screen.queryByTestId('intake-delete')).not.toBeInTheDocument()
    expect(screen.queryByTestId('intake-dup-delete')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('intake-dup-notice')[0]).toHaveTextContent('Possible duplicate')
  })

  it('"Not a duplicate" is saved on the row', async () => {
    vi.mocked(api.markIntakeNotDuplicate).mockResolvedValue(intakeRow({ id: 'il:b' }))
    renderBoard()
    await screen.findByText('Second tender')
    fireEvent.click(screen.getAllByTestId('intake-dup-not')[0]!)
    await waitFor(() => expect(api.markIntakeNotDuplicate).toHaveBeenCalledWith({ intakeId: 'il:b', expectedVersion: 1 }))
  })

  it('a row an admin deleted is hidden from the Dismissed tab', async () => {
    vi.mocked(api.listIntakeLoads).mockImplementation(async (opts) => opts?.status === 'DISMISSED'
      ? [intakeRow({ id: 'il:d1', status: 'DISMISSED', subject: 'Plain dismiss', dismissReason: 'spam' }), intakeRow({ id: 'il:d2', status: 'DISMISSED', subject: 'Gone', dismissReason: 'Deleted by admin' })]
      : [])
    renderBoard('/tms/shipments/intake?status=dismissed')
    await screen.findByText('Plain dismiss')
    expect(screen.queryByText('Gone')).not.toBeInTheDocument()
  })
})
