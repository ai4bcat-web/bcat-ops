import type { LoadWorkflowStatus } from '../types/tms'

/** A load is "moving" from the moment it is dispatched until the trailer is empty. */
export const MOVEMENT_STATUSES: readonly LoadWorkflowStatus[] = [
  'DISPATCHED',
  'LOADING',
  'PICKED_UP',
  'IN_TRANSIT',
  'RECOVERED',
  'ARRIVED_AT_DELIVERY_TERMINAL',
  'OUT_FOR_DELIVERY',
  'UNLOADING',
]
