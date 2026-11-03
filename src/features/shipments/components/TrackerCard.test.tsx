// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { toast } from 'sonner'
import { TrackerCard } from './TrackerCard'
import type { CustomerRecord, ShipmentRecord } from '@/types/tms'

const api = vi.hoisted(() => ({ assignTracker: vi.fn(), listUserProfiles: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/TrackerPicker', () => ({
  TrackerPicker: ({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) => (
    <select data-testid="tracker-picker" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Unassigned</option>
      <option value="trk-1">Trk One</option>
      <option value="trk-2">Trk Two</option>
    </select>
  ),
}))

const WHEN = '2026-04-03T12:00:00.000Z'
const shipment = (over: Partial<ShipmentRecord> = {}): ShipmentRecord => ({
  id: 'shp-1', number: 'S000001', status: 'OPEN', customerId: 'cust-1', customerName: 'Acme Freight',
  mode: 'FTL', source: 'MANUAL', createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: WHEN, updatedAt: WHEN, ...over,
}) as ShipmentRecord
const customer = { id: 'cust-1', name: 'Acme Freight', defaultTrackerId: 'trk-1' } as CustomerRecord

beforeEach(() => {
  vi.clearAllMocks()
  api.listUserProfiles.mockResolvedValue([])
  api.assignTracker.mockResolvedValue({ updated: ['shp-1'], skipped: [] })
})

describe('TrackerCard', () => {
  it('says Unassigned when read-only with no tracker', () => {
    render(<TrackerCard shipment={shipment()} canEdit={false} onChanged={vi.fn()} />)
    expect(screen.getByTestId('tracker-name')).toHaveTextContent('Unassigned')
    expect(screen.queryByTestId('tracker-picker')).toBeNull()
  })

  it('hints inheritance only while the tracker equals the customer default', () => {
    const { rerender } = render(<TrackerCard shipment={shipment({ trackerId: 'trk-1' })} customer={customer} canEdit onChanged={vi.fn()} />)
    expect(screen.getByTestId('tracker-inherited')).toHaveTextContent('Inherited from Acme Freight')
    rerender(<TrackerCard shipment={shipment({ trackerId: 'trk-2' })} customer={customer} canEdit onChanged={vi.fn()} />)
    expect(screen.queryByTestId('tracker-inherited')).toBeNull()
  })

  it('assigns exactly this shipment, then reloads', async () => {
    const onChanged = vi.fn()
    render(<TrackerCard shipment={shipment({ trackerId: 'trk-1' })} canEdit onChanged={onChanged} />)
    fireEvent.change(screen.getByTestId('tracker-picker'), { target: { value: 'trk-2' } })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(api.assignTracker).toHaveBeenCalledWith({ shipmentIds: ['shp-1'], trackerId: 'trk-2' })
  })

  it('reports a server skip instead of claiming success', async () => {
    api.assignTracker.mockResolvedValue({ updated: [], skipped: [{ shipmentId: 'shp-1', reason: 'person is inactive' }] })
    render(<TrackerCard shipment={shipment()} canEdit onChanged={vi.fn()} />)
    fireEvent.change(screen.getByTestId('tracker-picker'), { target: { value: 'trk-2' } })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Tracker not changed: person is inactive'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('is read-only on a voided shipment even when editing is allowed', () => {
    render(<TrackerCard shipment={shipment({ voidedAt: WHEN, trackerId: 'trk-1' })} canEdit onChanged={vi.fn()} />)
    expect(screen.queryByTestId('tracker-picker')).toBeNull()
  })
})
