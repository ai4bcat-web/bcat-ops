/**
 * Audit rows for the rail's Activity block: this shipment, its order, loads and carrier assignments
 * plus the intake item it came from, read through the AuditLog `(entityType, entityId)` index in ONE
 * aliased request (`listAuditLogsFor`, which falls back to the filtered scan only when the index is
 * missing). Cached 15 s via `listCache`; a new bundle (every save / create hands the form a fresh
 * one) forces a re-read.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { auditEntitiesFor } from '@/features/shipments/auditEntities'
import { listAuditLogsFor } from '@/lib/apiClient'
import { readList } from '@/lib/listCache'
import type { AuditLogEntry } from '@/types'
import type { IntakeLoadRecord } from '@/types/intake'
import type { ShipmentBundle } from '@/types/tms'

export const ACTIVITY_TTL_MS = 15_000

export interface ActivityData {
  entries: AuditLogEntry[]
  /** When the rows were read: "now" for relative times. */
  at: number
  error: string | null
}

/** The intake item behind this shipment: the one on the row, else the one the page was opened from. */
export function intakeIdOf(bundle: ShipmentBundle | null, intakeId?: string): string | null {
  return bundle?.shipment.intakeLoadId || intakeId || null
}

export function activityEntities(bundle: ShipmentBundle | null, intakeId?: string): Array<{ entityType: string; entityId: string }> {
  const intake = intakeIdOf(bundle, intakeId)
  return [
    ...(bundle ? auditEntitiesFor(bundle) : []),
    ...(intake ? [{ entityType: 'INTAKE_LOAD', entityId: intake }] : []),
  ]
}

/** The extractor's own entry for a pre-filled create: the intake row itself says when and how many fields. */
export function extractionEntry(row: IntakeLoadRecord | null | undefined): AuditLogEntry | null {
  if (!row) return null
  const count = Object.entries(row.autoFields ?? {}).filter(([k, v]) => {
    if (k === 'customerCandidates') return false
    if (Array.isArray(v)) return v.length > 0
    return v !== null && v !== undefined && v !== ''
  }).length
  return {
    id: `intake-extracted:${row.id}`,
    entityType: 'INTAKE_LOAD' as AuditLogEntry['entityType'],
    entityId: row.id,
    action: 'INTAKE_EXTRACTED' as AuditLogEntry['action'],
    user: 'intake',
    changes: { fields: { from: null, to: `${count} field${count === 1 ? '' : 's'}` } },
    createdAt: row.createdAt,
  }
}

export function useShipmentActivity(bundle: ShipmentBundle | null, intakeId?: string): ActivityData | null {
  const entities = useMemo(() => activityEntities(bundle, intakeId), [bundle, intakeId])
  const key = `shipmentActivity:${entities.map((e) => `${e.entityType}/${e.entityId}`).join(',')}`
  const [state, setState] = useState<{ key: string; data: ActivityData } | null>(null)
  const bundleSeen = useRef<ShipmentBundle | null>(bundle)

  useEffect(() => {
    if (entities.length === 0) return
    let live = true
    // The first read of a mount may be served from the 15 s cache; a new bundle (a save) re-reads.
    const force = bundleSeen.current !== bundle
    bundleSeen.current = bundle
    readList(key, () => listAuditLogsFor(entities), { ttlMs: ACTIVITY_TTL_MS, force }).fresh
      .then((entries) => { if (live) setState({ key, data: { entries, at: Date.now(), error: null } }) })
      .catch((err: unknown) => {
        if (live) setState({ key, data: { entries: [], at: Date.now(), error: err instanceof Error ? err.message : 'Could not load activity' } })
      })
    return () => { live = false }
  }, [bundle, entities, key])

  return state?.key === key ? state.data : null
}
