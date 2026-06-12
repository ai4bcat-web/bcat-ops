/**
 * compliance-scanner Lambda
 *
 * Invocation modes:
 *   EventBridge daily cron (6:00 AM America/Chicago):
 *     Scans every ComplianceDocument with an expirationDate, upserts ComplianceAlert
 *     records, transitions document statuses (VALID → EXPIRING_SOON → EXPIRED),
 *     auto-resolves alerts whose document was renewed/replaced, and recomputes the
 *     cached complianceStatus on each parent Driver / TruckConfig.
 *
 *   Manual / local mock (offline testing):
 *     { "asOf": "2026-06-12", "dryRun": true }
 *     dryRun returns the computed plan WITHOUT writing — used to verify the schedule
 *     before trusting it. See ./local-invoke.mjs.
 *
 * Phase 4 extends this handler to send escalation emails after the alert upsert.
 * Idempotent: planScan converges, so re-running never duplicates alerts.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'
import {
  planScan,
  type ScanDocument,
  type ScanTask,
  type ScanAlert,
  type ScanEntity,
} from './scanLogic'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const DOC_TABLE = process.env.DOC_TABLE_NAME!
const TASK_TABLE = process.env.TASK_TABLE_NAME!
const ALERT_TABLE = process.env.ALERT_TABLE_NAME!
const DRIVER_TABLE = process.env.DRIVER_TABLE_NAME!
const TRUCK_CONFIG_TABLE = process.env.TRUCK_CONFIG_TABLE_NAME!

interface ScannerEvent {
  asOf?: string
  dryRun?: boolean
}

async function scanAll(table: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const res = await dynamo.send(
      new ScanCommand({ TableName: table, ExclusiveStartKey: lastKey }),
    )
    if (res.Items) items.push(...(res.Items as Record<string, unknown>[]))
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)
  return items
}

export const handler = async (event: ScannerEvent = {}) => {
  const asOf = event.asOf ?? new Date().toISOString().slice(0, 10)
  const now = new Date().toISOString()
  console.log('[compliance-scanner] starting', { asOf, dryRun: !!event.dryRun })

  const [docRows, taskRows, alertRows, driverRows, truckRows] = await Promise.all([
    scanAll(DOC_TABLE),
    scanAll(TASK_TABLE),
    scanAll(ALERT_TABLE),
    scanAll(DRIVER_TABLE),
    scanAll(TRUCK_CONFIG_TABLE),
  ])

  const documents: ScanDocument[] = docRows.map((d) => ({
    id: String(d.id),
    entityType: d.entityType as ScanDocument['entityType'],
    entityId: String(d.entityId),
    documentType: String(d.documentType),
    title: (d.title as string) ?? null,
    expirationDate: (d.expirationDate as string) ?? null,
    status: d.status as ScanDocument['status'],
  }))

  const tasks: ScanTask[] = taskRows.map((t) => ({
    entityType: t.entityType as ScanTask['entityType'],
    entityId: String(t.entityId),
    requirementKey: String(t.requirementKey),
    required: !!t.required,
    requiresDocument: !!t.requiresDocument,
    status: String(t.status),
  }))

  const alerts: ScanAlert[] = alertRows.map((a) => ({
    id: String(a.id),
    entityType: a.entityType as ScanAlert['entityType'],
    entityId: String(a.entityId),
    documentType: String(a.documentType),
    complianceDocumentId: (a.complianceDocumentId as string) ?? null,
    severity: a.severity as ScanAlert['severity'],
    acknowledged: !!a.acknowledged,
    resolvedAt: (a.resolvedAt as string) ?? null,
  }))

  const entities: ScanEntity[] = [
    ...driverRows.map((d) => ({
      entityType: 'DRIVER' as const,
      entityId: String(d.id),
      name: (d.name as string) ?? null,
    })),
    ...truckRows.map((t) => ({
      entityType: 'TRUCK' as const,
      entityId: String(t.truckId),
      name: (t.unitNumber as string) ?? null,
    })),
  ]

  const plan = planScan({ documents, tasks, alerts, entities, asOf })

  const summary = {
    asOf,
    documentsScanned: documents.length,
    docUpdates: plan.docUpdates.length,
    alertCreates: plan.alertCreates.length,
    alertUpdates: plan.alertUpdates.length,
    alertResolves: plan.alertResolves.length,
    entityStatusUpdates: plan.entityStatusUpdates.length,
  }

  if (event.dryRun) {
    console.log('[compliance-scanner] DRY RUN — plan:', JSON.stringify(summary))
    return { ...summary, dryRun: true, plan }
  }

  // ── Apply writes ──
  for (const u of plan.docUpdates) {
    await dynamo.send(
      new UpdateCommand({
        TableName: DOC_TABLE,
        Key: { id: u.id },
        UpdateExpression: 'SET #s = :s, updatedAt = :ts',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': u.status, ':ts': now },
      }),
    )
  }

  for (const a of plan.alertCreates) {
    await dynamo.send(
      new PutCommand({
        TableName: ALERT_TABLE,
        Item: {
          id: randomUUID(),
          __typename: 'ComplianceAlert',
          entityType: a.entityType,
          entityId: a.entityId,
          entityName: a.entityName,
          documentType: a.documentType,
          documentTitle: a.documentTitle,
          complianceDocumentId: a.complianceDocumentId,
          expirationDate: a.expirationDate,
          severity: a.severity,
          acknowledged: false,
          createdAt: now,
          updatedAt: now,
        },
      }),
    )
  }

  for (const a of plan.alertUpdates) {
    await dynamo.send(
      new UpdateCommand({
        TableName: ALERT_TABLE,
        Key: { id: a.id },
        UpdateExpression: 'SET severity = :sev, updatedAt = :ts',
        ExpressionAttributeValues: { ':sev': a.severity, ':ts': now },
      }),
    )
  }

  for (const a of plan.alertResolves) {
    await dynamo.send(
      new UpdateCommand({
        TableName: ALERT_TABLE,
        Key: { id: a.id },
        UpdateExpression: 'SET resolvedAt = :ts, updatedAt = :ts',
        ExpressionAttributeValues: { ':ts': now },
      }),
    )
  }

  for (const e of plan.entityStatusUpdates) {
    const table = e.entityType === 'DRIVER' ? DRIVER_TABLE : TRUCK_CONFIG_TABLE
    const key = e.entityType === 'DRIVER' ? { id: e.entityId } : { truckId: e.entityId }
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: 'SET complianceStatus = :cs, updatedAt = :ts',
          ExpressionAttributeValues: { ':cs': e.complianceStatus, ':ts': now },
          // Only update entities that already exist.
          ConditionExpression: e.entityType === 'DRIVER' ? 'attribute_exists(id)' : 'attribute_exists(truckId)',
        }),
      )
    } catch (err) {
      // Entity row may not exist (e.g. truck has no TruckConfig yet) — skip.
      console.warn('[compliance-scanner] skipped status update', e.entityType, e.entityId, String(err))
    }
  }

  console.log('[compliance-scanner] done', JSON.stringify(summary))
  return summary
}
