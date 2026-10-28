import { useState, useEffect, useCallback, useMemo } from 'react'
import { listOrders, listLoadSummaries, listShipments, listShipmentsByCustomer, listShipmentsByMonth, listShipmentsByStatus } from '@/lib/apiClient'
import type { LoadBoardSummary } from '@/lib/apiClient'
import type { ArStatus, AssignmentType, LoadWorkflowStatus, OrderRecord, ShipmentRecord, ShipmentStatus } from '@/types/tms'

export type { ShipmentRecord }

/**
 * Which slice of the board to load. The status, customer and month views ride their
 * GSIs; `all` scans, which is what the "everything" tab needs and what the ~890
 * backfilled rows cost today.
 */
export type ShipmentsView =
  | { kind: 'all' }
  | { kind: 'status'; status: ShipmentStatus }
  | { kind: 'customer'; customerId: string }
  | { kind: 'month'; month: string }

/**
 * A board row: the shipment, plus the two facets that live on its order and its
 * load. Null means not known — either the row has no order/load yet, or the backend
 * predates the fields — and the board shows such a row under every filter rather
 * than hiding it.
 */
export interface ShipmentListRow extends ShipmentRecord {
  arStatus: ArStatus | null
  assignmentType: AssignmentType | null
  loadStatus: LoadWorkflowStatus | null
}

const DEFAULT_VIEW: ShipmentsView = { kind: 'all' }

/** The view's one variable, flattened so the effect can depend on a primitive. */
function viewArg(view: ShipmentsView): string {
  if (view.kind === 'status') return view.status
  if (view.kind === 'customer') return view.customerId
  if (view.kind === 'month') return view.month
  return ''
}

function fetchShipments(kind: ShipmentsView['kind'], arg: string): Promise<ShipmentRecord[]> {
  if (kind === 'status') return listShipmentsByStatus(arg as ShipmentStatus)
  if (kind === 'customer') return listShipmentsByCustomer(arg)
  if (kind === 'month') return listShipmentsByMonth(arg)
  return listShipments()
}

/**
 * The shipments board.
 *
 * Reads the chosen slice of shipments and projects each row's AR status and
 * assignment from the order and load that belong to it. A failed read is reported
 * through `error`, never rendered as an empty board — "no shipments" and "the board
 * did not load" are different answers.
 */
export function useShipments(view: ShipmentsView = DEFAULT_VIEW) {
  const [shipments, setShipments] = useState<ShipmentRecord[]>([])
  const [orders, setOrders] = useState<OrderRecord[]>([])
  const [loads, setLoads] = useState<LoadBoardSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Callers rebuild the view object every render; depending on its identity would
  // refetch forever. Its two values are what decide the query.
  const kind = view.kind
  const arg = viewArg(view)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain. `refresh` sets loading itself.
  const load = useCallback(() =>
    Promise.all([fetchShipments(kind, arg), listOrders(), listLoadSummaries()])
      .then(([s, o, l]) => { setShipments(s); setOrders(o); setLoads(l); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Shipments failed to load') })
      .finally(() => setLoading(false)),
  [kind, arg])

  useEffect(() => { void load() }, [load])
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  const rows = useMemo<ShipmentListRow[]>(() => {
    const arByShipment: Record<string, ArStatus> = {}
    for (const o of orders) if (o.arStatus) arByShipment[o.shipmentId] = o.arStatus

    const assignmentByShipment: Record<string, AssignmentType> = {}
    const statusByShipment: Record<string, LoadWorkflowStatus> = {}
    for (const l of loads) {
      if (!l.shipmentId) continue
      if (l.assignmentType) assignmentByShipment[l.shipmentId] = l.assignmentType
      if (l.status) statusByShipment[l.shipmentId] = l.status
    }

    return shipments.map((s) => ({
      ...s,
      arStatus: arByShipment[s.id] ?? null,
      assignmentType: assignmentByShipment[s.id] ?? null,
      loadStatus: statusByShipment[s.id] ?? null,
    }))
  }, [shipments, orders, loads])

  return { shipments: rows, loading, error, refresh }
}
