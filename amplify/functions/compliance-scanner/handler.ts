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
import { randomUUID, randomBytes } from 'crypto'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import {
  planScan,
  planEscalations,
  type ScanDocument,
  type ScanTask,
  type ScanAlert,
  type ScanEntity,
  type FullAlert,
  type EscalationRuleInput,
} from './scanLogic'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const ses = new SESv2Client({})

const DOC_TABLE = process.env.DOC_TABLE_NAME!
const TASK_TABLE = process.env.TASK_TABLE_NAME!
const ALERT_TABLE = process.env.ALERT_TABLE_NAME!
// Phase 4 escalation env (optional — escalation is skipped if unset)
const RULE_TABLE = process.env.RULE_TABLE_NAME
const EMAILLOG_TABLE = process.env.EMAILLOG_TABLE_NAME
const SETTINGS_TABLE = process.env.SETTINGS_TABLE_NAME
const INVITE_TABLE = process.env.INVITE_TABLE_NAME
const AUDIT_TABLE_ESC = process.env.AUDIT_TABLE_NAME
const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'onboarding@bcatcorp.com'
const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL ?? ''
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

  // ── Phase 4: expiration escalation emails ──
  const escalation = await runEscalations(asOf, now, driverRows)

  const finalSummary = { ...summary, escalationsSent: escalation.sent, escalationsPaused: escalation.paused }
  console.log('[compliance-scanner] done', JSON.stringify(finalSummary))
  return finalSummary
}

// ── Phase 4: escalation email sending ───────────────────────────────────────────

interface EscalationResult { sent: number; paused: boolean }

async function runEscalations(asOf: string, now: string, driverRows: Record<string, unknown>[]): Promise<EscalationResult> {
  if (!RULE_TABLE || !EMAILLOG_TABLE || !SETTINGS_TABLE) {
    console.log('[compliance-scanner] escalation tables not configured — skipping')
    return { sent: 0, paused: false }
  }

  // Kill switch — default PAUSED when no settings row exists.
  const settingsRows = await scanAll(SETTINGS_TABLE)
  const settings = settingsRows.find((s) => s.settingsKey === 'GLOBAL')
  const paused = !settings || settings.escalationEmailsPaused !== false
  if (paused) {
    console.log('[compliance-scanner] escalation emails PAUSED — skipping send')
    return { sent: 0, paused: true }
  }
  const managerEmails: string[] = Array.isArray(settings?.managerEmails) ? (settings!.managerEmails as string[]) : []

  const [ruleRows, logRows, alertRows] = await Promise.all([
    scanAll(RULE_TABLE),
    scanAll(EMAILLOG_TABLE),
    scanAll(ALERT_TABLE),
  ])

  const rules: EscalationRuleInput[] = ruleRows.map((r) => ({
    id: String(r.id),
    documentType: String(r.documentType),
    daysBeforeExpiration: Number(r.daysBeforeExpiration),
    recipients: r.recipients as EscalationRuleInput['recipients'],
    templateKey: String(r.templateKey ?? ''),
    active: !!r.active,
  }))

  const alerts: FullAlert[] = alertRows.map((a) => ({
    id: String(a.id),
    entityType: a.entityType as FullAlert['entityType'],
    entityId: String(a.entityId),
    entityName: (a.entityName as string) ?? null,
    documentType: String(a.documentType),
    expirationDate: (a.expirationDate as string) ?? null,
    severity: a.severity as FullAlert['severity'],
    acknowledged: !!a.acknowledged,
    resolvedAt: (a.resolvedAt as string) ?? null,
  }))

  const sentKeys = new Set(logRows.map((l) => `${l.alertId}#${Number(l.daysBeforeExpiration)}`))
  const planned = planEscalations({ alerts, rules, sentKeys, asOf })

  const driverEmailById = new Map<string, string>()
  for (const d of driverRows) if (d.email) driverEmailById.set(String(d.id), String(d.email))

  let sent = 0
  for (const { alert, rule, daysRemaining } of planned) {
    const recipients: string[] = []
    const driverEmail = alert.entityType === 'DRIVER' ? driverEmailById.get(alert.entityId) : undefined
    if ((rule.recipients === 'DRIVER' || rule.recipients === 'BOTH') && driverEmail) recipients.push(driverEmail)
    if (rule.recipients === 'MANAGER' || rule.recipients === 'BOTH') recipients.push(...managerEmails)
    const to = [...new Set(recipients)].filter(Boolean)
    if (to.length === 0) continue

    // For driver renewals, ensure an active invite + re-open the item so it flows
    // back through the portal → review queue.
    let portalLink = PORTAL_BASE_URL
    if (alert.entityType === 'DRIVER') {
      const token = await ensureInvite(alert.entityId, driverEmail ?? '')
      if (token && PORTAL_BASE_URL) portalLink = `${PORTAL_BASE_URL}/onboard/${token}`
      await reopenTask(alert.entityId, alert.documentType, now)
    }

    const { subject, body } = buildEscalationEmail(rule, alert, daysRemaining, portalLink)
    try {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: FROM_ADDRESS,
        Destination: { ToAddresses: to },
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: body } } } },
      }))
    } catch (err) {
      console.error('[compliance-scanner] SES send failed', alert.id, String(err))
      continue
    }

    // Log + stamp + audit
    await dynamo.send(new PutCommand({
      TableName: EMAILLOG_TABLE!,
      Item: {
        id: randomUUID(), __typename: 'EscalationEmailLog',
        alertId: alert.id, entityType: alert.entityType, entityName: alert.entityName,
        documentType: alert.documentType, daysBeforeExpiration: rule.daysBeforeExpiration,
        templateKey: rule.templateKey, recipients: to, sentAt: now,
        createdAt: now, updatedAt: now,
      },
    }))
    await dynamo.send(new UpdateCommand({
      TableName: ALERT_TABLE, Key: { id: alert.id },
      UpdateExpression: 'SET emailSentAt = :ts, updatedAt = :ts',
      ExpressionAttributeValues: { ':ts': now },
    }))
    if (AUDIT_TABLE_ESC) {
      await dynamo.send(new PutCommand({
        TableName: AUDIT_TABLE_ESC,
        Item: {
          id: randomUUID(), __typename: 'AuditLog', entityType: alert.entityType, entityId: alert.entityId,
          action: 'escalation_email_sent', user: 'compliance-scanner',
          changes: JSON.stringify({ alertId: alert.id, documentType: alert.documentType, daysBeforeExpiration: rule.daysBeforeExpiration, to }),
          createdAt: now, updatedAt: now,
        },
      }))
    }
    sent++
  }

  return { sent, paused: false }
}

/** Reuse an active invite token for a driver, or create a fresh one. */
async function ensureInvite(driverId: string, email: string): Promise<string | null> {
  if (!INVITE_TABLE) return null
  const rows = await scanAll(INVITE_TABLE)
  const active = rows.find((i) =>
    i.driverId === driverId && i.status !== 'REVOKED' && i.status !== 'EXPIRED' &&
    new Date(String(i.expiresAt)).getTime() > Date.now())
  if (active) return String(active.token)

  const token = randomBytes(32).toString('base64url')
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 14 * 86_400_000).toISOString()
  await dynamo.send(new PutCommand({
    TableName: INVITE_TABLE,
    Item: {
      id: randomUUID(), __typename: 'OnboardingInvite', driverId, email, token,
      status: 'SENT', expiresAt: expires, sentAt: now, requestCount: 0, createdAt: now, updatedAt: now,
    },
  }))
  return token
}

/** Re-open a driver's task for a given documentType so a renewal flows through review. */
async function reopenTask(driverId: string, documentType: string, now: string): Promise<void> {
  const tasks = await scanAll(TASK_TABLE)
  const task = tasks.find((t) => t.entityType === 'DRIVER' && t.entityId === driverId && t.requirementKey === documentType)
  if (task && task.driverActionable && task.status !== 'AWAITING_DRIVER') {
    await dynamo.send(new UpdateCommand({
      TableName: TASK_TABLE, Key: { id: String(task.id) },
      UpdateExpression: 'SET #s = :s, updatedAt = :ts',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'AWAITING_DRIVER', ':ts': now },
    }))
  }
}

function buildEscalationEmail(rule: EscalationRuleInput, alert: FullAlert, daysRemaining: number, portalLink: string) {
  const item = alert.documentType
  const expDate = alert.expirationDate ?? 'soon'
  const linkLine = portalLink ? `\nUpload the renewal here: ${portalLink}\n` : ''
  const who = alert.entityName ? ` for ${alert.entityName}` : ''

  // Day-0 / past → out-of-service
  if (rule.daysBeforeExpiration <= 0 || daysRemaining <= 0) {
    return {
      subject: `OUT OF SERVICE: ${item} has expired${who}`,
      body:
`This is an out-of-service notice. The required document "${item}"${who} expired on ${expDate}.

You are not eligible to drive for the company until this is resolved.
${linkLine}
— BCAT Logistics Safety & Compliance`,
    }
  }
  // Final warning (≤ 7 days)
  if (rule.daysBeforeExpiration <= 7) {
    return {
      subject: `FINAL WARNING: ${item} expires ${expDate}`,
      body:
`The required document "${item}"${who} expires on ${expDate} (${daysRemaining} day(s) away).

If this is not updated by ${expDate}, you will not be eligible to drive for the company until it is resolved.
${linkLine}
— BCAT Logistics Safety & Compliance`,
    }
  }
  // Standard reminder
  return {
    subject: `Renewal reminder: ${item} expires ${expDate}`,
    body:
`This is a reminder that the required document "${item}"${who} expires on ${expDate} (${daysRemaining} day(s) away).

Please upload the renewal so you stay compliant.
${linkLine}
— BCAT Logistics Safety & Compliance`,
  }
}
