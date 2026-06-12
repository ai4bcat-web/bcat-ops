// Pure scanning logic for the compliance-scanner Lambda.
// No AWS imports → unit-testable and runnable locally with a mock event.
// Mirrors src/lib/complianceStatus.ts (kept self-contained to avoid cross-bundle imports).

export const EXPIRING_SOON_DAYS = 30

export type Severity = 'UPCOMING' | 'URGENT' | 'CRITICAL' | 'EXPIRED'
export type DocStatus =
  | 'PENDING_REVIEW' | 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'REJECTED' | 'MISSING' | 'WAIVED'
export type EntityType = 'DRIVER' | 'TRUCK'
export type ComplianceStatus = 'COMPLIANT' | 'EXPIRING_SOON' | 'NON_COMPLIANT' | 'UNKNOWN'

export interface ScanDocument {
  id: string
  entityType: EntityType
  entityId: string
  documentType: string
  title?: string | null
  expirationDate?: string | null
  status: DocStatus
}

export interface ScanTask {
  entityType: EntityType
  entityId: string
  requirementKey: string
  required: boolean
  requiresDocument: boolean
  status: string
}

export interface ScanAlert {
  id: string
  entityType: EntityType
  entityId: string
  documentType: string
  complianceDocumentId?: string | null
  severity: Severity
  acknowledged: boolean
  resolvedAt?: string | null
}

export interface ScanEntity {
  entityType: EntityType
  entityId: string
  name?: string | null
}

export interface PlannedDocUpdate {
  id: string
  status: DocStatus
}
export interface PlannedAlertCreate {
  entityType: EntityType
  entityId: string
  entityName: string | null
  documentType: string
  documentTitle: string | null
  complianceDocumentId: string
  expirationDate: string | null
  severity: Severity
}
export interface PlannedAlertUpdate {
  id: string
  severity: Severity
}
export interface PlannedAlertResolve {
  id: string
}
export interface PlannedEntityStatus {
  entityType: EntityType
  entityId: string
  complianceStatus: ComplianceStatus
}

export interface ScanPlan {
  docUpdates: PlannedDocUpdate[]
  alertCreates: PlannedAlertCreate[]
  alertUpdates: PlannedAlertUpdate[]
  alertResolves: PlannedAlertResolve[]
  entityStatusUpdates: PlannedEntityStatus[]
}

export function daysUntil(dateStr: string, asOf: string): number {
  const target = Date.parse(`${dateStr}T00:00:00Z`)
  const today = Date.parse(`${asOf}T00:00:00Z`)
  return Math.round((target - today) / 86_400_000)
}

export function expirationStatus(expirationDate: string | null | undefined, asOf: string): DocStatus | null {
  if (!expirationDate) return null
  const d = daysUntil(expirationDate, asOf)
  if (d < 0) return 'EXPIRED'
  if (d <= EXPIRING_SOON_DAYS) return 'EXPIRING_SOON'
  return 'VALID'
}

export function severityFromDays(days: number): Severity | null {
  if (days < 0) return 'EXPIRED'
  if (days <= 7) return 'CRITICAL'
  if (days <= 30) return 'URGENT'
  if (days <= 60) return 'UPCOMING'
  return null
}

function entityKey(t: EntityType, id: string): string {
  return `${t}#${id}`
}

/**
 * Produce the full set of planned writes for one scan pass. Idempotent: re-running
 * with the same inputs yields updates that converge (no duplicate alerts).
 */
export function planScan(input: {
  documents: ScanDocument[]
  tasks: ScanTask[]
  alerts: ScanAlert[]
  entities: ScanEntity[]
  asOf: string
}): ScanPlan {
  const { documents, tasks, alerts, entities, asOf } = input
  const plan: ScanPlan = {
    docUpdates: [],
    alertCreates: [],
    alertUpdates: [],
    alertResolves: [],
    entityStatusUpdates: [],
  }

  const nameByEntity = new Map<string, string | null>()
  for (const e of entities) nameByEntity.set(entityKey(e.entityType, e.entityId), e.name ?? null)

  // Index open (unacknowledged, unresolved) alerts by document id for upsert/resolve.
  const openAlertByDoc = new Map<string, ScanAlert>()
  for (const a of alerts) {
    if (a.acknowledged || a.resolvedAt) continue
    if (a.complianceDocumentId) openAlertByDoc.set(a.complianceDocumentId, a)
  }
  const docIds = new Set(documents.map((d) => d.id))
  const touchedAlertDocIds = new Set<string>()

  // ── Per-document: recompute status + upsert/resolve alert ──
  for (const doc of documents) {
    // WAIVED / REJECTED / PENDING_REVIEW are manual states — don't auto-transition them.
    const autoStatusEligible = doc.status === 'VALID' || doc.status === 'EXPIRING_SOON' || doc.status === 'EXPIRED'
    const newStatus = expirationStatus(doc.expirationDate, asOf)

    if (autoStatusEligible && newStatus && newStatus !== doc.status) {
      plan.docUpdates.push({ id: doc.id, status: newStatus })
    }

    if (!doc.expirationDate) continue
    const days = daysUntil(doc.expirationDate, asOf)
    const severity = severityFromDays(days)

    // No alert needed if > 60 days out, or doc is waived/rejected.
    const alertable = severity !== null && doc.status !== 'WAIVED' && doc.status !== 'REJECTED'
    const existing = openAlertByDoc.get(doc.id)

    if (alertable && severity) {
      touchedAlertDocIds.add(doc.id)
      if (existing) {
        if (existing.severity !== severity) plan.alertUpdates.push({ id: existing.id, severity })
      } else {
        plan.alertCreates.push({
          entityType: doc.entityType,
          entityId: doc.entityId,
          entityName: nameByEntity.get(entityKey(doc.entityType, doc.entityId)) ?? null,
          documentType: doc.documentType,
          documentTitle: doc.title ?? null,
          complianceDocumentId: doc.id,
          expirationDate: doc.expirationDate,
          severity,
        })
      }
    } else if (existing) {
      // Document moved back out of alert range (renewed/extended) — resolve.
      plan.alertResolves.push({ id: existing.id })
    }
  }

  // Auto-resolve open alerts whose document no longer exists (replaced/deleted).
  for (const [docId, alert] of openAlertByDoc) {
    if (!docIds.has(docId) && !touchedAlertDocIds.has(docId)) {
      plan.alertResolves.push({ id: alert.id })
    }
  }

  // ── Per-entity: recompute cached complianceStatus ──
  const entityIds = new Set<string>()
  for (const d of documents) entityIds.add(entityKey(d.entityType, d.entityId))
  for (const t of tasks) entityIds.add(entityKey(t.entityType, t.entityId))
  for (const e of entities) entityIds.add(entityKey(e.entityType, e.entityId))

  const docsByEntity = groupBy(documents, (d) => entityKey(d.entityType, d.entityId))
  const tasksByEntity = groupBy(tasks, (t) => entityKey(t.entityType, t.entityId))
  // Effective doc status after this pass (apply planned updates).
  const plannedDocStatus = new Map(plan.docUpdates.map((u) => [u.id, u.status]))

  for (const key of entityIds) {
    const [entityType, entityId] = key.split('#') as [EntityType, string]
    const docs = docsByEntity.get(key) ?? []
    const entTasks = tasksByEntity.get(key) ?? []

    let anyExpired = false
    let anyExpiring = false

    for (const d of docs) {
      const eff = plannedDocStatus.get(d.id) ?? d.status
      if (eff === 'EXPIRED') anyExpired = true
      if (eff === 'EXPIRING_SOON') anyExpiring = true
    }

    // A required, document-bearing task with no VALID document on file = MISSING.
    const validDocTypes = new Set(
      docs.filter((d) => (plannedDocStatus.get(d.id) ?? d.status) === 'VALID').map((d) => d.documentType),
    )
    let anyMissingRequired = false
    for (const t of entTasks) {
      const done = t.status === 'COMPLETE' || t.status === 'WAIVED' || t.status === 'NOT_APPLICABLE'
      if (t.required && t.requiresDocument && !done && !validDocTypes.has(t.requirementKey)) {
        anyMissingRequired = true
      }
    }

    let status: ComplianceStatus
    if (anyExpired || anyMissingRequired) status = 'NON_COMPLIANT'
    else if (anyExpiring) status = 'EXPIRING_SOON'
    else if (docs.length > 0 || entTasks.length > 0) status = 'COMPLIANT'
    else status = 'UNKNOWN'

    plan.entityStatusUpdates.push({ entityType, entityId, complianceStatus: status })
  }

  return plan
}

// ── Phase 4: escalation planning ────────────────────────────────────────────────

export interface EscalationRuleInput {
  id: string
  documentType: string // catalog key or 'ALL'
  daysBeforeExpiration: number
  recipients: 'DRIVER' | 'MANAGER' | 'BOTH'
  templateKey: string
  active: boolean
}

export interface FullAlert {
  id: string
  entityType: EntityType
  entityId: string
  entityName?: string | null
  documentType: string
  expirationDate?: string | null
  severity: Severity
  acknowledged: boolean
  resolvedAt?: string | null
}

export interface PlannedEscalation {
  alert: FullAlert
  rule: EscalationRuleInput
  daysRemaining: number
}

/**
 * For each unresolved alert with an expiration, emit one escalation per active rule
 * whose threshold has been crossed and for which no email has been sent yet
 * (dedup key = `${alertId}#${daysBeforeExpiration}`). Idempotent across runs.
 */
export function planEscalations(input: {
  alerts: FullAlert[]
  rules: EscalationRuleInput[]
  sentKeys: Set<string>
  asOf: string
}): PlannedEscalation[] {
  const { alerts, rules, sentKeys, asOf } = input
  const active = rules.filter((r) => r.active)
  const out: PlannedEscalation[] = []

  for (const alert of alerts) {
    if (alert.resolvedAt || !alert.expirationDate) continue
    const daysRemaining = daysUntil(alert.expirationDate, asOf)
    for (const rule of active) {
      if (rule.documentType !== 'ALL' && rule.documentType !== alert.documentType) continue
      if (daysRemaining > rule.daysBeforeExpiration) continue // threshold not crossed
      const key = `${alert.id}#${rule.daysBeforeExpiration}`
      if (sentKeys.has(key)) continue
      out.push({ alert, rule, daysRemaining })
    }
  }
  return out
}

function groupBy<T>(items: T[], keyFn: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const k = keyFn(it)
    const arr = m.get(k)
    if (arr) arr.push(it)
    else m.set(k, [it])
  }
  return m
}
