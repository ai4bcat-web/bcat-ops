// Data-access layer for the DOT compliance & onboarding models.
// Kept separate from apiClient.ts (which is already large) following the same
// pattern as commandCenterClient.ts / intakeSync.ts. Hooks in src/hooks/ call this.
import { generateClient } from 'aws-amplify/data'
import { uploadData, getUrl } from 'aws-amplify/storage'
import type {
  ComplianceEntityType,
  OnboardingInvite,
  DriverApplicationRecord,
  ComplianceDocument,
  ComplianceDocumentStatus,
  OnboardingTask,
  OnboardingTaskStatus,
  ComplianceAlert,
  EscalationRule,
  ComplianceSettings,
} from '@/types'

const client = generateClient()

type GraphQLResult<T> = { data: T }
// graphql() has overloaded generics; this extracts its options param so we can pass
// dynamically-built variables (Record<string, unknown>) without `any`.
type GqlOptions = Parameters<typeof client.graphql>[0]

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const result = (await client.graphql({ query, variables } as unknown as GqlOptions)) as GraphQLResult<T>
  return result.data
}

// ── Field selection sets ────────────────────────────────────────────────────────

const INVITE_FIELDS = `
  id driverId email driverType token status expiresAt
  sentAt openedAt lastActivityAt requestCount createdAt updatedAt
`

const APPLICATION_FIELDS = `
  id driverId legalName dob ssnLast4 phone currentAddress addressHistory
  cdlNumber cdlState cdlClass endorsements cdlExpiration priorLicenses
  employmentHistory accidents violations cdlIssuedAfterFeb2022 eldtProviderName
  signatureName signedAt ipAddress status reviewedBy reviewedAt rejectionReason
  createdAt updatedAt
`

const DOCUMENT_FIELDS = `
  id entityType entityId documentType title s3Key issueDate expirationDate
  status uploadedBy rejectionReason waivedReason notes verifiedBy verifiedAt
  createdAt updatedAt
`

const TASK_FIELDS = `
  id entityType entityId requirementKey label category required requiresDocument
  requiresExpiration driverVisible driverActionable status completedBy completedAt
  complianceDocumentId sortOrder createdAt updatedAt
`

const ALERT_FIELDS = `
  id entityType entityId entityName documentType documentTitle complianceDocumentId
  expirationDate severity acknowledged acknowledgedBy acknowledgedAt emailSentAt
  resolvedAt createdAt updatedAt
`

const ESCALATION_FIELDS = `
  id documentType daysBeforeExpiration recipients templateKey active createdAt updatedAt
`

const SETTINGS_FIELDS = `
  id settingsKey portalEmailsPaused escalationEmailsPaused managerEmails createdAt updatedAt
`

// The DriverApplication JSON columns — stringify on write, parse on read.
const APP_JSON_FIELDS = [
  'addressHistory',
  'priorLicenses',
  'employmentHistory',
  'accidents',
  'violations',
] as const

// ── OnboardingInvite ──────────────────────────────────────────────────────────

export async function listOnboardingInvitesByDriver(driverId: string): Promise<OnboardingInvite[]> {
  const data = await gql<{ listOnboardingInviteByDriverId: { items: OnboardingInvite[] } }>(
    `query ($driverId: String!) {
      listOnboardingInviteByDriverId(driverId: $driverId, limit: 100) { items { ${INVITE_FIELDS} } }
    }`,
    { driverId },
  )
  return data.listOnboardingInviteByDriverId.items ?? []
}

export async function getInviteByToken(token: string): Promise<OnboardingInvite | null> {
  const data = await gql<{ listOnboardingInviteByToken: { items: OnboardingInvite[] } }>(
    `query ($token: String!) {
      listOnboardingInviteByToken(token: $token, limit: 1) { items { ${INVITE_FIELDS} } }
    }`,
    { token },
  )
  return data.listOnboardingInviteByToken.items?.[0] ?? null
}

export async function createOnboardingInvite(
  input: Omit<OnboardingInvite, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<OnboardingInvite> {
  const data = await gql<{ createOnboardingInvite: OnboardingInvite }>(
    `mutation ($input: CreateOnboardingInviteInput!) {
      createOnboardingInvite(input: $input) { ${INVITE_FIELDS} }
    }`,
    { input },
  )
  return data.createOnboardingInvite
}

export async function updateOnboardingInvite(
  id: string,
  patch: Partial<Omit<OnboardingInvite, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<OnboardingInvite> {
  const data = await gql<{ updateOnboardingInvite: OnboardingInvite }>(
    `mutation ($input: UpdateOnboardingInviteInput!) {
      updateOnboardingInvite(input: $input) { ${INVITE_FIELDS} }
    }`,
    { input: { id, ...patch } },
  )
  return data.updateOnboardingInvite
}

// ── DriverApplication ───────────────────────────────────────────────────────────

function deserializeApplication(
  raw: Record<string, unknown> | null,
): DriverApplicationRecord | null {
  if (!raw) return null
  const out = { ...raw } as Record<string, unknown>
  for (const f of APP_JSON_FIELDS) {
    const v = out[f]
    if (typeof v === 'string') {
      try {
        out[f] = JSON.parse(v)
      } catch {
        out[f] = null
      }
    }
  }
  return out as unknown as DriverApplicationRecord
}

function serializeApplicationInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...input }
  for (const f of APP_JSON_FIELDS) {
    if (f in out && out[f] !== undefined) out[f] = JSON.stringify(out[f] ?? null)
  }
  return out
}

export async function getApplicationByDriver(
  driverId: string,
): Promise<DriverApplicationRecord | null> {
  const data = await gql<{ listDriverApplicationByDriverId: { items: Record<string, unknown>[] } }>(
    `query ($driverId: String!) {
      listDriverApplicationByDriverId(driverId: $driverId, limit: 1) { items { ${APPLICATION_FIELDS} } }
    }`,
    { driverId },
  )
  return deserializeApplication(data.listDriverApplicationByDriverId.items?.[0] ?? null)
}

export async function createDriverApplication(
  input: Partial<DriverApplicationRecord> & { driverId: string; status: DriverApplicationRecord['status'] },
): Promise<DriverApplicationRecord> {
  const data = await gql<{ createDriverApplication: Record<string, unknown> }>(
    `mutation ($input: CreateDriverApplicationInput!) {
      createDriverApplication(input: $input) { ${APPLICATION_FIELDS} }
    }`,
    { input: serializeApplicationInput(input) },
  )
  return deserializeApplication(data.createDriverApplication)!
}

export async function updateDriverApplication(
  id: string,
  patch: Partial<DriverApplicationRecord>,
): Promise<DriverApplicationRecord> {
  const data = await gql<{ updateDriverApplication: Record<string, unknown> }>(
    `mutation ($input: UpdateDriverApplicationInput!) {
      updateDriverApplication(input: $input) { ${APPLICATION_FIELDS} }
    }`,
    { input: serializeApplicationInput({ id, ...patch }) },
  )
  return deserializeApplication(data.updateDriverApplication)!
}

// ── ComplianceDocument ──────────────────────────────────────────────────────────

export async function listComplianceDocuments(
  entityType: ComplianceEntityType,
  entityId: string,
): Promise<ComplianceDocument[]> {
  const data = await gql<{ listComplianceDocumentByEntityId: { items: ComplianceDocument[] } }>(
    `query ($entityId: String!) {
      listComplianceDocumentByEntityId(entityId: $entityId, limit: 500) { items { ${DOCUMENT_FIELDS} } }
    }`,
    { entityId },
  )
  // entityId is unique per entity but documents for a truck and driver could collide if ids
  // overlap; filter by entityType to be safe.
  return (data.listComplianceDocumentByEntityId.items ?? []).filter((d) => d.entityType === entityType)
}

export async function listComplianceDocumentsByStatus(
  status: ComplianceDocumentStatus,
): Promise<ComplianceDocument[]> {
  const data = await gql<{ listComplianceDocuments: { items: ComplianceDocument[] } }>(
    `query ($filter: ModelComplianceDocumentFilterInput) {
      listComplianceDocuments(filter: $filter, limit: 1000) { items { ${DOCUMENT_FIELDS} } }
    }`,
    { filter: { status: { eq: status } } },
  )
  return data.listComplianceDocuments.items ?? []
}

export async function listAllComplianceDocuments(): Promise<ComplianceDocument[]> {
  const data = await gql<{ listComplianceDocuments: { items: ComplianceDocument[] } }>(
    `query { listComplianceDocuments(limit: 5000) { items { ${DOCUMENT_FIELDS} } } }`,
  )
  return data.listComplianceDocuments.items ?? []
}

export async function createComplianceDocument(
  input: Omit<ComplianceDocument, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<ComplianceDocument> {
  const data = await gql<{ createComplianceDocument: ComplianceDocument }>(
    `mutation ($input: CreateComplianceDocumentInput!) {
      createComplianceDocument(input: $input) { ${DOCUMENT_FIELDS} }
    }`,
    { input },
  )
  return data.createComplianceDocument
}

export async function updateComplianceDocument(
  id: string,
  patch: Partial<Omit<ComplianceDocument, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<ComplianceDocument> {
  const data = await gql<{ updateComplianceDocument: ComplianceDocument }>(
    `mutation ($input: UpdateComplianceDocumentInput!) {
      updateComplianceDocument(input: $input) { ${DOCUMENT_FIELDS} }
    }`,
    { input: { id, ...patch } },
  )
  return data.updateComplianceDocument
}

// ── OnboardingTask ──────────────────────────────────────────────────────────────

export async function listOnboardingTasks(
  entityType: ComplianceEntityType,
  entityId: string,
): Promise<OnboardingTask[]> {
  const data = await gql<{ listOnboardingTaskByEntityId: { items: OnboardingTask[] } }>(
    `query ($entityId: String!) {
      listOnboardingTaskByEntityId(entityId: $entityId, limit: 500) { items { ${TASK_FIELDS} } }
    }`,
    { entityId },
  )
  return (data.listOnboardingTaskByEntityId.items ?? [])
    .filter((t) => t.entityType === entityType)
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export async function createOnboardingTask(
  input: Omit<OnboardingTask, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<OnboardingTask> {
  const data = await gql<{ createOnboardingTask: OnboardingTask }>(
    `mutation ($input: CreateOnboardingTaskInput!) {
      createOnboardingTask(input: $input) { ${TASK_FIELDS} }
    }`,
    { input },
  )
  return data.createOnboardingTask
}

export async function updateOnboardingTask(
  id: string,
  patch: Partial<Omit<OnboardingTask, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<OnboardingTask> {
  const data = await gql<{ updateOnboardingTask: OnboardingTask }>(
    `mutation ($input: UpdateOnboardingTaskInput!) {
      updateOnboardingTask(input: $input) { ${TASK_FIELDS} }
    }`,
    { input: { id, ...patch } },
  )
  return data.updateOnboardingTask
}

/** Set a task's status and stamp completion when terminal. */
export async function setTaskStatus(
  id: string,
  status: OnboardingTaskStatus,
  opts?: { completedBy?: string; complianceDocumentId?: string },
): Promise<OnboardingTask> {
  const terminal = status === 'COMPLETE' || status === 'WAIVED' || status === 'NOT_APPLICABLE'
  return updateOnboardingTask(id, {
    status,
    completedBy: opts?.completedBy,
    completedAt: terminal ? new Date().toISOString() : null,
    ...(opts?.complianceDocumentId ? { complianceDocumentId: opts.complianceDocumentId } : {}),
  })
}

// ── ComplianceAlert ─────────────────────────────────────────────────────────────

export async function listComplianceAlerts(): Promise<ComplianceAlert[]> {
  const data = await gql<{ listComplianceAlerts: { items: ComplianceAlert[] } }>(
    `query { listComplianceAlerts(limit: 5000) { items { ${ALERT_FIELDS} } } }`,
  )
  return data.listComplianceAlerts.items ?? []
}

export async function createComplianceAlert(
  input: Omit<ComplianceAlert, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<ComplianceAlert> {
  const data = await gql<{ createComplianceAlert: ComplianceAlert }>(
    `mutation ($input: CreateComplianceAlertInput!) {
      createComplianceAlert(input: $input) { ${ALERT_FIELDS} }
    }`,
    { input },
  )
  return data.createComplianceAlert
}

export async function updateComplianceAlert(
  id: string,
  patch: Partial<Omit<ComplianceAlert, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<ComplianceAlert> {
  const data = await gql<{ updateComplianceAlert: ComplianceAlert }>(
    `mutation ($input: UpdateComplianceAlertInput!) {
      updateComplianceAlert(input: $input) { ${ALERT_FIELDS} }
    }`,
    { input: { id, ...patch } },
  )
  return data.updateComplianceAlert
}

// ── EscalationRule ──────────────────────────────────────────────────────────────

export async function listEscalationRules(): Promise<EscalationRule[]> {
  const data = await gql<{ listEscalationRules: { items: EscalationRule[] } }>(
    `query { listEscalationRules(limit: 200) { items { ${ESCALATION_FIELDS} } } }`,
  )
  return data.listEscalationRules.items ?? []
}

export async function createEscalationRule(
  input: Omit<EscalationRule, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<EscalationRule> {
  const data = await gql<{ createEscalationRule: EscalationRule }>(
    `mutation ($input: CreateEscalationRuleInput!) {
      createEscalationRule(input: $input) { ${ESCALATION_FIELDS} }
    }`,
    { input },
  )
  return data.createEscalationRule
}

export async function updateEscalationRule(
  id: string,
  patch: Partial<Omit<EscalationRule, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<EscalationRule> {
  const data = await gql<{ updateEscalationRule: EscalationRule }>(
    `mutation ($input: UpdateEscalationRuleInput!) {
      updateEscalationRule(input: $input) { ${ESCALATION_FIELDS} }
    }`,
    { input: { id, ...patch } },
  )
  return data.updateEscalationRule
}

export async function deleteEscalationRule(id: string): Promise<void> {
  await gql(`mutation ($input: DeleteEscalationRuleInput!) { deleteEscalationRule(input: $input) { id } }`, {
    input: { id },
  })
}

// ── ComplianceSettings (single GLOBAL row) ──────────────────────────────────────

const GLOBAL_SETTINGS_KEY = 'GLOBAL'

export async function getComplianceSettings(): Promise<ComplianceSettings | null> {
  const data = await gql<{ listComplianceSettingsBySettingsKey: { items: ComplianceSettings[] } }>(
    `query ($settingsKey: String!) {
      listComplianceSettingsBySettingsKey(settingsKey: $settingsKey, limit: 1) { items { ${SETTINGS_FIELDS} } }
    }`,
    { settingsKey: GLOBAL_SETTINGS_KEY },
  )
  return data.listComplianceSettingsBySettingsKey.items?.[0] ?? null
}

/** Returns the GLOBAL settings row, creating it (both kill switches PAUSED) if absent. */
export async function ensureComplianceSettings(): Promise<ComplianceSettings> {
  const existing = await getComplianceSettings()
  if (existing) return existing
  const data = await gql<{ createComplianceSettings: ComplianceSettings }>(
    `mutation ($input: CreateComplianceSettingsInput!) {
      createComplianceSettings(input: $input) { ${SETTINGS_FIELDS} }
    }`,
    {
      input: {
        settingsKey: GLOBAL_SETTINGS_KEY,
        portalEmailsPaused: true, // default PAUSED
        escalationEmailsPaused: true, // default PAUSED
        managerEmails: [],
      },
    },
  )
  return data.createComplianceSettings
}

export async function updateComplianceSettings(
  id: string,
  patch: Partial<Omit<ComplianceSettings, 'id' | 'settingsKey' | 'createdAt' | 'updatedAt'>>,
): Promise<ComplianceSettings> {
  const data = await gql<{ updateComplianceSettings: ComplianceSettings }>(
    `mutation ($input: UpdateComplianceSettingsInput!) {
      updateComplianceSettings(input: $input) { ${SETTINGS_FIELDS} }
    }`,
    { input: { id, ...patch } },
  )
  return data.updateComplianceSettings
}

// ── Audit log (compliance-specific entityTypes/actions) ─────────────────────────

export type ComplianceAuditAction =
  | 'invite_sent'
  | 'invite_revoked'
  | 'invite_resent'
  | 'invite_extended'
  | 'application_submitted'
  | 'document_uploaded'
  | 'document_approved'
  | 'document_rejected'
  | 'onboarding_started'
  | 'onboarding_completed'
  | 'alert_acknowledged'

export async function writeComplianceAudit(entry: {
  entityType: ComplianceEntityType
  entityId: string
  action: ComplianceAuditAction
  user: string
  changes: Record<string, unknown>
}): Promise<void> {
  try {
    await gql(
      `mutation ($input: CreateAuditLogInput!) { createAuditLog(input: $input) { id } }`,
      { input: { ...entry, changes: JSON.stringify(entry.changes) } },
    )
  } catch (err) {
    console.error('[writeComplianceAudit] failed', err)
  }
}

// ── S3 document storage ─────────────────────────────────────────────────────────

export const ACCEPTED_DOC_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
] as const

export const ACCEPTED_DOC_EXT = '.pdf,.jpg,.jpeg,.png,.heic,.heif'
export const MAX_DOC_BYTES = 15 * 1024 * 1024 // 15MB

export function isAcceptedDoc(file: File): boolean {
  const okType = (ACCEPTED_DOC_MIME as readonly string[]).includes(file.type)
  // Some browsers report empty type for HEIC — fall back to extension check.
  const okExt = /\.(pdf|jpe?g|png|heic|heif)$/i.test(file.name)
  return (okType || okExt) && file.size <= MAX_DOC_BYTES
}

/**
 * Upload under compliance/{entityType}/{entityId}/{documentType}/{timestamp}-{filename}.
 * Replacing a document writes a new key (old one preserved for audit history).
 */
export async function uploadComplianceDocument(
  entityType: ComplianceEntityType,
  entityId: string,
  documentType: string,
  file: File,
): Promise<string> {
  const safeName = file.name.replace(/[^\w.\-]+/g, '_')
  const key = `compliance/${entityType}/${entityId}/${documentType}/${Date.now()}-${safeName}`
  await uploadData({ path: key, data: file, options: { contentType: file.type || 'application/octet-stream' } }).result
  return key
}

export async function getComplianceDocUrl(s3Key: string): Promise<string> {
  const result = await getUrl({ path: s3Key, options: { expiresIn: 3600 } })
  return result.url.toString()
}

// ── Invite token + portal URL ───────────────────────────────────────────────────

/** 32 bytes of crypto-random entropy, URL-safe base64 (no padding). */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let bin = ''
  bytes.forEach((b) => { bin += String.fromCharCode(b) })
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const DEFAULT_INVITE_TTL_DAYS = 14

export function inviteExpiry(days = DEFAULT_INVITE_TTL_DAYS, from = new Date()): string {
  const d = new Date(from)
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

/** Permanent portal link for an invite token (works on localhost and prod). */
export function buildPortalUrl(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/onboard/${token}`
}
