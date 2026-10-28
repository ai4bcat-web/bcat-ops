// @vitest-environment jsdom
/**
 * The hook's own work is the two gates it derives: which order still owes paperwork,
 * and which ACTIVE assignment still owes us theirs. The cases that matter are the ones
 * a careless scope would get wrong — a file on a bounced assignment counting, a file
 * nobody has accepted yet counting, or one order's documents answering for another's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { LoadCarrierRecord, OrderRecord, ShipmentDocumentRecord, ShipmentLoad } from '@/types/tms'
import { useShipmentDocuments } from './useShipmentDocuments'

// The hook's only dependency is the one query; mocking it keeps Amplify out of the test.
const listShipmentDocuments = vi.fn<(shipmentId: string) => Promise<ShipmentDocumentRecord[]>>()
vi.mock('@/lib/apiClient', () => ({ listShipmentDocuments: (id: string) => listShipmentDocuments(id) }))

function doc(patch: Partial<ShipmentDocumentRecord> & Pick<ShipmentDocumentRecord, 'id' | 'type'>): ShipmentDocumentRecord {
  return {
    shipmentId: 'shp-1',
    name: `${patch.type}.pdf`,
    s3Key: `shipment-docs/shp-1/${patch.id}-file.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 1024,
    source: 'UPLOAD',
    audience: 'ALL',
    status: 'ACTIVE',
    version: 1,
    uploadedBy: 'ops@bcatcorp.com',
    uploadedAt: '2026-03-10T00:00:00.000Z',
    createdBy: 'ops@bcatcorp.com',
    ...patch,
  }
}

const order = { id: 'ord-1' } as OrderRecord
const otherOrder = { id: 'ord-2' } as OrderRecord
const loads = [
  { id: 'lod-1', orderId: 'ord-1' },
  { id: 'lod-2', orderId: 'ord-2' },
] as ShipmentLoad[]
const loadCarriers = [
  { id: 'lc-active', status: 'ACTIVE' },
  { id: 'lc-bounced', status: 'BOUNCED' },
] as LoadCarrierRecord[]
const customer = { requiredDocsForInvoice: ['POD', 'BOL'] }
const settings = { requiredCarrierUploadTypes: ['POD', 'CARRIER_INVOICE'] }

beforeEach(() => { listShipmentDocuments.mockReset() })
afterEach(() => { vi.clearAllMocks() })

describe('useShipmentDocuments', () => {
  it('counts an accepted carrier POD for the order and still asks for the BOL', async () => {
    listShipmentDocuments.mockResolvedValue([
      doc({ id: 'sdoc-1', type: 'POD', loadId: 'lod-1', loadCarrierId: 'lc-active', source: 'CARRIER_PORTAL', reviewStatus: 'ACCEPTED' }),
    ])
    const { result } = renderHook(() => useShipmentDocuments('shp-1', {
      bundle: { orders: [order], loads, loadCarriers },
      customer,
      settings,
    }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.orderGates['ord-1'].present).toEqual(['POD'])
    expect(result.current.orderGates['ord-1'].missing).toEqual(['BOL'])
    expect(result.current.orderGates['ord-1'].ready).toBe(false)
    // Carrier scope wants its own list, and that assignment has sent only the POD.
    expect(result.current.carrierGates['lc-active'].missing).toEqual(['CARRIER_INVOICE'])
    // A bounced assignment is nobody we are waiting on.
    expect(result.current.carrierGates['lc-bounced']).toBeUndefined()
  })

  it('does not let a pending upload or a bounced carrier satisfy the gate', async () => {
    listShipmentDocuments.mockResolvedValue([
      doc({ id: 'sdoc-2', type: 'POD', loadId: 'lod-1', loadCarrierId: 'lc-active', source: 'CARRIER_PORTAL', reviewStatus: 'PENDING' }),
      doc({ id: 'sdoc-3', type: 'BOL', loadId: 'lod-1', loadCarrierId: 'lc-bounced' }),
    ])
    const { result } = renderHook(() => useShipmentDocuments('shp-1', {
      bundle: { orders: [order], loads, loadCarriers },
      customer,
      settings,
    }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.orderGates['ord-1'].missing).toEqual(['POD', 'BOL'])
    expect(result.current.pendingCount).toBe(1)
  })

  it('keeps one order\u2019s documents out of another order\u2019s gate', async () => {
    listShipmentDocuments.mockResolvedValue([
      doc({ id: 'sdoc-4', type: 'POD', loadId: 'lod-1', orderId: 'ord-1' }),
      doc({ id: 'sdoc-5', type: 'BOL', loadId: 'lod-1', orderId: 'ord-1' }),
    ])
    const { result } = renderHook(() => useShipmentDocuments('shp-1', {
      bundle: { orders: [order, otherOrder], loads, loadCarriers },
      customer,
      settings,
    }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.orderGates['ord-1'].ready).toBe(true)
    expect(result.current.orderGates['ord-2'].missing).toEqual(['POD', 'BOL'])
  })

  it('never reads anything without a shipment', async () => {
    const { result } = renderHook(() => useShipmentDocuments(null))
    expect(result.current.loading).toBe(false)
    expect(listShipmentDocuments).not.toHaveBeenCalled()
  })
})
