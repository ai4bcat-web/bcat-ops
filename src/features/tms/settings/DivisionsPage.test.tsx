// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { OwnershipDivisionRecord, OwnershipRuleRecord } from '@/types/tms'

const mocks = vi.hoisted(() => ({
  listOwnershipDivisions: vi.fn(),
  listOwnershipRules: vi.fn(),
  listCarriers: vi.fn(),
  listCustomers: vi.fn(),
  listShipments: vi.fn(),
  listUserProfiles: vi.fn(),
  saveOwnershipDivision: vi.fn(),
  archiveOwnershipDivision: vi.fn(),
  saveOwnershipRules: vi.fn(),
  ensureOwnershipSeed: vi.fn(),
  testOwnershipRules: vi.fn(),
  retagShipments: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => mocks)

const auth = vi.hoisted(() => ({ isOwner: true, isAdmin: false }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))

import DivisionsPage from './DivisionsPage'

const division = (over: Partial<OwnershipDivisionRecord> & { code: string }): OwnershipDivisionRecord => ({
  id: over.code,
  name: over.code,
  brand: null,
  parentId: null,
  color: null,
  sortOrder: 10,
  active: true,
  owners: null,
  flows: null,
  createdBy: 'seed',
  updatedBy: 'seed',
  version: 1,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
})

const DIVISIONS: OwnershipDivisionRecord[] = [
  division({ code: 'BROKERAGE', name: 'BCAT Logistics', brand: 'BCAT Logistics', sortOrder: 10 }),
  division({ code: 'ASSETS', name: 'Ivan Cartage', brand: 'Ivan Cartage', sortOrder: 20 }),
  division({ code: 'BOX_TRUCK', name: 'Box trucks', parentId: 'ASSETS', sortOrder: 20 }),
  division({ code: 'OWNER_OPERATOR', name: 'Owner operators', parentId: 'ASSETS', sortOrder: 10 }),
]

const rule = (over: Partial<OwnershipRuleRecord> & { id: string }): OwnershipRuleRecord => ({
  name: over.id,
  sortOrder: 10,
  active: true,
  condition: { kind: 'ALWAYS', value: null },
  divisionCode: 'BROKERAGE',
  createdBy: 'seed',
  updatedBy: 'seed',
  version: 1,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
})

const RULES: OwnershipRuleRecord[] = [
  rule({ id: 'rule-1', name: 'Own fleet', sortOrder: 10, condition: { kind: 'CARRIER_IS', value: 'OWN_FLEET' }, divisionCode: 'ASSETS' }),
  rule({ id: 'rule-2', name: 'Everything else', sortOrder: 20 }),
]

beforeEach(() => {
  vi.clearAllMocks()
  auth.isOwner = true
  auth.isAdmin = false
  mocks.listOwnershipDivisions.mockResolvedValue(DIVISIONS)
  mocks.listOwnershipRules.mockResolvedValue(RULES)
  mocks.listCarriers.mockResolvedValue([{ id: 'c1', name: 'Blue Line Trucking' }])
  mocks.listCustomers.mockResolvedValue([{ id: 'cu1', name: 'Acme Foods' }])
  mocks.listShipments.mockResolvedValue([])
  mocks.listUserProfiles.mockResolvedValue([])
})

const ready = async () => {
  await waitFor(() => expect(screen.getByTestId('division-ASSETS')).toBeInTheDocument())
}

describe('DivisionsPage', () => {
  it('renders the division tree at the depth each row sits at', async () => {
    render(<DivisionsPage />)
    await ready()

    expect(screen.getByTestId('division-BROKERAGE')).toHaveAttribute('data-depth', '0')
    expect(screen.getByTestId('division-ASSETS')).toHaveAttribute('data-depth', '0')
    // Subsidiaries sit under their parent, in sortOrder — owner operators before box trucks.
    const subsidiaries = ['division-OWNER_OPERATOR', 'division-BOX_TRUCK'].map((id) => screen.getByTestId(id))
    for (const row of subsidiaries) expect(row).toHaveAttribute('data-depth', '1')
    expect(subsidiaries[0].compareDocumentPosition(subsidiaries[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(screen.getByTestId('division-ASSETS')).getByText('[Ivan Cartage]')).toBeInTheDocument()
  })

  it('shows the server’s refusal verbatim when an archive is refused', async () => {
    mocks.archiveOwnershipDivision.mockRejectedValue(new Error('ASSETS still has an active subsidiary.'))
    render(<DivisionsPage />)
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'Archive ASSETS' }))

    expect(await screen.findByText('ASSETS still has an active subsidiary.')).toBeInTheDocument()
  })

  it('saves the rule order the ▲ button produced', async () => {
    mocks.saveOwnershipRules.mockResolvedValue(RULES)
    render(<DivisionsPage />)
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'Move rule 2 up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }))

    await waitFor(() => expect(mocks.saveOwnershipRules).toHaveBeenCalled())
    expect(mocks.saveOwnershipRules.mock.calls[0][0]).toEqual({
      rules: [
        {
          id: 'rule-2',
          name: 'Everything else',
          sortOrder: 0,
          active: true,
          condition: { kind: 'ALWAYS', value: null },
          divisionCode: 'BROKERAGE',
        },
        {
          id: 'rule-1',
          name: 'Own fleet',
          sortOrder: 10,
          active: true,
          condition: { kind: 'CARRIER_IS', value: 'OWN_FLEET' },
          divisionCode: 'ASSETS',
        },
      ],
    })
  })

  it('refuses to save a rule whose reference pattern does not compile', async () => {
    mocks.listOwnershipRules.mockResolvedValue([
      rule({ id: 'rule-9', name: 'Vehicle transport', condition: { kind: 'REFERENCE_MATCHES', value: 'vehicle[' }, divisionCode: 'BROKERAGE' }),
    ])
    render(<DivisionsPage />)
    await ready()

    expect(screen.getByText('Not a valid pattern.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }))

    expect(await screen.findByText('Rule "Vehicle transport" has an invalid reference pattern.')).toBeInTheDocument()
    expect(mocks.saveOwnershipRules).not.toHaveBeenCalled()
  })

  it('resolves a PRO to its shipment and shows what the rules say against what it holds', async () => {
    mocks.listShipments.mockResolvedValue([{ id: 'sh-1', number: 'BCAT104221' }])
    mocks.testOwnershipRules.mockResolvedValue({
      context: {
        carrierId: 'OWN_FLEET',
        driverFleetGroup: 'BOX_TRUCK',
        driverType: null,
        driverProgram: 'PAPERWORK',
        customerId: 'cu1',
        equipment: null,
        mode: 'TRUCKLOAD',
        loadSource: null,
        references: ['PO 4471'],
      },
      resolution: { revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK', ruleId: 'rule-1' },
      current: { revDivision: 'BROKERAGE', revSubdivision: null, revTagSource: 'RULE' },
    })
    render(<DivisionsPage />)
    await ready()

    fireEvent.change(screen.getByLabelText('PRO or shipment id'), { target: { value: 'bcat104221' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))

    await waitFor(() => expect(mocks.testOwnershipRules).toHaveBeenCalledWith({ shipmentId: 'sh-1' }))

    const saysPanel = screen.getByRole('heading', { name: 'What the rules say' }).parentElement as HTMLElement
    expect(within(saysPanel).getByText('Own fleet')).toBeInTheDocument()
    expect(within(saysPanel).getByText('ASSETS')).toBeInTheDocument()
    expect(within(saysPanel).getByText('BOX_TRUCK')).toBeInTheDocument()

    const holdsPanel = screen.getByRole('heading', { name: 'What the shipment holds now' }).parentElement as HTMLElement
    expect(within(holdsPanel).getByText('BROKERAGE')).toBeInTheDocument()
    expect(within(holdsPanel).getByText('RULE')).toBeInTheDocument()

    const seesPanel = screen.getByRole('heading', { name: 'What the rules see' }).parentElement as HTMLElement
    expect(within(seesPanel).getByText('PO 4471')).toBeInTheDocument()
  })

  it('reports a dry run before it will write anything', async () => {
    mocks.retagShipments.mockResolvedValue({
      dryRun: true,
      scanned: 939,
      changed: 12,
      handTagged: 3,
      byDivision: { BROKERAGE: 900, ASSETS: 39 },
      bySubdivision: { BOX_TRUCK: 10 },
    })
    render(<DivisionsPage />)
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'Dry run' }))

    expect(await screen.findByText(/scanned 939, changed 12, 3 hand-tagged left alone/)).toBeInTheDocument()
    expect(screen.getByText('BROKERAGE: 900')).toBeInTheDocument()
    expect(screen.getByText('BOX_TRUCK: 10')).toBeInTheDocument()
    expect(mocks.retagShipments).toHaveBeenCalledWith({ dryRun: true })

    // Applying is a second, deliberate step.
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 12 shipments' }))
    expect(mocks.retagShipments).toHaveBeenCalledTimes(1)

    mocks.retagShipments.mockResolvedValue({
      dryRun: false,
      scanned: 939,
      changed: 12,
      handTagged: 3,
      byDivision: { BROKERAGE: 900, ASSETS: 39 },
      bySubdivision: { BOX_TRUCK: 10 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm re-tag' }))
    await waitFor(() => expect(mocks.retagShipments).toHaveBeenCalledWith({ dryRun: false }))
    expect(await screen.findByText('Applied')).toBeInTheDocument()
  })

  it('offers the seed rows only while both tables are empty', async () => {
    mocks.listOwnershipDivisions.mockResolvedValue([])
    mocks.listOwnershipRules.mockResolvedValue([])
    mocks.ensureOwnershipSeed.mockResolvedValue({ divisionsCreated: 7, rulesCreated: 7, viewsCreated: 10 })
    render(<DivisionsPage />)

    const button = await screen.findByRole('button', { name: 'Create the seed rows' })
    fireEvent.click(button)

    await waitFor(() => expect(mocks.ensureOwnershipSeed).toHaveBeenCalled())
    expect(await screen.findByText('Created 7 divisions, 7 rules and 10 views.')).toBeInTheDocument()
  })

  it('tells a signed-in user who is neither owner nor ADMIN to ask one of them', async () => {
    auth.isOwner = false
    render(<DivisionsPage />)

    expect(await screen.findByText(/edited by the owner and the ADMIN group/)).toBeInTheDocument()
    expect(mocks.listOwnershipDivisions).not.toHaveBeenCalled()
  })
})
