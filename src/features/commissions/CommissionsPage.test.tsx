// @vitest-environment jsdom
/**
 * What the commission desk must never get wrong.
 *
 * A rep must not be shown an Approve button on their own money, a manager must be;
 * a $0 row parked for review must say *why* in words rather than printing a code at
 * somebody; and when commissions are off the page must say so instead of drawing four
 * empty tabs over a feature nobody turned on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CommissionsPage } from './CommissionsPage'
import type { CommissionRecord, TmsSettings } from '@/types/tms'

const authMock = vi.hoisted(() => vi.fn())
const byRepMock = vi.hoisted(() => vi.fn())
const byMonthMock = vi.hoisted(() => vi.fn())
const settingsMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useAuth', () => ({ useAuth: authMock, useAuthUser: () => null }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => String(e),
  commissionModelsDeployed: () => true,
  getTmsSettings: settingsMock,
  listCommissionsByRep: byRepMock,
  listCommissionsByMonth: byMonthMock,
  listCommissionsByInvoice: vi.fn().mockResolvedValue([]),
  listPayPeriods: vi.fn().mockResolvedValue([]),
  approveCommission: vi.fn(),
  counterCommission: vi.fn(),
  acceptCommissionCounter: vi.fn(),
  overrideCommission: vi.fn(),
  cancelCommission: vi.fn(),
  openPayPeriod: vi.fn(),
  submitPayPeriod: vi.fn(),
  approvePayPeriod: vi.fn(),
  payPayPeriod: vi.fn(),
  renderCommissionStatement: vi.fn(),
  previewCommissions: vi.fn(),
  runCommissions: vi.fn(),
}))

const ON: TmsSettings = { id: 'default', commissionsEnabled: true }

function row(over: Partial<CommissionRecord> & { id: string }): CommissionRecord {
  return {
    orderId: 'o1',
    invoiceId: 'i1',
    shipmentNumber: 'BC1001',
    customerName: 'Acme Foods',
    repId: 'rep@bcatcorp.com',
    repName: 'Rep Jones',
    roleName: 'PRIMARY_ACCOUNT_OWNER',
    basis: 'PROFIT',
    basisCents: 100_000,
    revenueCents: 200_000,
    costCents: 100_000,
    profitCents: 100_000,
    rateType: 'PERCENT_PROFIT',
    rateBps: 500,
    amountCents: 5_000,
    netCents: 5_000,
    status: 'UN_APPROVED',
    triggerAt: '2026-10-10T12:00:00.000Z',
    commissionMonth: '2026-10',
    computedAt: '2026-10-10T12:00:00.000Z',
    createdBy: 'system',
    updatedBy: 'system',
    version: 1,
    ...over,
  }
}

const draw = () => render(<MemoryRouter><CommissionsPage /></MemoryRouter>)

const tab = (label: string) => screen.getByRole('tab', { name: label })

beforeEach(() => {
  vi.clearAllMocks()
  settingsMock.mockResolvedValue(ON)
  byRepMock.mockResolvedValue([row({ id: 'mine' })])
  byMonthMock.mockResolvedValue([row({ id: 'mine' }), row({ id: 'theirs', repId: 'other@bcatcorp.com' })])
  authMock.mockReturnValue({ user: { email: 'rep@bcatcorp.com', groups: [] }, isAdmin: false })
})

describe('CommissionsPage', () => {
  it('draws the four tabs with the rows each one actually holds', async () => {
    draw()
    await waitFor(() => expect(within(tab('Mine')).getByText('1')).toBeTruthy())
    // A plain rep may counter their own row and nobody else's, so To approve holds one.
    expect(within(tab('To approve')).getByText('1')).toBeTruthy()
    expect(within(tab('Pay periods')).getByText('0')).toBeTruthy()
    expect(within(tab('History')).getByText('2')).toBeTruthy()
  })

  it("gives a rep Counter on their own row and never Approve", async () => {
    draw()
    await waitFor(() => expect(screen.getByLabelText('Counter mine')).toBeTruthy())
    expect(screen.queryByLabelText('Approve mine')).toBeNull()
  })

  it('gives a manager Approve on the rows waiting for them', async () => {
    authMock.mockReturnValue({ user: { email: 'boss@bcatcorp.com', groups: ['role-MANAGER'] }, isAdmin: false })
    byRepMock.mockResolvedValue([])
    draw()
    await waitFor(() => expect(within(tab('To approve')).getByText('2')).toBeTruthy())
    tab('To approve').click()
    await waitFor(() => expect(screen.getByLabelText('Approve mine')).toBeTruthy())
    expect(screen.getByLabelText('Approve theirs')).toBeTruthy()
  })

  it('spells out why an own-fleet row is parked instead of printing its code', async () => {
    authMock.mockReturnValue({ user: { email: 'boss@bcatcorp.com', groups: ['role-MANAGER'] }, isAdmin: false })
    byRepMock.mockResolvedValue([])
    byMonthMock.mockResolvedValue([
      row({ id: 'own-fleet', amountCents: 0, netCents: 0, needsReview: true, basisNote: 'OWN_FLEET_NO_COST' }),
    ])
    draw()
    await waitFor(() => expect(within(tab('To approve')).getByText('1')).toBeTruthy())
    tab('To approve').click()
    await waitFor(() => expect(
      screen.getByText(/ran on our own trucks, so there is no carrier cost to take a margin from/),
    ).toBeTruthy())
    expect(screen.queryByText(/OWN_FLEET_NO_COST/)).toBeNull()
  })

  it('says commissions are switched off instead of drawing an empty desk', async () => {
    settingsMock.mockResolvedValue({ id: 'default', commissionsEnabled: false } satisfies TmsSettings)
    authMock.mockReturnValue({ user: { email: 'admin@bcatcorp.com', groups: ['ADMIN'] }, isAdmin: true })
    draw()
    await waitFor(() => expect(screen.getByText('Commissions are switched off')).toBeTruthy())
    expect(screen.queryByRole('tab', { name: 'Mine' })).toBeNull()
    // An admin is the one who can turn them on, so they get the way there.
    expect(screen.getByLabelText('Open commission settings')).toBeTruthy()
    expect(byMonthMock).not.toHaveBeenCalled()
  })
})
