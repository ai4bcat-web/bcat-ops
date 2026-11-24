// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TrackingQuickUpdate } from './TrackingQuickUpdate'
import { savedBundle } from '@/features/shipments/form/sections/ah5TestKit'
import type { ShipmentBundle } from '@/types/tms'

vi.mock('@/lib/apiClient', () => ({
  updateStop: vi.fn(), setLoadStatus: vi.fn(), getShipmentDocumentUrl: vi.fn(),
  getIntakeLoad: vi.fn(), attachIntakeFiles: vi.fn(), prepareDocumentUpload: vi.fn(), putPresignedFile: vi.fn(), commitDocument: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

afterEach(cleanup)

const withStops = (status = 'DISPATCHED', over: Record<string, unknown> = {}): ShipmentBundle => {
  const b = savedBundle({ documents: [] }) as ShipmentBundle
  const load = b.loads[0]
  return {
    ...b,
    loads: [{
      ...load, status, updatedAt: '2026-11-24T14:00:00.000Z',
      stops: [
        { id: 'pu', type: 'pickup', sequence: 1, appt: '2026-11-24T12:00:00.000Z' },
        { id: 'de', type: 'delivery', sequence: 2, appt: '2026-11-25T12:00:00.000Z' },
      ],
      ...over,
    }],
  } as ShipmentBundle
}

describe('TrackingQuickUpdate', () => {
  it('Now on a time saves UPDATE_STOP / SET_TIMES for that stop with the load version, and keeps the fresh bundle', async () => {
    const updated = withStops('PICKED_UP')
    updated.loads[0] = { ...updated.loads[0], updatedAt: '2026-11-24T15:00:00.000Z' }
    const updateStop = vi.fn(async () => updated)
    const onChanged = vi.fn()
    render(<TrackingQuickUpdate bundle={withStops()} onClose={vi.fn()} onChanged={onChanged} api={{ updateStop, setLoadStatus: vi.fn() }} />)

    fireEvent.click(screen.getByTestId('quick-pu-arrivedAt-now'))
    await waitFor(() => expect(updateStop).toHaveBeenCalledTimes(1))
    const call = updateStop.mock.calls[0][0] as { loadId: string; expectedUpdatedAt: string; op: string; stopId: string; patch: Record<string, string> }
    expect(call.op).toBe('SET_TIMES')
    expect(call.stopId).toBe('pu')
    expect(call.expectedUpdatedAt).toBe('2026-11-24T14:00:00.000Z')
    expect(Object.keys(call.patch)).toEqual(['arrivedAt'])
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated))

    // the next save uses the version the server just returned
    fireEvent.click(screen.getByTestId('quick-pu-departedAt-now'))
    await waitFor(() => expect(updateStop).toHaveBeenCalledTimes(2))
    expect((updateStop.mock.calls[1][0] as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe('2026-11-24T15:00:00.000Z')
  })

  it('shows the server\'s words when it refuses a time', async () => {
    const updateStop = vi.fn(async () => { throw new Error('A stop cannot be departed before it was arrived') })
    render(<TrackingQuickUpdate bundle={withStops()} onClose={vi.fn()} onChanged={vi.fn()} api={{ updateStop, setLoadStatus: vi.fn() }} />)
    fireEvent.click(screen.getByTestId('quick-de-departedAt-now'))
    await waitFor(() => expect(screen.getByTestId('quick-update-error').textContent).toContain('cannot be departed before'))
  })

  it('moves the status through SET_LOAD_STATUS and offers only the ladder\'s next steps', async () => {
    const setLoadStatus = vi.fn(async () => withStops('DELIVERED'))
    render(<TrackingQuickUpdate bundle={withStops()} onClose={vi.fn()} onChanged={vi.fn()} api={{ updateStop: vi.fn(), setLoadStatus }} />)
    const select = screen.getByTestId('quick-update-status') as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toContain('DELIVERED')
    expect(values).not.toContain('INVOICING')
    fireEvent.change(select, { target: { value: 'DELIVERED' } })
    fireEvent.click(screen.getByTestId('quick-update-status-save'))
    await waitFor(() => expect(setLoadStatus).toHaveBeenCalledWith({ loadId: withStops().loads[0].id, status: 'DELIVERED' }))
  })

  it('shows the POD box so a POD can be added from the same dialog', () => {
    render(<TrackingQuickUpdate bundle={withStops('DELIVERED')} onClose={vi.fn()} onChanged={vi.fn()} api={{ updateStop: vi.fn(), setLoadStatus: vi.fn() }} />)
    expect(screen.getByTestId('tracking-pod-upload').textContent).toContain('Upload POD')
  })

  it('disables every save on a voided shipment', () => {
    const b = withStops()
    b.shipment = { ...b.shipment, voidedAt: '2026-11-24T10:00:00.000Z' }
    render(<TrackingQuickUpdate bundle={b} onClose={vi.fn()} onChanged={vi.fn()} api={{ updateStop: vi.fn(), setLoadStatus: vi.fn() }} />)
    expect((screen.getByTestId('quick-pu-arrivedAt-now') as HTMLButtonElement).disabled).toBe(true)
  })
})
