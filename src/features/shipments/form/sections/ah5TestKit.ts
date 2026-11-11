/** Fixtures shared by the AH5 section tests (not imported by app code). */
import { vi } from 'vitest'
import { emptyValues, NO_LOCKS, type ShipmentFormValues } from '../model'
import type { FormCtx } from '../sectionProps'
import type { FormApi } from '../sectionRegistry'
import type { ShipmentBundle } from '@/types/tms'

export function makeActions() {
  return {
    cover: vi.fn(), openDispatch: vi.fn(), openSendRateCon: vi.fn(), openSendInfo: vi.fn(), openTonu: vi.fn(), openUncover: vi.fn(), openFor: vi.fn(),
    sendSetupPacket: vi.fn(async () => {}), addCheckCall: vi.fn(async () => {}),
    uploadDocument: vi.fn(async () => {}), queueDocument: vi.fn(), unqueueDocument: vi.fn(),
  }
}

export function makeCtx(over: Partial<FormCtx> = {}): FormCtx & { actions: ReturnType<typeof makeActions> } {
  return {
    mode: 'create', bundle: null, shipmentStatus: 'NEW', locked: NO_LOCKS,
    directory: { customers: [], locations: [], carriers: [], staff: [] },
    settings: null, customer: null, divisions: [], busy: false, dirty: false, refreshBundle: async () => {}, issues: [],
    ...over,
    actions: (over.actions as ReturnType<typeof makeActions>) ?? makeActions(),
  }
}

export function makeForm(values: ShipmentFormValues = emptyValues()): FormApi {
  return { getValues: () => values, update: vi.fn(), focusField: vi.fn() }
}

/** A saved shipment: SOURCING truckload with one load and no carrier. */
export function savedBundle(over: { loadStatus?: string; documents?: unknown[]; loadCarriers?: unknown[] } = {}): ShipmentBundle {
  return {
    shipment: { id: 'shp-1', number: 'S000001', status: 'OPEN', mode: 'FTL', customerName: 'Acme' },
    orders: [],
    loads: [{ id: 'load-1', status: over.loadStatus ?? 'SOURCING', updatedAt: '2026-01-01T00:00:00.000Z' }],
    loadCarriers: over.loadCarriers ?? [],
    charges: [],
    financials: [],
    documents: over.documents ?? [],
  } as unknown as ShipmentBundle
}
