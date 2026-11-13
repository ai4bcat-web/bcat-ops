/**
 * Test harness for the AH4 section tests: a FormCtx builder and a stateful host that owns one
 * slice (or the whole values object) the way `useShipmentForm` does.
 */
import { vi } from 'vitest'
import { NO_LOCKS, type ShipmentFormValues } from '../model'
import type { FormActions, FormCtx } from '../sectionProps'

export const noopActions = (): FormActions => ({
  cover: vi.fn(), openDispatch: vi.fn(), openSendRateCon: vi.fn(), openSendInfo: vi.fn(), openSendAddressDetails: vi.fn(), openTonu: vi.fn(), openUncover: vi.fn(), openFor: vi.fn(),
  sendSetupPacket: vi.fn(async () => {}), addCheckCall: vi.fn(async () => {}), uploadDocument: vi.fn(async () => {}),
  queueDocument: vi.fn(), unqueueDocument: vi.fn(),
})

export function makeCtx(over: Partial<FormCtx> = {}): FormCtx {
  return {
    mode: 'create', bundle: null, shipmentStatus: 'NEW', locked: NO_LOCKS,
    directory: { customers: [], locations: [], carriers: [], staff: [] },
    settings: null, customer: null, divisions: [], busy: false, dirty: false, actions: noopActions(), refreshBundle: async () => {}, issues: [],
    ...over,
  }
}


/** What `useShipmentForm` hands a slice section as `onChange`: a patch or an updater over that slice. */
export function sliceChange<K extends keyof ShipmentFormValues>(
  update: (fn: (prev: ShipmentFormValues) => ShipmentFormValues) => void,
  key: K,
) {
  return (patch: Partial<ShipmentFormValues[K]> | ((prev: ShipmentFormValues[K]) => ShipmentFormValues[K])) =>
    update((prev) => {
      const cur = prev[key]
      const next = typeof patch === 'function' ? patch(cur) : Array.isArray(cur) ? (patch as ShipmentFormValues[K]) : { ...(cur as object), ...patch }
      return { ...prev, [key]: next }
    })
}
