// @vitest-environment jsdom
/**
 * The AP card is where a shipment says what it costs us, so these tests pin the three
 * things a reader relies on: the lit rung matches the assignment's rung, an own-fleet
 * leg is structurally outside AP — no ladder, no Record, a settlement link instead — and
 * a TONU'd assignment still has a card, because a truck that showed up is owed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ApCard } from './ApCard'
import type {
  ApStatus, CarrierBillRecord, LoadCarrierRecord, LoadChargeRecord, ShipmentBundle, ShipmentLoad, ShipmentRecord,
} from '@/types/tms'

const getCarrier = vi.hoisted(() => vi.fn())
const getCarrierBill = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({
  getCarrier,
  getCarrierBill,
  voidBill: vi.fn(),
}))
// The dialogs are mounted, never opened here; each has its own tests and each would drag
// a finance read into a render test about the card.
vi.mock('@/features/ap/components/RecordBillDialog', () => ({ RecordBillDialog: () => null }))
vi.mock('@/features/ap/components/ApproveBillDialog', () => ({ ApproveBillDialog: () => null }))
vi.mock('@/features/ap/components/UpdateCarrierChargesDialog', () => ({ UpdateCarrierChargesDialog: () => null }))
vi.mock('@/features/ap/components/PayCarrierDialog', () => ({ PayCarrierDialog: () => null }))
vi.mock('@/features/ar/components/ReasonDialog', () => ({ ReasonDialog: () => null }))

const WHEN = '2026-04-03T12:00:00.000Z'

function shipment(): ShipmentRecord {
  return {
    id: 'shp-1', number: 'S000001', status: 'DELIVERED', customerId: 'cust-1', customerName: 'Acme Freight',
    mode: 'FTL', source: 'MANUAL',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: WHEN, updatedAt: WHEN,
  }
}

function load(): ShipmentLoad {
  return { id: 'load-1', loadNumber: 'S000001-1', status: 'DELIVERED', deliveredAt: WHEN }
}

function assignment(over: Partial<LoadCarrierRecord> = {}): LoadCarrierRecord {
  return {
    id: 'lc-1', loadId: 'load-1', shipmentId: 'shp-1', kind: 'CARRIER', status: 'ACTIVE',
    carrierId: 'car-1', carrierName: 'Pronto Trucking', apStatus: 'AWAITING_INVOICE',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: WHEN, updatedAt: WHEN,
    ...over,
  }
}

function charge(over: Partial<LoadChargeRecord> = {}): LoadChargeRecord {
  return {
    id: 'chg-1', loadId: 'load-1', shipmentId: 'shp-1', side: 'CARRIER', loadCarrierId: 'lc-1',
    code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 200000, count: 1, amountCents: 200000,
    isRate: true, sortOrder: 0, createdBy: 'a@b.c', createdAt: WHEN, updatedAt: WHEN,
    ...over,
  }
}

function bill(over: Partial<CarrierBillRecord> = {}): CarrierBillRecord {
  return {
    id: 'cb:lc-1:1', loadCarrierId: 'lc-1', loadId: 'load-1', shipmentId: 'shp-1', carrierId: 'car-1',
    carrierName: 'Pronto Trucking', payeeKind: 'CARRIER', remitTo: { name: 'Pronto Trucking' },
    status: 'TO_BE_PAID', billNumber: 'PT-7781', billDate: '2026-04-01', billMonth: '2026-04',
    recordedAt: WHEN, recordedBy: 'a@b.c', dueAt: '2026-05-01', termsDays: 30,
    grossCents: 200000, quickPayFeeCents: 0, netCents: 200000, billedCents: 200000, varianceCents: 0,
    paidCents: 0, creditedCents: 0, balanceCents: 200000,
    createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1, createdAt: WHEN, updatedAt: WHEN,
    ...over,
  }
}

function bundleOf(loadCarriers: LoadCarrierRecord[], charges: LoadChargeRecord[] = [charge()]): ShipmentBundle {
  return {
    shipment: shipment(), orders: [], loads: [load()], loadCarriers, charges, financials: [], documents: [],
  }
}

function renderCard(loadCarriers: LoadCarrierRecord[], charges?: LoadChargeRecord[]) {
  render(
    <MemoryRouter>
      <ApCard bundle={bundleOf(loadCarriers, charges)} onReload={vi.fn(async () => {})} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getCarrier.mockResolvedValue({ id: 'car-1', name: 'Pronto Trucking', status: 'ACTIVE' })
  getCarrierBill.mockResolvedValue(null)
})

describe('ApCard', () => {
  it.each<[ApStatus, string]>([
    ['AWAITING_INVOICE', 'ap-rung-AWAITING_INVOICE'],
    ['IN_REVIEW', 'ap-rung-IN_REVIEW'],
    ['TO_BE_PAID', 'ap-rung-TO_BE_PAID'],
    ['PAID', 'ap-rung-PAID'],
  ])('lights the %s rung and no other', (apStatus, litId) => {
    renderCard([assignment({ apStatus })])
    const lit = screen.getAllByTestId(/^ap-rung-/).filter((el) => el.getAttribute('aria-current') === 'step')
    expect(lit.map((el) => el.getAttribute('data-testid'))).toEqual([litId])
  })

  it('keeps an own-fleet leg out of AP entirely: no ladder, no Record, a settlement link instead', () => {
    renderCard([assignment({ kind: 'OWN_ASSET', carrierId: null, carrierName: null, driverId: 'drv-9', driverName: 'Rosa Vega' })])

    expect(screen.getByTestId('ap-card')).toBeTruthy()
    expect(screen.queryByTestId('ap-ladder')).toBeNull()
    expect(screen.queryAllByTestId(/^ap-rung-/)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Record bill/ })).toBeNull()
    expect(screen.getByTestId('ap-own-asset').textContent).toContain('Settled through driver pay')
    expect(screen.getByTestId('ap-settlement-link').getAttribute('href'))
      .toBe('/driver-pay?week=2026-03-29&driver=drv-9')
  })

  it('still cards a TONU\u2019d assignment, and drops a bounced one', () => {
    renderCard([
      assignment({ id: 'lc-1', status: 'TONU' }),
      assignment({ id: 'lc-2', status: 'BOUNCED', carrierName: 'No Show Lines' }),
    ])

    const cards = screen.getAllByTestId('ap-card')
    expect(cards.map((el) => el.getAttribute('data-assignment'))).toEqual(['lc-1'])
    expect(screen.getByTestId('ap-tonu')).toBeTruthy()
  })

  it('shows the bill number, net, balance and due date once the assignment is billed', async () => {
    getCarrierBill.mockResolvedValue(bill({ paidCents: 50000, balanceCents: 150000, status: 'PARTIAL' }))
    renderCard([assignment({ apStatus: 'TO_BE_PAID', invoiceId: 'cb:lc-1:1' })])

    await waitFor(() => expect(screen.getByRole('link', { name: 'PT-7781' })).toBeTruthy())
    expect(screen.getByRole('link', { name: 'PT-7781' }).getAttribute('href')).toBe('/ap/bills/cb:lc-1:1')
    expect(screen.getByText('$2,000.00')).toBeTruthy()
    expect(screen.getByText('$1,500.00')).toBeTruthy()
    expect(screen.getByText('2026-05-01')).toBeTruthy()
    expect(screen.getByTestId('ap-payee').textContent).toContain('Pronto Trucking')
  })

  it('names the factor as the payee when the bill was factored', async () => {
    getCarrierBill.mockResolvedValue(bill({ payeeKind: 'FACTOR', remitTo: { name: 'TBS Factoring', factorName: 'TBS Factoring' } }))
    renderCard([assignment({ apStatus: 'TO_BE_PAID', invoiceId: 'cb:lc-1:1' })])

    await waitFor(() => expect(screen.getByTestId('ap-payee').textContent).toContain('TBS Factoring (factor)'))
  })

  it('offers Record bill once the directory confirms the carrier is billable', async () => {
    renderCard([assignment()])
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Record bill/ }).hasAttribute('disabled')).toBe(false)
    })
  })

  it('refuses Record bill, with the reason, when the assignment has no carrier charges', async () => {
    renderCard([assignment()], [])
    await waitFor(() => expect(screen.getByTestId('ap-readiness').textContent).toContain('no carrier charges'))
    expect(screen.getByRole('button', { name: /Record bill/ }).hasAttribute('disabled')).toBe(true)
  })

  it('swaps Record for the money actions once a bill exists', async () => {
    getCarrierBill.mockResolvedValue(bill({ status: 'IN_REVIEW' }))
    renderCard([assignment({ apStatus: 'IN_REVIEW', invoiceId: 'cb:lc-1:1' })])

    await waitFor(() => expect(screen.getByRole('button', { name: /Approve/ })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Record bill/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Pay carrier/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Void/ })).toBeTruthy()
  })
})
