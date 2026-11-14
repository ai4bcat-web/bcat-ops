// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'
import * as api from '@/lib/apiClient'
import * as auth from '@/hooks/useAuth'
import type { OwnershipDivisionRecord } from '@/types/tms'
import { IntakeBoard } from './IntakeBoard'
import { intakeFields, intakeRow } from './testFixtures'
import { resetAutolinkTried, resetBuiltMatchCache } from './useBuiltMatches'

const division = (code: string, name: string, over: Partial<OwnershipDivisionRecord> = {}): OwnershipDivisionRecord => ({
  id: code, code, name, brand: null, parentId: null, color: null, sortOrder: 0, active: true, owners: null, flows: null,
  createdBy: 's', updatedBy: 's', version: 1, createdAt: '', updatedAt: '', intakeEmail: `${code.toLowerCase()}@example.invalid`, ...over,
})

let divisions: OwnershipDivisionRecord[] = []
vi.mock('@/features/tms/useOwnershipDivisions', () => ({
  useOwnershipDivisions: () => ({ divisions, loading: false, error: null, refresh: () => undefined }),
}))
vi.mock('@/lib/apiClient', () => ({ listIntakeLoads: vi.fn(), countOpenIntakeLoads: vi.fn().mockResolvedValue(0), batchShipmentTask: vi.fn(), dismissIntake: vi.fn(), deleteIntake: vi.fn(), markIntakeNotDuplicate: vi.fn(), addIntakeNote: vi.fn(), listShipmentsBySearchKeys: vi.fn(), autolinkIntakeBuilt: vi.fn().mockResolvedValue({ linked: 0 }) }))

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{loc.pathname + loc.search}</div>
}

function NewWhere() {
  const loc = useLocation()
  return <div data-testid="new-state">{JSON.stringify(loc.state)}</div>
}

/** Opens a row's flag dialog (duplicate, already built or notes) and returns the dialog. */
async function openFlag(testId: 'intake-flag-dup' | 'intake-flag-built' | 'intake-flag-notes', index = 0) {
  fireEvent.click((await screen.findAllByTestId(testId))[index]!)
  return screen.findByRole('dialog')
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

  it('shows each row\'s rev division by name in its own column, right after Customer', async () => {
    window.localStorage.clear()
    renderBoard()
    await screen.findByText('First tender')
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '')
    const customer = headers.findIndex((h) => h.includes('Customer'))
    expect(headers[customer + 1]).toContain('Rev division')
    expect(screen.getAllByText('Brokerage').length).toBeGreaterThanOrEqual(2)
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

  it('explains a division with no intake address and lists it in a compact owner notice that can be hidden', async () => {
    window.localStorage.clear()
    renderBoard('/tms/shipments/intake?division=NOA')
    expect(await screen.findByText('No intake e-mail set for No address')).toBeInTheDocument()
    expect(screen.getByTestId('intake-divisions-banner')).toHaveTextContent('No address')
    fireEvent.click(screen.getByTestId('intake-divisions-banner-hide'))
    expect(screen.queryByTestId('intake-divisions-banner')).toBeNull()
    expect(window.localStorage.getItem('tms:intake:divisions-banner-hidden')).toBe('1')
  })

  it('hides the missing-address banner from a viewer who is not owner/ADMIN', async () => {
    renderBoard('/tms/shipments/intake?view=division', false)
    await screen.findByText('First tender')
    expect(screen.queryByTestId('intake-divisions-banner')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Unassigned/ })).toBeInTheDocument()
  })

  it('lists open loads only: no Open / Moved / Dismissed tabs, and a row opens the review page', async () => {
    renderBoard('/tms/shipments/intake?division=BRK')
    await screen.findByText('First tender')
    expect(screen.queryByRole('tab', { name: /^Moved/ })).toBeNull()
    expect(screen.queryByRole('tab', { name: /^Dismissed/ })).toBeNull()
    expect(api.listIntakeLoads).not.toHaveBeenCalledWith({ status: 'MOVED' })
    expect(screen.queryByText('Moved one')).toBeNull()
    fireEvent.click(within(screen.getByRole('table')).getByText('First tender'))
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/shipments/intake/il%3Aa')
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

  it('keeps every row one line: no grown row height', async () => {
    const { container } = renderBoard('/tms/shipments/intake?division=BRK')
    await screen.findByText('First tender')
    expect((container.querySelector('.tms-dg') as HTMLElement).style.getPropertyValue('--dg-row-h')).not.toBe('64px')
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

    it('column filters, search and status tabs apply within the chosen tab; counts stay on the unfiltered queue', async () => {
      renderBoard('/tms/shipments/intake?view=division&group=BRK')
      await screen.findByTestId('intake-group-count-BRK')
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

  it('flags both rows of a duplicate pair with a compact badge, not an unrelated row; the badge opens the question', async () => {
    renderBoard()
    await screen.findByText('First tender')
    const flags = screen.getAllByTestId('intake-flag-dup')
    expect(flags).toHaveLength(2)
    flags.forEach((f) => expect(f).toHaveTextContent('Possible duplicate'))
    expect(screen.queryByTestId('intake-dup-notice')).toBeNull()
    const dialog = await openFlag('intake-flag-dup')
    expect(within(dialog).getByTestId('intake-dup-notice')).toHaveTextContent('Delete this one?')
  })

  it('an owner/ADMIN deletes a duplicate after a confirm that names the load and says Intake only', async () => {
    vi.mocked(api.deleteIntake).mockResolvedValue(intakeRow({ id: 'il:b', status: 'DISMISSED' }))
    renderBoard()
    await screen.findByText('Second tender')
    const item = await openFlag('intake-flag-dup')
    fireEvent.click(within(item).getByTestId('intake-dup-delete'))
    const dialog = await screen.findByRole('dialog', { name: /Delete this load/ })
    expect(dialog).toHaveTextContent('Acme Foods · PO-100')
    expect(dialog).toHaveTextContent('Intake only')
    fireEvent.click(within(dialog).getByTestId('intake-delete-confirm'))
    await waitFor(() => expect(api.deleteIntake).toHaveBeenCalledWith({ intakeId: 'il:b', expectedVersion: 1 }))
  })

  it('delete and "Not a duplicate" are admin-only: in the dialog for an owner/ADMIN, absent for anyone else, and never inline in the row', async () => {
    renderBoard()
    await screen.findByText('First tender')
    expect(screen.queryByTestId('intake-delete')).toBeNull()
    let dialog = await openFlag('intake-flag-notes', 2)
    expect(within(dialog).getByTestId('intake-dialog-delete')).toBeInTheDocument()
    cleanup()
    vi.restoreAllMocks()
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [intakeRow({ id: 'il:a', subject: 'First tender' }), intakeRow({ id: 'il:b', subject: 'Second tender', fromEmail: 'o@acme.example' })])
    renderBoard('/tms/shipments/intake', false)
    await screen.findByText('First tender')
    dialog = await openFlag('intake-flag-dup')
    expect(within(dialog).queryByTestId('intake-dialog-delete')).toBeNull()
    expect(within(dialog).queryByTestId('intake-dup-delete')).toBeNull()
    expect(within(dialog).queryByTestId('intake-dup-not')).toBeNull()
    expect(within(dialog).getByTestId('intake-note-input')).toBeInTheDocument()
  })

  it('"Not a duplicate" (admin) is saved on the row', async () => {
    vi.mocked(api.markIntakeNotDuplicate).mockResolvedValue(intakeRow({ id: 'il:b' }))
    renderBoard()
    await screen.findByText('Second tender')
    const dialog = await openFlag('intake-flag-dup')
    fireEvent.click(within(dialog).getByTestId('intake-dup-not'))
    await waitFor(() => expect(api.markIntakeNotDuplicate).toHaveBeenCalledWith({ intakeId: 'il:b', expectedVersion: 1 }))
  })

  it('anyone who reviews adds a note; the row shows the note count', async () => {
    vi.mocked(api.addIntakeNote).mockResolvedValue(intakeRow({ id: 'il:z', subject: 'Unrelated', version: 2, notes: [{ at: '2026-11-12T15:00:00.000Z', by: 'kel@bcatcorp.com', text: 'Re-send of PRO 20028' }] }))
    renderBoard('/tms/shipments/intake', false)
    await screen.findByText('Unrelated')
    const dialog = await openFlag('intake-flag-notes', 2)
    expect(dialog).toHaveTextContent('No notes yet.')
    fireEvent.change(within(dialog).getByTestId('intake-note-input'), { target: { value: 'Re-send of PRO 20028' } })
    fireEvent.click(within(dialog).getByTestId('intake-note-add'))
    await waitFor(() => expect(api.addIntakeNote).toHaveBeenCalledWith({ intakeId: 'il:z', expectedVersion: 1, text: 'Re-send of PRO 20028' }))
    expect(await within(dialog).findByTestId('intake-note')).toHaveTextContent('kel')
  })

  it('shows the note count on a row that has notes', async () => {
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
      intakeRow({ id: 'il:z', subject: 'Unrelated', notes: [{ at: '2026-11-12T15:00:00.000Z', by: 'kel@bcatcorp.com', text: 'x' }, { at: '2026-11-12T16:00:00.000Z', by: 'ryne@bcatcorp.com', text: 'y' }] }),
    ])
    renderBoard()
    await screen.findByText('Unrelated')
    expect(screen.getByTestId('intake-flag-notes')).toHaveTextContent('2')
  })
})

describe('IntakeBoard: already built as a PRO', () => {
  const SHIPMENT = { id: 'shp-43', number: '20043', customerId: 'c1', customerName: 'C.H. ROBINSON', searchKey: '20043 c.h. robinson mesa az 573570079', voidedAt: null, deletedAt: null }
  beforeEach(() => {
    vi.restoreAllMocks()
    resetBuiltMatchCache()
    resetAutolinkTried()
    vi.mocked(api.autolinkIntakeBuilt).mockClear()
    vi.mocked(api.autolinkIntakeBuilt).mockResolvedValue({ linked: 0 })
    divisions = [division('BRK', 'Brokerage')]
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
      intakeRow({ id: 'il:a', subject: 'Tender for Mesa', fields: intakeFields({ reference: '573570079' }) }),
      intakeRow({ id: 'il:b', subject: 'Other load', fromEmail: 'o@acme.example', fields: intakeFields({ reference: 'NOPE-99999', pickupNumber: null, deliveryNumber: null }) }),
    ])
    vi.mocked(api.listShipmentsBySearchKeys).mockClear()
    vi.mocked(api.listShipmentsBySearchKeys).mockResolvedValue([SHIPMENT])
  })

  it('badges the row whose reference is already on a shipment with its PRO, links to it, and leaves the other row alone', async () => {
    renderBoard()
    const flag = await screen.findByTestId('intake-flag-built')
    expect(flag).toHaveTextContent('Built: PRO 20043')
    expect(screen.getAllByTestId('intake-flag-built')).toHaveLength(1)
    const notice = within(await openFlag('intake-flag-built')).getByTestId('intake-built-notice')
    expect(notice).toHaveTextContent('Already built')
    expect(notice).toHaveTextContent('Reference 573570079')
    expect(within(notice).getByTestId('intake-built-link')).toHaveAttribute('href', '/tms/shipments/shp-43')
    expect(api.listShipmentsBySearchKeys).toHaveBeenCalledTimes(1)
  })

  it('asks the server once to tie a row whose reference is on exactly one shipment, and re-reads the queue when it did', async () => {
    vi.mocked(api.autolinkIntakeBuilt).mockResolvedValue({ linked: 1 })
    renderBoard()
    await waitFor(() => expect(api.autolinkIntakeBuilt).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(vi.mocked(api.listIntakeLoads).mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('never asks to tie a row that only matched on a word of the subject', async () => {
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
      intakeRow({ id: 'il:a', subject: 'Rate Confirmation for Load: 573570079', fields: intakeFields({ reference: null, pickupNumber: null, deliveryNumber: null }) }),
    ])
    renderBoard()
    await screen.findByTestId('intake-flag-built')
    expect(api.autolinkIntakeBuilt).not.toHaveBeenCalled()
  })

  it('a reference only found in the subject says "May already be built"', async () => {
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
      intakeRow({ id: 'il:a', subject: 'Rate Confirmation for Load: 573570079', fields: intakeFields({ reference: null, pickupNumber: null, deliveryNumber: null }) }),
    ])
    renderBoard()
    expect(await screen.findByTestId('intake-flag-built')).toHaveTextContent('May be built: PRO 20043')
    expect(within(await openFlag('intake-flag-built')).getByTestId('intake-built-notice')).toHaveTextContent('May already be built')
  })

  it('does not flag a row whose customer is a different one than the shipment\'s', async () => {
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
      intakeRow({ id: 'il:a', subject: 'Tender', fields: intakeFields({ reference: '573570079', customerId: 'c9', customerName: 'Other Co' }) }),
    ])
    renderBoard()
    await screen.findByText('Tender')
    await waitFor(() => expect(api.listShipmentsBySearchKeys).toHaveBeenCalled())
    expect(screen.queryByTestId('intake-flag-built')).not.toBeInTheDocument()
  })

  it('"Not the same load" is saved on the row; the owner/ADMIN delete opens the Intake-only confirm', async () => {
    vi.mocked(api.markIntakeNotDuplicate).mockResolvedValue(intakeRow({ id: 'il:a', version: 2 }))
    renderBoard()
    const dialog = await openFlag('intake-flag-built')
    fireEvent.click(within(dialog).getByTestId('intake-built-not'))
    await waitFor(() => expect(api.markIntakeNotDuplicate).toHaveBeenCalledWith({ intakeId: 'il:a', expectedVersion: 1 }))
    fireEvent.click(within(dialog).getByTestId('intake-built-delete'))
    expect(await screen.findByRole('dialog', { name: /Delete this load/ })).toHaveTextContent('Intake only')
  })

  it('a row flagged when the e-mail arrived shows its PRO from the stored answer, with no shipment read', async () => {
    const stored = [{ shipmentId: 'shp-43', number: '20043', customerName: 'C.H. ROBINSON', value: '573570079', source: 'reference' as const }]
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
      intakeRow({ id: 'il:a', subject: 'Tender for Mesa', fields: intakeFields({ reference: '573570079' }), alreadyBuilt: stored, alreadyBuiltCheckedAt: '2026-11-12T10:00:00.000Z' }),
    ])
    renderBoard()
    expect(await screen.findByTestId('intake-flag-built')).toHaveTextContent('Built: PRO 20043')
    expect(api.listShipmentsBySearchKeys).not.toHaveBeenCalled()
  })

  it('a stored answer the row no longer holds (its reference was edited) is checked again by the screen', async () => {
    const stored = [{ shipmentId: 'shp-99', number: '19999', customerName: 'Old', value: 'OLDREF-12345', source: 'reference' as const }]
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
      intakeRow({ id: 'il:a', subject: 'Tender for Mesa', fields: intakeFields({ reference: '573570079' }), alreadyBuilt: stored, alreadyBuiltCheckedAt: '2026-11-12T10:00:00.000Z' }),
    ])
    renderBoard()
    const flag = await screen.findByTestId('intake-flag-built')
    await waitFor(() => expect(flag).toHaveTextContent('PRO 20043'))
    expect(flag).not.toHaveTextContent('19999')
  })

  it('a failed check leaves the queue unflagged and usable', async () => {
    vi.mocked(api.listShipmentsBySearchKeys).mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    renderBoard()
    await screen.findByText('Tender for Mesa')
    await waitFor(() => expect(api.listShipmentsBySearchKeys).toHaveBeenCalled())
    expect(screen.queryByTestId('intake-flag-built')).not.toBeInTheDocument()
  })
})
