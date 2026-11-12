// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ShipmentBundle } from '@/types/tms'
import { LoadRequiredDocs } from './LoadRequiredDocs'

const api = vi.hoisted(() => ({ setLoadRequiredDocs: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const bundle = (extras: string[] | null) => ({
  shipment: { id: 'shp-1' },
  loads: [{ id: 'ld-1', requiredDocTypes: extras }],
  loadCarriers: [{ id: 'lc-1', status: 'ACTIVE', kind: 'CARRIER' }],
  documents: [],
  orders: [],
}) as unknown as ShipmentBundle

describe('LoadRequiredDocs', () => {
  it('shows POD and RC as locked defaults and the customer list as inherited', () => {
    render(<LoadRequiredDocs bundle={bundle(null)} customer={{ requiredDocsForInvoice: ['POD', 'BOL'] }} settings={null} disabled={false} refreshBundle={vi.fn()} />)
    const box = screen.getByTestId('card-documents-load-required')
    expect(box).toHaveTextContent('Proof of delivery')
    expect(box).toHaveTextContent('Rate confirmation (RC)')
    expect(box).toHaveTextContent('outside carrier')
    expect(box).toHaveTextContent('customer requires')
    // BOL is the customer's, so it is not offered again as an extra.
    expect(screen.queryByTestId('card-documents-load-required-BOL')).toBeNull()
    expect(screen.getByTestId('card-documents-load-required-LUMPER_RECEIPT')).not.toBeChecked()
  })

  it('saves a ticked extra for the load and refreshes the shipment', async () => {
    api.setLoadRequiredDocs.mockResolvedValue({ bundle: bundle(['LUMPER_RECEIPT']) })
    const refresh = vi.fn().mockResolvedValue(undefined)
    render(<LoadRequiredDocs bundle={bundle(['TEMP_LOG'])} customer={null} settings={null} disabled={false} refreshBundle={refresh} />)
    expect(screen.getByTestId('card-documents-load-required-TEMP_LOG')).toBeChecked()
    fireEvent.click(screen.getByTestId('card-documents-load-required-LUMPER_RECEIPT'))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(api.setLoadRequiredDocs).toHaveBeenCalledWith({ shipmentId: 'shp-1', loadId: 'ld-1', requiredDocTypes: ['TEMP_LOG', 'LUMPER_RECEIPT'] })
  })

  it('asks to create the shipment first when there is no load yet', () => {
    render(<LoadRequiredDocs bundle={null} customer={null} settings={null} disabled={false} refreshBundle={vi.fn()} />)
    expect(screen.getByTestId('card-documents-load-required-unsaved')).toBeInTheDocument()
  })
})
