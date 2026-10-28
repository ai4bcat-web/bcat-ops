// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CheckCallsPage } from './CheckCallsPage'
import type { Load } from '@/types'
import type { LoadCarrierRecord, LoadCheckCallRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const HOUR = 3_600_000

function load(id: string, nextCheckCallAt: string): Load {
  return {
    id,
    aljexId: id,
    tmsId: id,
    pickupNumber: '',
    originName: '', originCity: 'Chicago, IL',
    destinationName: '', destinationCity: 'Dallas, TX',
    pickupAppt: '2026-03-02T12:00:00.000Z', deliveryAppt: '2026-03-03T12:00:00.000Z',
    pickupDriverId: null, deliveryDriverId: null,
    readyToInvoice: false,
    colorKey: null, daySlot: null, rate: 0, miles: 0, customer: 'Acme Freight', truckId: null, notes: '',
    createdBy: 'a@b.c', updatedBy: 'a@b.c',
    createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z',
    shipmentId: 'S1', loadNumber: `${id}-1`, status: 'IN_TRANSIT', checkCallOpen: 'OPEN',
    activeLoadCarrierId: 'lc-1', carrierRepId: 'rep@bcatcorp.com', nextCheckCallAt,
  } as unknown as Load
}

// One overdue (an hour past), one due (on the minute), two still scheduled.
const loads = [
  load('L-OVERDUE', new Date(Date.now() - HOUR).toISOString()),
  load('L-DUE', new Date(Date.now() - 60_000).toISOString()),
  load('L-LATER', new Date(Date.now() + 2 * HOUR).toISOString()),
  load('L-TOMORROW', new Date(Date.now() + 20 * HOUR).toISOString()),
]

const carriers: LoadCarrierRecord[] = [{
  id: 'lc-1', loadId: 'L-OVERDUE', shipmentId: 'S1', kind: 'CARRIER', status: 'ACTIVE',
  carrierName: 'Acme Trucking', driverName: 'Dale', driverPhone: '+13125550101',
  createdBy: 'a@b.c', updatedAt: '2026-03-02T00:00:00.000Z',
} as LoadCarrierRecord]

const incidents: LoadCheckCallRecord[] = [{
  id: 'cc-9', loadId: 'L-OVERDUE', shipmentId: 'S1', at: '2026-03-02T18:00:00.000Z',
  type: 'INCIDENT', source: 'MANUAL', incidentType: 'BREAKDOWN', incidentOpen: 'OPEN',
  note: 'Blown tyre on I-80', createdBy: 'rep@bcatcorp.com',
}]

const { setNextCheckCall } = vi.hoisted(() => ({ setNextCheckCall: vi.fn(async () => ({ bundle: {}, event: null })) }))

vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn(async () => null),
  listCheckCallWorklist: vi.fn(async () => loads),
  listLoadCarriersByLoad: vi.fn(async () => carriers),
  listOpenIncidents: vi.fn(async () => incidents),
  logCheckCall: vi.fn(async () => ({ bundle: {}, event: null })),
  resolveIncident: vi.fn(async () => ({ bundle: {}, event: null })),
  setNextCheckCall,
  textDriver: vi.fn(),
}))

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name: new RegExp(`^${name}`) })
}

describe('CheckCallsPage', () => {
  it('counts each tab by the same clock the notifier reads', async () => {
    render(<MemoryRouter><CheckCallsPage /></MemoryRouter>)

    await waitFor(() => expect(within(tab('Overdue')).getByText('1')).toBeTruthy())
    expect(within(tab('Due')).getByText('1')).toBeTruthy()
    expect(within(tab('Scheduled')).getByText('2')).toBeTruthy()
    expect(within(tab('Exceptions')).getByText('1')).toBeTruthy()
  })

  it('lists only the selected tab, with a dialable driver phone', async () => {
    render(<MemoryRouter><CheckCallsPage /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText('L-OVERDUE-1')).toBeTruthy())
    expect(screen.queryByText('L-LATER-1')).toBeNull()
    expect(screen.getByRole('link', { name: '+13125550101' }).getAttribute('href')).toBe('tel:+13125550101')

    fireEvent.click(tab('Scheduled'))
    await waitFor(() => expect(screen.getByText('L-LATER-1')).toBeTruthy())
    expect(screen.queryByText('L-OVERDUE-1')).toBeNull()
  })

  it('snoozes with the CAS token of the row it read', async () => {
    render(<MemoryRouter><CheckCallsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('L-OVERDUE-1')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }))
    await waitFor(() => expect(setNextCheckCall).toHaveBeenCalledTimes(1))
    const input = setNextCheckCall.mock.calls[0][0] as { loadId: string; expectedUpdatedAt: string }
    expect(input.loadId).toBe('L-OVERDUE')
    expect(input.expectedUpdatedAt).toBe('2026-03-02T00:00:00.000Z')
  })

  it('shows the open exceptions on their own tab', async () => {
    render(<MemoryRouter><CheckCallsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('L-OVERDUE-1')).toBeTruthy())

    fireEvent.click(tab('Exceptions'))
    await waitFor(() => expect(screen.getByText('Blown tyre on I-80')).toBeTruthy())
    expect(screen.getByText('Breakdown')).toBeTruthy()
  })
})
