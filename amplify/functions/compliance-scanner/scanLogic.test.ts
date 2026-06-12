import { describe, it, expect } from 'vitest'
import {
  planScan, planEscalations,
  type ScanDocument, type ScanTask, type ScanAlert, type ScanEntity,
  type FullAlert, type EscalationRuleInput,
} from './scanLogic'

// Local "mock event" verification for the compliance-scanner — runs the pure plan
// against a representative dataset so we can trust the schedule before deploying.
const ASOF = '2026-06-12'

const entities: ScanEntity[] = [
  { entityType: 'DRIVER', entityId: 'drv-1', name: 'Jane Hauler' },
  { entityType: 'TRUCK', entityId: 'trk-9', name: '009' },
]

describe('planScan (compliance-scanner mock invocation)', () => {
  it('creates alerts with the right severity buckets and transitions doc status', () => {
    const documents: ScanDocument[] = [
      // EXPIRED — was VALID, now past
      { id: 'doc-exp', entityType: 'DRIVER', entityId: 'drv-1', documentType: 'medical_card', title: 'Med card', expirationDate: '2026-05-01', status: 'VALID' },
      // CRITICAL (≤7d)
      { id: 'doc-crit', entityType: 'TRUCK', entityId: 'trk-9', documentType: 'insurance_cert', title: 'Insurance', expirationDate: '2026-06-15', status: 'VALID' },
      // URGENT (8–30d) — already EXPIRING_SOON, no status change
      { id: 'doc-urg', entityType: 'TRUCK', entityId: 'trk-9', documentType: 'annual_dot_inspection', title: 'DOT inspection', expirationDate: '2026-07-05', status: 'EXPIRING_SOON' },
      // far out (> 60d) — no alert, should become VALID-stable
      { id: 'doc-far', entityType: 'DRIVER', entityId: 'drv-1', documentType: 'cdl_copy', title: 'CDL', expirationDate: '2027-01-01', status: 'VALID' },
    ]
    const tasks: ScanTask[] = []
    const alerts: ScanAlert[] = []

    const plan = planScan({ documents, tasks, alerts, entities, asOf: ASOF })

    const sev = Object.fromEntries(plan.alertCreates.map((a) => [a.complianceDocumentId, a.severity]))
    expect(sev['doc-exp']).toBe('EXPIRED')
    expect(sev['doc-crit']).toBe('CRITICAL')
    expect(sev['doc-urg']).toBe('URGENT')
    expect(sev['doc-far']).toBeUndefined() // > 60d → no alert

    // doc-exp transitions VALID → EXPIRED
    expect(plan.docUpdates.find((u) => u.id === 'doc-exp')?.status).toBe('EXPIRED')

    // driver has an expired doc → NON_COMPLIANT; truck has expiring → EXPIRING_SOON
    const byEntity = Object.fromEntries(
      plan.entityStatusUpdates.map((e) => [`${e.entityType}#${e.entityId}`, e.complianceStatus]),
    )
    expect(byEntity['DRIVER#drv-1']).toBe('NON_COMPLIANT') // has an expired doc
    expect(byEntity['TRUCK#trk-9']).toBe('EXPIRING_SOON')  // docs expiring ≤30d, none expired
  })

  it('updates an existing alert severity instead of duplicating, and resolves renewed docs', () => {
    const documents: ScanDocument[] = [
      // now CRITICAL but an existing URGENT alert is open → update, not create
      { id: 'doc-1', entityType: 'TRUCK', entityId: 'trk-9', documentType: 'insurance_cert', title: 'Insurance', expirationDate: '2026-06-15', status: 'EXPIRING_SOON' },
      // renewed far into the future, but an open alert still exists → resolve
      { id: 'doc-2', entityType: 'DRIVER', entityId: 'drv-1', documentType: 'medical_card', title: 'Med card', expirationDate: '2027-06-01', status: 'VALID' },
    ]
    const alerts: ScanAlert[] = [
      { id: 'al-1', entityType: 'TRUCK', entityId: 'trk-9', documentType: 'insurance_cert', complianceDocumentId: 'doc-1', severity: 'URGENT', acknowledged: false, resolvedAt: null },
      { id: 'al-2', entityType: 'DRIVER', entityId: 'drv-1', documentType: 'medical_card', complianceDocumentId: 'doc-2', severity: 'CRITICAL', acknowledged: false, resolvedAt: null },
    ]

    const plan = planScan({ documents, tasks: [], alerts, entities, asOf: ASOF })

    expect(plan.alertCreates).toHaveLength(0)
    expect(plan.alertUpdates).toEqual([{ id: 'al-1', severity: 'CRITICAL' }])
    expect(plan.alertResolves).toEqual([{ id: 'al-2' }])
  })

  it('marks an entity NON_COMPLIANT when a required document-bearing task has no valid doc', () => {
    const tasks: ScanTask[] = [
      { entityType: 'DRIVER', entityId: 'drv-1', requirementKey: 'cdl_copy', required: true, requiresDocument: true, status: 'AWAITING_DRIVER' },
    ]
    const plan = planScan({ documents: [], tasks, alerts: [], entities, asOf: ASOF })
    const driver = plan.entityStatusUpdates.find((e) => e.entityId === 'drv-1')
    expect(driver?.complianceStatus).toBe('NON_COMPLIANT')
  })
})

describe('planEscalations (Phase 4)', () => {
  const ASOF = '2026-06-12'
  const rules: EscalationRuleInput[] = [
    { id: 'r30', documentType: 'ALL', daysBeforeExpiration: 30, recipients: 'BOTH', templateKey: 'notice_30', active: true },
    { id: 'r7', documentType: 'ALL', daysBeforeExpiration: 7, recipients: 'BOTH', templateKey: 'final_warning_7', active: true },
    { id: 'r0', documentType: 'ALL', daysBeforeExpiration: 0, recipients: 'BOTH', templateKey: 'out_of_service_0', active: true },
    { id: 'rOff', documentType: 'ALL', daysBeforeExpiration: 14, recipients: 'DRIVER', templateKey: 'x', active: false },
  ]
  const alert = (over: Partial<FullAlert>): FullAlert => ({
    id: 'a1', entityType: 'DRIVER', entityId: 'd1', documentType: 'medical_card',
    expirationDate: '2026-06-25', severity: 'URGENT', acknowledged: false, resolvedAt: null, ...over,
  })

  it('fires only crossed thresholds and ignores inactive rules', () => {
    // 13 days out → only the 30-day rule is crossed (13 <= 30); 7 and 0 not crossed.
    const out = planEscalations({ alerts: [alert({ expirationDate: '2026-06-25' })], rules, sentKeys: new Set(), asOf: ASOF })
    expect(out.map((o) => o.rule.id).sort()).toEqual(['r30'])
  })

  it('does not resend an already-logged (alert, rule) pair', () => {
    const out = planEscalations({
      alerts: [alert({ expirationDate: '2026-06-25' })],
      rules, sentKeys: new Set(['a1#30']), asOf: ASOF,
    })
    expect(out).toHaveLength(0)
  })

  it('fires the out-of-service rule once a document is past due', () => {
    const out = planEscalations({ alerts: [alert({ expirationDate: '2026-06-01', severity: 'EXPIRED' })], rules, sentKeys: new Set(), asOf: ASOF })
    // 30, 7, and 0 are all crossed for an expired doc
    expect(out.map((o) => o.rule.id).sort()).toEqual(['r0', 'r30', 'r7'])
  })

  it('skips resolved alerts', () => {
    const out = planEscalations({ alerts: [alert({ resolvedAt: '2026-06-10' })], rules, sentKeys: new Set(), asOf: ASOF })
    expect(out).toHaveLength(0)
  })
})
