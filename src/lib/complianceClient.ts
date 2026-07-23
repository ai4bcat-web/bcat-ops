// Data-access layer for the DOT compliance & onboarding models.
// Kept separate from apiClient.ts (which is already large) following the same
// pattern as commandCenterClient.ts / intakeSync.ts. Hooks in src/hooks/ call this.
import { generateClient } from 'aws-amplify/data'
import { uploadData, getUrl } from 'aws-amplify/storage'
import {
  getDriverRequirements,
  getTruckRequirements,
  getRequirement,
  CATALOG_VERSION,
  type ComplianceRequirement,
  type DriverType,
  type TruckOwnershipType,
} from '@/lib/complianceRequirements'
import {
  getOnboardingTemplate,
  type OnboardingTemplate,
  type OnboardingPhase,
  type TemplateEntry,
  type TaskOwner,
} from '@/lib/onboardingTemplates'
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
  EscalationEmailLog,
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
  complianceDocumentId sortOrder phase owner assignee dueDate templateId catalogVersion
  createdAt updatedAt
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

/** Every OnboardingInvite. Used by the onboarding pipeline roster to show invite status. */
export async function listAllOnboardingInvites(): Promise<OnboardingInvite[]> {
  const data = await gql<{ listOnboardingInvites: { items: OnboardingInvite[] } }>(
    `query { listOnboardingInvites(limit: 5000) { items { ${INVITE_FIELDS} } } }`,
  )
  return data.listOnboardingInvites.items ?? []
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

export async function listApplicationsByStatus(
  status: DriverApplicationRecord['status'],
): Promise<DriverApplicationRecord[]> {
  const data = await gql<{ listDriverApplications: { items: Record<string, unknown>[] } }>(
    `query ($filter: ModelDriverApplicationFilterInput) {
      listDriverApplications(filter: $filter, limit: 1000) { items { ${APPLICATION_FIELDS} } }
    }`,
    { filter: { status: { eq: status } } },
  )
  return (data.listDriverApplications.items ?? []).map((r) => deserializeApplication(r)!).filter(Boolean)
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

export async function deleteComplianceDocument(id: string): Promise<void> {
  await gql(
    `mutation ($input: DeleteComplianceDocumentInput!) { deleteComplianceDocument(input: $input) { id } }`,
    { input: { id } },
  )
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

/** Every OnboardingTask (both entities). Used by the onboarding pipeline roster. */
export async function listAllOnboardingTasks(): Promise<OnboardingTask[]> {
  const data = await gql<{ listOnboardingTasks: { items: OnboardingTask[] } }>(
    `query { listOnboardingTasks(limit: 5000) { items { ${TASK_FIELDS} } } }`,
  )
  return data.listOnboardingTasks.items ?? []
}

export async function createOnboardingTask(
  input: Omit<OnboardingTask, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<OnboardingTask> {
  // links is an AWSJSON field — send it as a JSON string.
  const gqlInput = input.links != null ? { ...input, links: JSON.stringify(input.links) } : input
  const data = await gql<{ createOnboardingTask: OnboardingTask }>(
    `mutation ($input: CreateOnboardingTaskInput!) {
      createOnboardingTask(input: $input) { ${TASK_FIELDS} }
    }`,
    { input: gqlInput },
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

/**
 * Initial status for a generated task: optional items start NOT_APPLICABLE; required
 * driver-actionable items wait on the driver; everything else is internal (PENDING).
 */
export function initialTaskStatus(req: ComplianceRequirement, entityType: ComplianceEntityType): OnboardingTaskStatus {
  if (!req.required) return 'NOT_APPLICABLE'
  if (entityType === 'DRIVER' && req.driverActionable) return 'AWAITING_DRIVER'
  return 'PENDING'
}

/**
 * Generate OnboardingTask records from the catalog for one entity. Idempotent:
 * existing tasks (by requirementKey) are skipped, so it is safe to re-run for backfill.
 */
export async function generateChecklist(params: {
  entityType: ComplianceEntityType
  entityId: string
  classification: DriverType | TruckOwnershipType
}): Promise<{ created: number; total: number; tasks: OnboardingTask[] }> {
  const { entityType, entityId, classification } = params
  const requirements =
    entityType === 'DRIVER'
      ? getDriverRequirements(classification as DriverType)
      : getTruckRequirements(classification as TruckOwnershipType)

  const existing = await listOnboardingTasks(entityType, entityId)
  const existingKeys = new Set(existing.map((t) => t.requirementKey))

  const created: OnboardingTask[] = []
  for (let i = 0; i < requirements.length; i++) {
    const req = requirements[i]
    if (existingKeys.has(req.key)) continue
    created.push(
      await createOnboardingTask({
        entityType,
        entityId,
        requirementKey: req.key,
        label: req.label,
        category: req.category,
        required: req.required,
        requiresDocument: req.requiresDocument,
        requiresExpiration: req.requiresExpiration,
        driverVisible: entityType === 'DRIVER' ? req.driverVisible : false,
        driverActionable: entityType === 'DRIVER' ? req.driverActionable : false,
        status: initialTaskStatus(req, entityType),
        sortOrder: i,
      }),
    )
  }
  return { created: created.length, total: requirements.length, tasks: [...existing, ...created].sort((a, b) => a.sortOrder - b.sortOrder) }
}

// ── Phased template generation (Amazon driver onboarding) ────────────────────────
// These generate OnboardingTask records from an OnboardingTemplate. Unlike the flat
// generateChecklist(), a task here is keyed by (phase + requirementKey), so the same
// requirement can appear in two phases (e.g. occ_acc_or_workers_comp). Idempotent:
// re-running skips template tasks that already exist for that (phase, requirementKey).

function templateTaskKey(phase: number, requirementKey: string): string {
  return `${phase}:${requirementKey}`
}

/** Existing template-generated tasks, keyed by (phase, requirementKey), for idempotent regen. */
function existingTemplateKeys(tasks: OnboardingTask[]): Set<string> {
  const keys = new Set<string>()
  for (const t of tasks) {
    if (typeof t.phase === 'number') keys.add(templateTaskKey(t.phase, t.requirementKey))
  }
  return keys
}

function initialTemplateStatus(req: ComplianceRequirement, owner: TaskOwner): OnboardingTaskStatus {
  if (!req.required) return 'NOT_APPLICABLE'
  return owner === 'DRIVER' ? 'AWAITING_DRIVER' : 'PENDING'
}

function computeDueDate(phaseStart: string, days?: number): string | null {
  if (typeof days !== 'number') return null
  const d = new Date(`${phaseStart}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

interface BuiltTaskInput {
  input: Omit<OnboardingTask, 'id' | 'createdAt' | 'updatedAt'>
  phase: number
  requirementKey: string
}

/** Build the OnboardingTask input for one template entry, or null if the key is unknown. */
function buildTemplateTaskInput(params: {
  entityType: ComplianceEntityType
  entityId: string
  phase: number
  entry: TemplateEntry
  templateId: string
  sortOrder: number
  phaseStart: string
}): BuiltTaskInput | null {
  const { entityType, entityId, phase, entry, templateId, sortOrder, phaseStart } = params
  const req = getRequirement(entry.key)
  if (!req) {
    console.error('[buildTemplateTaskInput] unknown requirement key', entry.key)
    return null
  }
  const isDriverOwned = entityType === 'DRIVER' && entry.owner === 'DRIVER'
  // Visibility defaults to driver-owned, but the template editor can override it.
  const driverVisible = entry.driverVisible ?? isDriverOwned
  return {
    phase,
    requirementKey: entry.key,
    input: {
      entityType,
      entityId,
      requirementKey: entry.key,
      label: entry.label?.trim() || req.label,
      category: req.category,
      required: entry.required ?? req.required,
      requiresDocument: entry.requiresDocument ?? req.requiresDocument,
      requiresExpiration: req.requiresExpiration,
      driverVisible,
      driverActionable: isDriverOwned && driverVisible,
      status: initialTemplateStatus(req, entry.owner),
      sortOrder,
      phase,
      owner: entry.owner,
      assignee: entry.assignee ?? null,
      dueDate: computeDueDate(phaseStart, entry.dueDaysFromPhaseStart),
      templateId,
      catalogVersion: CATALOG_VERSION,
      // Edited template links win; otherwise fall back to the catalog's default links.
      links: entry.links ? [...entry.links] : (req.links ? [...req.links] : null),
    },
  }
}

/**
 * Generate a driver's phased checklist from a template. Only DRIVER-entity entries are
 * created here; TRUCK-entity entries are deferred to generateTruckTasksFromTemplate()
 * once Phase 2 completes. Idempotent by (phase, requirementKey).
 */
export async function generateTemplateChecklist(params: {
  driverId: string
  driverType: DriverType
  template: OnboardingTemplate
  phaseStart?: string
}): Promise<{ created: number; tasks: OnboardingTask[] }> {
  const { driverId, driverType, template } = params
  const phaseStart = params.phaseStart ?? new Date().toISOString().slice(0, 10)

  const existing = await listOnboardingTasks('DRIVER', driverId)
  const seen = existingTemplateKeys(existing)

  const created: OnboardingTask[] = []
  let sortOrder = 0
  for (const p of template.phases) {
    for (const entry of p.entries) {
      if ((entry.entity ?? 'DRIVER') !== 'DRIVER') continue
      if (entry.appliesToDriverType && entry.appliesToDriverType !== driverType) continue
      const built = buildTemplateTaskInput({
        entityType: 'DRIVER', entityId: driverId, phase: p.phase, entry,
        templateId: template.id, sortOrder: sortOrder++, phaseStart,
      })
      if (!built) continue
      if (seen.has(templateTaskKey(built.phase, built.requirementKey))) continue
      created.push(await createOnboardingTask(built.input))
    }
  }
  return {
    created: created.length,
    tasks: [...existing, ...created].sort((a, b) => a.sortOrder - b.sortOrder),
  }
}

/**
 * Generate the template's TRUCK-entity tasks against a truck. Called when a driver's
 * Phase 2 completes (the truck-link step). Idempotent by (phase, requirementKey).
 */
export async function generateTruckTasksFromTemplate(params: {
  truckId: string
  driverType: DriverType
  template: OnboardingTemplate
  phaseStart?: string
}): Promise<{ created: number; tasks: OnboardingTask[] }> {
  const { truckId, driverType, template } = params
  const phaseStart = params.phaseStart ?? new Date().toISOString().slice(0, 10)

  const existing = await listOnboardingTasks('TRUCK', truckId)
  const seen = existingTemplateKeys(existing)

  const created: OnboardingTask[] = []
  // Continue sortOrder above any existing tasks so truck tasks sort after seed items.
  let sortOrder = existing.reduce((max, t) => Math.max(max, t.sortOrder ?? 0), 0) + 1
  for (const p of template.phases) {
    for (const entry of p.entries) {
      if ((entry.entity ?? 'DRIVER') !== 'TRUCK') continue
      if (entry.appliesToDriverType && entry.appliesToDriverType !== driverType) continue
      const built = buildTemplateTaskInput({
        entityType: 'TRUCK', entityId: truckId, phase: p.phase, entry,
        templateId: template.id, sortOrder: sortOrder++, phaseStart,
      })
      if (!built) continue
      if (seen.has(templateTaskKey(built.phase, built.requirementKey))) continue
      created.push(await createOnboardingTask(built.input))
    }
  }
  return {
    created: created.length,
    tasks: [...existing, ...created].sort((a, b) => a.sortOrder - b.sortOrder),
  }
}

// ── Editable onboarding template config (OnboardingTemplateConfig) ────────────────
// A saved template overrides the code default so staff can edit what onboarding looks
// like. `phases` is stored as a JSON string (AWSJSON) — stringify on write, parse on read.

const TEMPLATE_CONFIG_FIELDS = `templateId label phases updatedBy createdAt updatedAt`

/** The saved (edited) template for an id, or null if none has been saved. */
export async function getTemplateConfig(templateId: string): Promise<OnboardingTemplate | null> {
  const data = await gql<{ getOnboardingTemplateConfig: { templateId: string; label?: string | null; phases?: unknown } | null }>(
    `query ($templateId: String!) { getOnboardingTemplateConfig(templateId: $templateId) { ${TEMPLATE_CONFIG_FIELDS} } }`,
    { templateId },
  )
  const rec = data.getOnboardingTemplateConfig
  if (!rec) return null
  let phases: OnboardingPhase[]
  try {
    phases = typeof rec.phases === 'string' ? JSON.parse(rec.phases) : ((rec.phases as OnboardingPhase[]) ?? [])
  } catch {
    phases = []
  }
  if (!phases.length) return null
  return { id: rec.templateId, label: rec.label ?? templateId, phases }
}

/** Upsert the edited template (create or update the single row for this templateId). */
export async function saveTemplateConfig(template: OnboardingTemplate, updatedBy?: string): Promise<void> {
  const existing = await gql<{ getOnboardingTemplateConfig: { templateId: string } | null }>(
    `query ($templateId: String!) { getOnboardingTemplateConfig(templateId: $templateId) { templateId } }`,
    { templateId: template.id },
  )
  const input = {
    templateId: template.id,
    label: template.label,
    phases: JSON.stringify(template.phases),
    updatedBy: updatedBy ?? null,
  }
  if (existing.getOnboardingTemplateConfig) {
    await gql(`mutation ($input: UpdateOnboardingTemplateConfigInput!) { updateOnboardingTemplateConfig(input: $input) { templateId } }`, { input })
  } else {
    await gql(`mutation ($input: CreateOnboardingTemplateConfigInput!) { createOnboardingTemplateConfig(input: $input) { templateId } }`, { input })
  }
}

/** Reset to the code default by deleting the saved override. */
export async function deleteTemplateConfig(templateId: string): Promise<void> {
  await gql(`mutation ($input: DeleteOnboardingTemplateConfigInput!) { deleteOnboardingTemplateConfig(input: $input) { templateId } }`, { input: { templateId } })
}

/** The EFFECTIVE template used by kickoff: the saved (edited) version if present, else the code default. */
export async function resolveOnboardingTemplate(templateId: string): Promise<OnboardingTemplate | undefined> {
  try {
    const cfg = await getTemplateConfig(templateId)
    if (cfg) return cfg
  } catch (e) {
    console.error('[resolveOnboardingTemplate] falling back to default', e)
  }
  return getOnboardingTemplate(templateId)
}

export async function deleteOnboardingTask(id: string): Promise<void> {
  await gql(`mutation ($input: DeleteOnboardingTaskInput!) { deleteOnboardingTask(input: $input) { id } }`, { input: { id } })
}

export async function deleteOnboardingInvite(id: string): Promise<void> {
  await gql(`mutation ($input: DeleteOnboardingInviteInput!) { deleteOnboardingInvite(input: $input) { id } }`, { input: { id } })
}

export async function deleteDriverApplication(id: string): Promise<void> {
  await gql(`mutation ($input: DeleteDriverApplicationInput!) { deleteDriverApplication(input: $input) { id } }`, { input: { id } })
}

/**
 * Hard-delete every onboarding record tied to a driver: tasks, invites, the application,
 * and uploaded compliance documents. Truck-entity tasks (on the assigned truck) are left
 * intact — they belong to the truck, not the candidate.
 */
export async function purgeCandidateOnboarding(driverId: string): Promise<void> {
  const [tasks, invites, docs, app] = await Promise.all([
    listOnboardingTasks('DRIVER', driverId),
    listOnboardingInvitesByDriver(driverId),
    listComplianceDocuments('DRIVER', driverId),
    getApplicationByDriver(driverId),
  ])
  await Promise.all([
    ...tasks.map((t) => deleteOnboardingTask(t.id)),
    ...invites.map((i) => deleteOnboardingInvite(i.id)),
    ...docs.map((d) => deleteComplianceDocument(d.id)),
    ...(app ? [deleteDriverApplication(app.id)] : []),
  ])
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

/** Default escalation ladder, seeded once when no rules exist. */
export const DEFAULT_ESCALATION_RULES: Omit<EscalationRule, 'id' | 'createdAt' | 'updatedAt'>[] = [
  { documentType: 'ALL', daysBeforeExpiration: 30, recipients: 'BOTH', templateKey: 'notice_30', active: true },
  { documentType: 'ALL', daysBeforeExpiration: 7, recipients: 'BOTH', templateKey: 'final_warning_7', active: true },
  { documentType: 'ALL', daysBeforeExpiration: 0, recipients: 'BOTH', templateKey: 'out_of_service_0', active: true },
]

/** Create the default rules if the table is empty. Returns the rules in effect. */
export async function seedDefaultEscalationRules(): Promise<EscalationRule[]> {
  const existing = await listEscalationRules()
  if (existing.length > 0) return existing
  const created: EscalationRule[] = []
  for (const r of DEFAULT_ESCALATION_RULES) created.push(await createEscalationRule(r))
  return created
}

// ── EscalationEmailLog ──────────────────────────────────────────────────────────

const ESCALATION_LOG_FIELDS = `
  id alertId entityType entityName documentType daysBeforeExpiration templateKey
  recipients sentAt createdAt updatedAt
`

export async function listEscalationEmailLogsByAlert(alertId: string): Promise<EscalationEmailLog[]> {
  const data = await gql<{ listEscalationEmailLogByAlertId: { items: EscalationEmailLog[] } }>(
    `query ($alertId: String!) {
      listEscalationEmailLogByAlertId(alertId: $alertId, limit: 100) { items { ${ESCALATION_LOG_FIELDS} } }
    }`,
    { alertId },
  )
  return (data.listEscalationEmailLogByAlertId.items ?? []).sort((a, b) => b.sentAt.localeCompare(a.sentAt))
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

// ── Onboarding emails (SES via custom mutation) ─────────────────────────────────

/**
 * Fire-and-forget driver-facing email. The backend honors the portalEmailsPaused
 * kill switch (default PAUSED) and no-ops while paused, so callers always succeed.
 */
export async function sendOnboardingEmail(args: {
  type: 'invite' | 'rejected' | 'declined' | 'complete'
  driverId?: string
  inviteId?: string
  itemLabel?: string
  reason?: string
}): Promise<void> {
  try {
    await gql(
      `mutation ($type: String!, $driverId: String, $inviteId: String, $itemLabel: String, $reason: String, $portalBaseUrl: String) {
        sendOnboardingEmail(type: $type, driverId: $driverId, inviteId: $inviteId, itemLabel: $itemLabel, reason: $reason, portalBaseUrl: $portalBaseUrl)
      }`,
      { ...args, portalBaseUrl: typeof window !== 'undefined' ? window.location.origin : '' },
    )
  } catch (err) {
    console.error('[sendOnboardingEmail] failed', err)
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
