// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'
import * as api from '@/lib/apiClient'
import * as auth from '@/hooks/useAuth'
import type { OwnershipDivisionRecord } from '@/types/tms'
import { IntakeBoard } from './IntakeBoard'
import { intakeRow, reviewed } from './testFixtures'

const division = (code: string, name: string, over: Partial<OwnershipDivisionRecord> = {}): OwnershipDivisionRecord => ({
  id: code, code, name, brand: null, parentId: null, color: null, sortOrder: 0, active: true, owners: null, flows: null,
  createdBy: 's', updatedBy: 's', version: 1, createdAt: '', updatedAt: '', intakeEmail: `${code.toLowerCase()}@example.invalid`, ...over,
})

let divisions: OwnershipDivisionRecord[] = []
vi.mock('@/features/tms/useOwnershipDivisions', () => ({
  useOwnershipDivisions: () => ({ divisions, loading: false, error: null, refresh: () => undefined }),
}))
vi.mock('@/lib/apiClient', () => ({ listIntakeLoads: vi.fn(), countOpenIntakeLoads: vi.fn().mockResolvedValue(0) }))

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

  it('has one tab per active division with its open count, plus Unrouted, and none for archived divisions', async () => {
    renderBoard()
    expect(await screen.findByRole('tab', { name: /Brokerage/ })).toHaveTextContent('2')
    expect(screen.getByRole('tab', { name: /Logistics/ })).toHaveTextContent('0')
    expect(screen.getByRole('tab', { name: /Unrouted/ })).toHaveTextContent('1')
    expect(screen.queryByRole('tab', { name: /Old division/ })).not.toBeInTheDocument()
    expect(await screen.findByText('First tender')).toBeInTheDocument()
    expect(screen.queryByText('Stray tender')).not.toBeInTheDocument()
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
    renderBoard('/tms/shipments/intake', false)
    await screen.findByText('First tender')
    expect(screen.queryByText(/cannot receive tender e-mails yet/)).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Unrouted/ })).toBeInTheDocument()
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

  it('Create shipment on an open row opens the new-shipment form carrying that intake id, not the review page', async () => {
    renderBoard('/tms/shipments/intake?division=BRK')
    await screen.findByText('First tender')
    fireEvent.click(screen.getAllByTestId('intake-create-shipment')[0])
    expect(JSON.parse(screen.getByTestId('new-state').textContent ?? '{}')).toEqual({ intakeId: expect.stringMatching(/^il:/) })
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

  it('marks open rows Reviewed or Needs review so unreviewed loads are visible', async () => {
    vi.mocked(api.listIntakeLoads).mockImplementation(async () => [
      intakeRow({ id: 'il:a', subject: 'First tender' }),
      reviewed(intakeRow({ id: 'il:b', subject: 'Second tender' })),
    ])
    renderBoard('/tms/shipments/intake?division=BRK')
    const first = (await screen.findByText('First tender')).closest('tr') as HTMLElement
    const second = (await screen.findByText('Second tender')).closest('tr') as HTMLElement
    expect(first).toHaveTextContent('Needs review')
    expect(second).toHaveTextContent('Reviewed')
    expect(second).not.toHaveTextContent('Needs review')
  })
})
