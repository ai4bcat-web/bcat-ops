/**
 * onboarding-portal-api Lambda (Function URL)
 *
 * The driver-facing portal does NOT use Cognito or AppSync. Every request carries
 * the invite `token`; this Lambda validates it server-side, scopes every query to
 * the invite's driverId, and never returns another driver's data.
 *
 * Request:  POST JSON  { token, action, payload? }
 * Actions:  getOnboardingState | saveApplicationDraft | submitApplication
 *           getUploadUrl | confirmUpload | eSign
 *
 * Rate-limited per token via OnboardingInvite.requestCount. All actions are logged
 * to AuditLog with source DRIVER_PORTAL.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

const INVITE_TABLE = process.env.INVITE_TABLE_NAME!
const DRIVER_TABLE = process.env.DRIVER_TABLE_NAME!
const TASK_TABLE = process.env.TASK_TABLE_NAME!
const DOC_TABLE = process.env.DOC_TABLE_NAME!
const APP_TABLE = process.env.APP_TABLE_NAME!
const AUDIT_TABLE = process.env.AUDIT_TABLE_NAME!
const BUCKET = process.env.BUCKET_NAME!
// Note: ALLOWED_ORIGINS env is still set in backend.ts but CORS is enforced by the
// Function URL's CORS config, so the handler no longer reads it.

const MAX_REQUESTS_PER_TOKEN = 2000
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const ACCEPTED_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif']

const JSON_FIELDS = ['addressHistory', 'priorLicenses', 'employmentHistory', 'accidents', 'violations']

interface FnUrlEvent {
  body?: string | null
  isBase64Encoded?: boolean
  headers?: Record<string, string>
  requestContext?: { http?: { method?: string; sourceIp?: string } }
}

interface InviteRow {
  id: string
  driverId: string
  email: string
  driverType?: string | null
  token: string
  status: string
  expiresAt: string
  requestCount?: number
}

// CORS is owned by the Lambda Function URL's own CORS config (see backend.ts) — it
// echoes the matching Origin and handles preflight. We must NOT also set
// Access-Control-* here, or the browser sees a duplicated header and blocks the call.
function reply(status: number, body: unknown, _origin?: string) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function scan(table: string, filter: string, names: Record<string, string>, values: Record<string, unknown>) {
  const items: Record<string, unknown>[] = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: table, FilterExpression: filter,
      // DynamoDB rejects an empty ExpressionAttributeNames — only include it when used.
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      ExclusiveStartKey: lastKey,
    }))
    if (res.Items) items.push(...(res.Items as Record<string, unknown>[]))
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)
  return items
}

async function audit(driverId: string, action: string, changes: Record<string, unknown>) {
  const now = new Date().toISOString()
  await ddb.send(new PutCommand({
    TableName: AUDIT_TABLE,
    Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'DRIVER', entityId: driverId, action, user: 'DRIVER_PORTAL', changes: JSON.stringify(changes), createdAt: now, updatedAt: now },
  }))
}

class PortalError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function validateInvite(token: string): Promise<InviteRow> {
  if (!token) throw new PortalError(400, 'Missing token')
  const rows = await scan(INVITE_TABLE, '#t = :t', { '#t': 'token' }, { ':t': token })
  const invite = rows[0] as unknown as InviteRow | undefined
  if (!invite) throw new PortalError(404, 'Invite not found')
  if (invite.status === 'REVOKED' || invite.status === 'EXPIRED') throw new PortalError(410, 'This link is no longer active')
  if (new Date(invite.expiresAt).getTime() < Date.now()) throw new PortalError(410, 'This link has expired')
  if ((invite.requestCount ?? 0) > MAX_REQUESTS_PER_TOKEN) throw new PortalError(429, 'Too many requests')
  return invite
}

async function touchInvite(invite: InviteRow, patch: Record<string, unknown>) {
  const now = new Date().toISOString()
  const sets = ['lastActivityAt = :now', 'requestCount = if_not_exists(requestCount, :zero) + :one', 'updatedAt = :now']
  const values: Record<string, unknown> = { ':now': now, ':zero': 0, ':one': 1 }
  let i = 0
  for (const [k, v] of Object.entries(patch)) { sets.push(`#k${i} = :v${i}`); values[`:v${i}`] = v; i++ }
  const names: Record<string, string> = {}
  Object.keys(patch).forEach((k, idx) => { names[`#k${idx}`] = k })
  await ddb.send(new UpdateCommand({
    TableName: INVITE_TABLE, Key: { id: invite.id },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  }))
}

function parseAppJson(app: Record<string, unknown>): Record<string, unknown> {
  const out = { ...app }
  for (const f of JSON_FIELDS) {
    if (typeof out[f] === 'string') { try { out[f] = JSON.parse(out[f] as string) } catch { out[f] = null } }
  }
  return out
}

function serializeAppJson(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input }
  for (const f of JSON_FIELDS) { if (f in out && out[f] !== undefined) out[f] = JSON.stringify(out[f] ?? null) }
  return out
}

// OnboardingTask.links is stored as AWSJSON (a JSON string). Parse to an array for the portal.
function parseLinks(v: unknown): { label: string; url: string }[] | null {
  if (!v) return null
  try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : null } catch { return null }
}

async function getDriverTasks(driverId: string) {
  return scan(TASK_TABLE, 'entityType = :d AND entityId = :id', {}, { ':d': 'DRIVER', ':id': driverId })
}
async function getDriverDocs(driverId: string) {
  return scan(DOC_TABLE, 'entityType = :d AND entityId = :id', {}, { ':d': 'DRIVER', ':id': driverId })
}
async function getApplication(driverId: string) {
  const rows = await scan(APP_TABLE, 'driverId = :id', {}, { ':id': driverId })
  return rows[0] as Record<string, unknown> | undefined
}

export const handler = async (event: FnUrlEvent) => {
  const origin = event.headers?.origin ?? event.headers?.Origin
  const method = event.requestContext?.http?.method ?? 'POST'
  if (method === 'OPTIONS') return reply(200, { ok: true }, origin)

  const sourceIp = event.requestContext?.http?.sourceIp ?? 'unknown'
  let req: { token?: string; action?: string; payload?: Record<string, unknown> }
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf-8') : (event.body ?? '{}')
    req = JSON.parse(raw)
  } catch {
    return reply(400, { error: 'Bad JSON' }, origin)
  }

  try {
    const invite = await validateInvite(req.token ?? '')
    const driverId = invite.driverId
    const action = req.action
    const payload = req.payload ?? {}

    switch (action) {
      case 'getOnboardingState': {
        await touchInvite(invite, invite.status === 'SENT' ? { status: 'OPENED', openedAt: new Date().toISOString() } : {})
        const driverRows = await scan(DRIVER_TABLE, 'id = :id', {}, { ':id': driverId })
        const driver = driverRows[0] as Record<string, unknown> | undefined
        const firstName = String(driver?.name ?? 'there').split(' ')[0]
        const tasks = await getDriverTasks(driverId)
        const docs = await getDriverDocs(driverId)
        const app = await getApplication(driverId)

        // Phase-gating is judged over the driver's tasks PLUS the assigned truck's tasks
        // (Phase 3–4 truck setup), matching the staff pipeline's currentPhaseNumber so both
        // sides agree. Truck tasks are never shown to the driver — only used for gating.
        const assignedTruckId = driver?.assignedTruckId ? String(driver.assignedTruckId) : ''
        const truckTasks = assignedTruckId
          ? await scan(TASK_TABLE, 'entityType = :t AND entityId = :id', {}, { ':t': 'TRUCK', ':id': assignedTruckId })
          : []
        const gatingTasks = [...tasks, ...truckTasks]

        const latestRejectedByType = new Map<string, string>()
        for (const d of docs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
          if (d.status === 'REJECTED' && d.rejectionReason) latestRejectedByType.set(String(d.documentType), String(d.rejectionReason))
        }

        const visible = tasks.filter((t) => t.driverVisible)
        const required = visible.filter((t) => t.required && t.status !== 'NOT_APPLICABLE')
        // Count submitted (pending-review) items as progress too, so the bar moves as the
        // driver uploads — not only after staff approve.
        const done = required.filter((t) => t.status === 'COMPLETE' || t.status === 'WAIVED' || t.status === 'PENDING_REVIEW').length
        const progressPct = required.length ? Math.round((done / required.length) * 100) : 0

        // ── Phase gating: the driver sees every phase, but only the CURRENT phase is
        // actionable; earlier phases are done and later phases are locked. currentPhase
        // is the lowest phase with a required task not yet finalized. A phase's own
        // completion is judged over ALL driver-entity tasks (office + driver), so the
        // next phase unlocks only once staff finalize the prior phase. PENDING_REVIEW is
        // deliberately NOT "done" — a phase stays current until its work is approved.
        const DONE = new Set(['COMPLETE', 'WAIVED', 'NOT_APPLICABLE'])
        const phaseDone = (p: number) =>
          gatingTasks.filter((t) => Number(t.phase) === p && t.required).every((t) => DONE.has(String(t.status)))
        const phaseSet = [...new Set(gatingTasks.map((t) => (t.phase != null ? Number(t.phase) : NaN)).filter((n) => !Number.isNaN(n)))].sort((a, b) => a - b)
        let currentPhase = phaseSet.length ? phaseSet[phaseSet.length - 1] : 1
        for (const p of phaseSet) { if (!phaseDone(p)) { currentPhase = p; break } }

        const checklist = visible
          .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder))
          .map((t) => ({
            requirementKey: t.requirementKey,
            label: t.label,
            category: t.category,
            phase: t.phase != null ? Number(t.phase) : null,
            status: t.status,
            required: t.required,
            requiresDocument: t.requiresDocument,
            requiresExpiration: t.requiresExpiration,
            driverActionable: t.driverActionable,
            links: parseLinks(t.links),
            rejectionReason:
              t.requirementKey === 'employment_application' && app?.status === 'REJECTED'
                ? app?.rejectionReason ?? null
                : latestRejectedByType.get(String(t.requirementKey)) ?? null,
          }))

        return reply(200, {
          firstName,
          driverType: invite.driverType ?? driver?.driverType ?? null,
          progressPct,
          currentPhase,
          templateId: (tasks.find((t) => t.templateId)?.templateId as string | undefined) ?? null,
          application: app ? { status: app.status, draft: parseAppJson(app) } : { status: 'DRAFT', draft: null },
          checklist,
        }, origin)
      }

      case 'saveApplicationDraft': {
        await touchInvite(invite, invite.status === 'SENT' || invite.status === 'OPENED' ? { status: 'IN_PROGRESS' } : {})
        const existing = await getApplication(driverId)
        const now = new Date().toISOString()
        const draft = serializeAppJson({ ...(payload.draft as Record<string, unknown> ?? {}), driverId, status: 'DRAFT' })
        if (existing) {
          await ddb.send(UpdateCommandFromObject(APP_TABLE, { id: existing.id }, { ...draft, updatedAt: now }))
        } else {
          await ddb.send(new PutCommand({ TableName: APP_TABLE, Item: { id: randomUUID(), __typename: 'DriverApplication', ...draft, createdAt: now, updatedAt: now } }))
        }
        return reply(200, { ok: true }, origin)
      }

      case 'submitApplication': {
        const now = new Date().toISOString()
        const existing = await getApplication(driverId)
        const appData = serializeAppJson({
          ...(payload.application as Record<string, unknown> ?? {}),
          driverId, status: 'SUBMITTED',
          signedAt: now, ipAddress: sourceIp,
        })
        let appId: string
        if (existing) {
          appId = String(existing.id)
          await ddb.send(UpdateCommandFromObject(APP_TABLE, { id: appId }, { ...appData, updatedAt: now }))
        } else {
          appId = randomUUID()
          await ddb.send(new PutCommand({ TableName: APP_TABLE, Item: { id: appId, __typename: 'DriverApplication', ...appData, createdAt: now, updatedAt: now } }))
        }
        // employment_application task → PENDING_REVIEW
        const tasks = await getDriverTasks(driverId)
        const appTask = tasks.find((t) => t.requirementKey === 'employment_application')
        if (appTask) await ddb.send(UpdateCommandFromObject(TASK_TABLE, { id: appTask.id }, { status: 'PENDING_REVIEW', updatedAt: now }))
        await touchInvite(invite, { status: 'SUBMITTED' })
        await audit(driverId, 'application_submitted', { applicationId: appId })
        return reply(200, { ok: true }, origin)
      }

      case 'getUploadUrl': {
        const requirementKey = String(payload.requirementKey ?? '')
        const contentType = String(payload.contentType ?? '')
        const fileName = String(payload.fileName ?? 'upload')
        const size = Number(payload.size ?? 0)
        const tasks = await getDriverTasks(driverId)
        const task = tasks.find((t) => t.requirementKey === requirementKey)
        if (!task || !task.driverActionable) throw new PortalError(403, 'Not allowed for this item')
        if (!ACCEPTED_CONTENT_TYPES.includes(contentType)) throw new PortalError(415, 'Unsupported file type')
        if (size > MAX_UPLOAD_BYTES) throw new PortalError(413, 'File too large (max 15MB)')
        const safe = fileName.replace(/[^\w.\-]+/g, '_')
        const s3Key = `compliance/DRIVER/${driverId}/${requirementKey}/${Date.now()}-${safe}`
        const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, ContentType: contentType }), { expiresIn: 300 })
        return reply(200, { uploadUrl: url, s3Key }, origin)
      }

      case 'confirmUpload': {
        const requirementKey = String(payload.requirementKey ?? '')
        const s3Key = String(payload.s3Key ?? '')
        const expirationDate = (payload.expirationDate as string) || null
        const tasks = await getDriverTasks(driverId)
        const task = tasks.find((t) => t.requirementKey === requirementKey)
        if (!task || !task.driverActionable) throw new PortalError(403, 'Not allowed for this item')
        if (!s3Key.startsWith(`compliance/DRIVER/${driverId}/`)) throw new PortalError(400, 'Invalid key')
        const now = new Date().toISOString()
        const docId = randomUUID()
        await ddb.send(new PutCommand({
          TableName: DOC_TABLE,
          Item: {
            id: docId, __typename: 'ComplianceDocument', entityType: 'DRIVER', entityId: driverId,
            documentType: requirementKey, title: String(task.label), s3Key, expirationDate,
            status: 'PENDING_REVIEW', uploadedBy: 'DRIVER_PORTAL', createdAt: now, updatedAt: now,
          },
        }))
        await ddb.send(UpdateCommandFromObject(TASK_TABLE, { id: task.id }, { status: 'PENDING_REVIEW', complianceDocumentId: docId, updatedAt: now }))
        await touchInvite(invite, {})
        await audit(driverId, 'document_uploaded', { documentType: requirementKey, source: 'DRIVER_PORTAL' })
        return reply(200, { ok: true }, origin)
      }

      case 'eSign': {
        const requirementKey = String(payload.requirementKey ?? '')
        const signatureName = String(payload.signatureName ?? '').trim()
        // Checkbox items (e.g. "date drug test completed") confirm with a date instead of a name.
        const completedDate = (payload.completedDate as string) || null
        if (!signatureName && !completedDate) throw new PortalError(400, 'Signature or completion date required')
        const tasks = await getDriverTasks(driverId)
        const task = tasks.find((t) => t.requirementKey === requirementKey)
        if (!task || !task.driverActionable) throw new PortalError(403, 'Not allowed for this item')
        const now = new Date().toISOString()
        const docId = randomUUID()
        await ddb.send(new PutCommand({
          TableName: DOC_TABLE,
          Item: {
            id: docId, __typename: 'ComplianceDocument', entityType: 'DRIVER', entityId: driverId,
            documentType: requirementKey, title: String(task.label),
            ...(completedDate ? { issueDate: completedDate } : {}),
            status: 'PENDING_REVIEW', uploadedBy: 'DRIVER_PORTAL',
            notes: signatureName
              ? `E-signed by ${signatureName} at ${now} from ${sourceIp}`
              : `Marked complete${completedDate ? ` (completed ${completedDate})` : ''} at ${now} from ${sourceIp}`,
            createdAt: now, updatedAt: now,
          },
        }))
        await ddb.send(UpdateCommandFromObject(TASK_TABLE, { id: task.id }, { status: 'PENDING_REVIEW', complianceDocumentId: docId, updatedAt: now }))
        await touchInvite(invite, {})
        await audit(driverId, 'document_uploaded', { eSign: requirementKey, completedDate, source: 'DRIVER_PORTAL' })
        return reply(200, { ok: true }, origin)
      }

      default:
        return reply(400, { error: `Unknown action: ${action}` }, origin)
    }
  } catch (err) {
    if (err instanceof PortalError) return reply(err.status, { error: err.message }, origin)
    console.error('[onboarding-portal-api] error', err)
    return reply(500, { error: 'Internal error' }, origin)
  }
}

// Small helper: build an UpdateCommand that SETs each key of `attrs`.
function UpdateCommandFromObject(table: string, key: Record<string, unknown>, attrs: Record<string, unknown>) {
  const sets: string[] = []
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  Object.entries(attrs).forEach(([k, v], i) => {
    names[`#a${i}`] = k
    values[`:a${i}`] = v
    sets.push(`#a${i} = :a${i}`)
  })
  return new UpdateCommand({
    TableName: table, Key: key,
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  })
}
