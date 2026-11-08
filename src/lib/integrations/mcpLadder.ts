// Step AM — when MyCarrierPackets turns a carrier ACTIVE (packet complete + monitored), every
// live assignment of that carrier that was waiting on setup moves to ASSIGNED_SETUP_COMPLETE.
// Pure over injected IO so the sync Lambda and the tests share one rule.
import { advanceTarget, ladderPatch, isCarrierAssignmentStatus } from '../carrierAssignment'
import type { CarrierAssignmentStatus } from '../carrierAssignment'

type Row = Record<string, unknown>

export interface LadderDeps {
  /** Every LoadCarrier row of one directory carrier. */
  assignmentsOf(carrierId: string): Promise<Row[]>
  /** Write the ladder columns, guarded by the `assignmentStatus` that was read. */
  advance(row: Row, patch: Record<string, unknown>): Promise<'WRITTEN' | 'CONFLICT'>
  /** Mirror the rung onto the Load and the Shipment. */
  mirror(row: Row, status: CarrierAssignmentStatus): Promise<void>
  audit(entityId: string, action: string, changes: Record<string, unknown>): Promise<void>
}

/** Returns the assignment ids that advanced. */
export async function advanceAfterCarrierActive(deps: LadderDeps, carrier: Row, now: string): Promise<string[]> {
  const advanced: string[] = []
  for (const row of await deps.assignmentsOf(String(carrier.id))) {
    if (row.status !== 'ACTIVE' || row.kind !== 'CARRIER') continue
    const current = isCarrierAssignmentStatus(row.assignmentStatus) ? row.assignmentStatus : null
    if (current === null) continue // a row from before the ladder: nothing to advance
    const to = advanceTarget(current, {
      carrierStatus: 'ACTIVE',
      rateConStatus: row.rateConStatus as string | null | undefined,
      rateConSignedAt: row.rateConSignedAt as string | null | undefined,
      driverName: row.driverName as string | null | undefined,
      driverPhone: row.driverPhone as string | null | undefined,
      truckNumber: row.truckNumber as string | null | undefined,
      trailerNumber: row.trailerNumber as string | null | undefined,
    })
    if (!to) continue
    const patch = { ...ladderPatch(row, to, now), updatedAt: now, updatedBy: 'mcp-sync' }
    if ((await deps.advance(row, patch)) !== 'WRITTEN') continue
    await deps.mirror(row, to)
    await deps.audit(String(row.id), 'ASSIGNMENT_ADVANCED', { loadId: row.loadId, from: current, to, source: 'MCP_SYNC', carrierId: carrier.id })
    advanced.push(String(row.id))
  }
  return advanced
}
