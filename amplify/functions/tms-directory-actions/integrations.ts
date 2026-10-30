/**
 * Step J — the integration actions on tmsDirectoryActions.
 *
 * One `Integration` row per provider (`id` = the provider key), per issued API
 * client (`api:<clientId>`) and per received webhook (`evt:<PROVIDER>:<id>`,
 * written by tracking-api, read-only here).
 *
 * Three things this module must never do, and the tests assert each one:
 *  1. **No credential value reaches DynamoDB.** The row stores `credentialRef`
 *     (a pointer) and `credentialMask` (`[{ key, last4 }]`). The values live in
 *     one SecureString per provider under `/bcat/integrations/<poolId>/`.
 *  2. **No business record is touched.** This Lambda holds no grant on Shipment,
 *     Order, Load, Invoice or FactoringItem, and nothing here writes one. A STUB
 *     result writes exactly one `AuditLog` row and bumps two counters on the
 *     integration row — the only live factor path stays F's gated `SEND_TO_FACTOR`.
 *  3. **No row is ever deleted.** A provider is DISCONNECTED and an API client
 *     carries `revokedAt`; `DISCONNECT_INTEGRATION` removes an SSM parameter and
 *     nothing in DynamoDB.
 */
import {
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { randomBytes } from 'crypto'

import {
  PROVIDERS,
  credentialFieldsOf,
  descriptorOf,
  liveCapabilitiesOf,
  missingCredentials,
} from '../../../src/lib/integrations/registry'
import { stubAdapter } from '../../../src/lib/integrations/adapter'
import { healthFrom, modeOf } from '../../../src/lib/integrations/health'
import {
  mcpAdapter,
  mergeInsurancePolicies,
  type McpInsurance,
} from '../../../src/lib/integrations/mcpAdapter'
import { maskOf, redactSecrets, validateCredentials } from '../../../src/lib/integrations/secrets'
import { defaultSettingsOf, validateProviderSettings } from '../../../src/lib/integrations/settings'
import { mintClient } from '../_shared/openApi'
import {
  qboBillFor,
  qboInvoiceFor,
  qboPaymentFor,
  type QboBillInput,
  type QboInvoiceInput,
  type QboMappings,
  type QboPaymentInput,
} from '../../../src/lib/integrations/qboPayloads'
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  Capability,
  CredentialMaskEntry,
  IntegrationEvent,
  IntegrationHealthReason,
  IntegrationHealthStatus,
  ProviderDescriptor,
} from '../../../src/lib/integrations/types'
import {
  deletePageCredentials,
  parameterNameFor,
  readPageCredentials,
  readRawParameter,
  readStackSecret,
  readTwilioStatus,
  writePageCredentials,
  writeRawParameter,
} from '../_shared/integrationSecrets'
import { validateProvider, type ValidateOutcome } from '../_shared/integrationValidate'

// ── Contract with the handler ────────────────────────────────────────────────

export interface IntegrationCaller {
  email: string
  sub: string
  groups?: string[]
}

export interface IntegrationDeps {
  dynamo: DynamoDBClient
  integrationTableName: string
  carrierTableName: string
  writeAudit: (
    entityType: string,
    entityId: string,
    action: string,
    caller: IntegrationCaller,
    changes: Record<string, unknown>,
  ) => Promise<void>
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** Every action this module answers. The handler's union and `authorize` read it. */
export const INTEGRATION_ACTIONS = {
  LIST_INTEGRATIONS: true,
  CONNECT_INTEGRATION: true,
  VALIDATE_INTEGRATION: true,
  SAVE_INTEGRATION_SETTINGS: true,
  DISCONNECT_INTEGRATION: true,
  RUN_STUB: true,
  CONNECT_QUICKBOOKS: true,
  REFRESH_QUICKBOOKS: true,
  PREVIEW_QBO_SYNC: true,
  ISSUE_API_CLIENT: true,
  REVOKE_API_CLIENT: true,
  MYCARRIERPACKETS_VALIDATE: true,
  MYCARRIERPACKETS_SYNC_CARRIER: true,
  MYCARRIERPACKETS_SYNC_ALL: true,
} as const

export type IntegrationActionName = keyof typeof INTEGRATION_ACTIONS

// ── Local input helpers ──────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString()
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string') throw new Error(`${label}.${key} must be a string`)
    out[key] = raw
  }
  return out
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

/**
 * An `a.json()` column is a map when the raw SDK wrote it and an AWSJSON string
 * when AppSync did. Both shapes are on these tables; read either.
 */
function asJson<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed) as T
    } catch {
      return null
    }
  }
  return value as T
}

function isConditionalCheckFailed(err: unknown): boolean {
  const name = err instanceof Error ? err.name : ''
  const msg = err instanceof Error ? err.message : String(err)
  return name === 'ConditionalCheckFailedException' || msg.includes('ConditionalCheckFailed')
}

function conflict(label: string, cause: unknown): Error {
  const error = new Error(`This ${label} was changed by someone else — reload and try again.`)
  ;(error as Error & { cause?: unknown }).cause = cause
  return error
}

// ── The row ──────────────────────────────────────────────────────────────────

/** The `Integration` item as it sits on the table. */
export interface IntegrationRow extends Record<string, unknown> {
  id: string
  provider: string
  kind: 'PROVIDER' | 'API_CLIENT' | 'WEBHOOK_EVENT'
  mode: 'STUB' | 'LIVE'
  status: 'NOT_CONNECTED' | 'CONNECTED' | 'DISCONNECTED'
  health: 'UNKNOWN' | 'OK' | 'INVALID_CREDENTIALS' | 'UNABLE_TO_VERIFY'
  version: number
}

/** Newest first, and never more than this many — the Quote precedent. */
const MAX_EVENTS = 50

function descriptorOrThrow(key: string): ProviderDescriptor {
  const descriptor = descriptorOf(key)
  if (!descriptor) throw new Error(`Unknown integration provider: ${key}`)
  return descriptor
}

/** Where the credential lives, written on the row as a pointer — never a value. */
function credentialRefOf(descriptor: ProviderDescriptor): string | null {
  if (descriptor.credentialSource === 'STACK') {
    return descriptor.stackSecretNames.length > 0 ? descriptor.stackSecretNames.join(',') : null
  }
  if (descriptor.credentialSource === 'PAGE' || descriptor.credentialSource === 'OWN') {
    return parameterNameFor(descriptor.key)
  }
  if (descriptor.credentialSource === 'SCRIPT') return process.env.DISPATCH_PARAM_PATH ?? null
  return null
}

/** Which stack secrets this Lambda can actually see, and which are neutered. */
function stackPresence(): Record<string, boolean> {
  const present: Record<string, boolean> = {}
  for (const descriptor of PROVIDERS) {
    for (const name of descriptor.stackSecretNames) {
      const secret = readStackSecret(name)
      present[name] = secret.value != null && !secret.neutered
    }
  }
  return present
}

function seedRow(descriptor: ProviderDescriptor, caller: IntegrationCaller, now: string): IntegrationRow {
  const stackCreds: Record<string, string | null> = {}
  if (descriptor.credentialSource === 'STACK') {
    for (const name of descriptor.stackSecretNames) stackCreds[name] = readStackSecret(name).value
  }
  return {
    id: descriptor.key,
    __typename: 'Integration',
    provider: descriptor.key,
    kind: 'PROVIDER',
    category: descriptor.category,
    mode: modeOf(descriptor, stackCreds),
    credentialSource: descriptor.credentialSource,
    credentialRef: credentialRefOf(descriptor),
    credentialMask: null,
    status: 'NOT_CONNECTED',
    health: 'UNKNOWN',
    healthReason: null,
    healthDetail: null,
    lastCheckAt: null,
    lastOkAt: null,
    lastCheckBy: null,
    settings: defaultSettingsOf(descriptor),
    capabilities: [...descriptor.capabilities],
    lastStubAt: null,
    stubCount: 0,
    events: [],
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
}

async function getRow(deps: IntegrationDeps, id: string): Promise<IntegrationRow | null> {
  if (!deps.integrationTableName) throw new Error('Integration table name is not configured')
  const result = await deps.dynamo.send(
    new GetItemCommand({ TableName: deps.integrationTableName, Key: marshall({ id }), ConsistentRead: true }),
  )
  if (!result.Item) return null
  return unmarshall(result.Item) as IntegrationRow
}

async function requireRow(deps: IntegrationDeps, id: string): Promise<IntegrationRow> {
  const row = await getRow(deps, id)
  if (!row) throw new Error(`Integration not found: ${id} — open the Integrations page to create it.`)
  return row
}

/**
 * Write the whole row back under the version this call read. A second editor who
 * saved in between bumps it and this write is refused.
 */
async function putRow(
  deps: IntegrationDeps,
  item: Record<string, unknown>,
  expectedVersion: number | null,
  label: string,
): Promise<IntegrationRow> {
  try {
    await deps.dynamo.send(
      new PutItemCommand({
        TableName: deps.integrationTableName,
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression: expectedVersion == null ? 'attribute_not_exists(id)' : '#version = :expectedVersion',
        ExpressionAttributeNames: expectedVersion == null ? undefined : { '#version': 'version' },
        ExpressionAttributeValues:
          expectedVersion == null ? undefined : { ':expectedVersion': { N: String(expectedVersion) } },
      }),
    )
  } catch (err) {
    if (isConditionalCheckFailed(err)) throw conflict(label, err)
    throw err
  }
  return item as IntegrationRow
}

/**
 * Every provider and API-client row.
 *
 * Webhook receipts are filtered out in DynamoDB rather than in JavaScript: they
 * are short-lived idempotency records written by tracking-api, there can be one
 * per inbound event, and reading them back would make the Integrations page's
 * cost a function of webhook traffic. They expire on their own through `ttlEpoch`.
 */
async function scanRows(deps: IntegrationDeps): Promise<IntegrationRow[]> {
  if (!deps.integrationTableName) throw new Error('Integration table name is not configured')
  const items: IntegrationRow[] = []
  let startKey: Record<string, AttributeValue> | undefined
  do {
    const page: { Items?: Record<string, AttributeValue>[]; LastEvaluatedKey?: Record<string, AttributeValue> } =
      await deps.dynamo.send(
        new ScanCommand({
          TableName: deps.integrationTableName,
          FilterExpression: 'attribute_not_exists(#kind) OR #kind <> :receipt',
          ExpressionAttributeNames: { '#kind': 'kind' },
          ExpressionAttributeValues: { ':receipt': { S: 'WEBHOOK_EVENT' } },
          ExclusiveStartKey: startKey,
        }),
      )
    for (const item of page.Items ?? []) items.push(unmarshall(item) as IntegrationRow)
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return items
}

/** The row as the client receives it: JSON columns parsed, counters defaulted. */
function present(row: IntegrationRow, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    credentialMask: asJson<CredentialMaskEntry[]>(row.credentialMask) ?? null,
    settings: asJson<Record<string, unknown>>(row.settings) ?? {},
    events: asJson<IntegrationEvent[]>(row.events) ?? [],
    stubCount: typeof row.stubCount === 'number' ? row.stubCount : 0,
    ...extra,
  }
}

function appendEvent(row: IntegrationRow, event: IntegrationEvent): IntegrationEvent[] {
  const existing = asJson<IntegrationEvent[]>(row.events) ?? []
  return [event, ...existing].slice(0, MAX_EVENTS)
}

// ── Credentials ──────────────────────────────────────────────────────────────

/**
 * Everything the validator needs for this provider, by the key its live check
 * names. STACK reads the environment (the dev stack's neutered literal included,
 * so the check can refuse to call rather than pretend); PAGE reads the parameter.
 */
async function credentialsFor(descriptor: ProviderDescriptor): Promise<Record<string, string | null>> {
  if (descriptor.credentialSource === 'STACK') {
    const out: Record<string, string | null> = {}
    for (const name of descriptor.stackSecretNames) out[name] = readStackSecret(name).value
    return out
  }
  if (descriptor.credentialSource === 'PAGE' || descriptor.credentialSource === 'OWN') {
    return (await readPageCredentials(descriptor.key)) ?? {}
  }
  return {}
}

/** The values a message must never carry, longest first (redactSecrets sorts). */
function secretValuesOf(creds: Record<string, string | null | undefined>): string[] {
  return Object.values(creds).filter((v): v is string => typeof v === 'string' && v.length > 0)
}

function refuseNonPage(descriptor: ProviderDescriptor): never {
  switch (descriptor.credentialSource) {
    case 'STACK':
      throw new Error(
        `${descriptor.label} is managed by the stack — rotate with \`npx ampx secret set ${descriptor.stackSecretNames.join(' ') || descriptor.key}\`.`,
      )
    case 'SCRIPT':
      throw new Error(`${descriptor.label} is provisioned by \`scripts/dispatchTwilioSetup.mjs\`.`)
    case 'BRIDGE':
      throw new Error(
        `${descriptor.label} is inbound only — it is delivered by an Apps Script bridge and has nothing to connect here.`,
      )
    case 'OWN':
      throw new Error(`${descriptor.label} credentials are issued by BCAT — use Issue client instead.`)
    default:
      throw new Error(`${descriptor.label} takes no credentials.`)
  }
}

// ── Validate ─────────────────────────────────────────────────────────────────

const SKIPPED_BRIDGE: ValidateOutcome = {
  kind: 'SKIPPED',
  reason: 'NO_VALIDATE_ENDPOINT',
  message: 'Inbound only — health is the last message this bridge delivered, read on the page.',
}

async function outcomeFor(
  descriptor: ProviderDescriptor,
  creds: Record<string, string | null>,
  fetchImpl?: typeof fetch,
): Promise<ValidateOutcome> {
  if (descriptor.applicability === 'NOT_APPLICABLE') {
    return {
      kind: 'SKIPPED',
      reason: 'NOT_APPLICABLE',
      message: descriptor.notApplicableReason ?? 'Not applicable to BCAT.',
    }
  }
  if (descriptor.credentialSource === 'BRIDGE') return SKIPPED_BRIDGE
  if (descriptor.credentialSource === 'SCRIPT') {
    const twilio = await readTwilioStatus()
    if (!twilio.configured) {
      return {
        kind: 'SKIPPED',
        reason: 'NO_CREDENTIALS',
        message: `Not provisioned on this stack: ${twilio.missing.join(', ')} ${twilio.missing.length === 1 ? 'is' : 'are'} missing. Run scripts/dispatchTwilioSetup.mjs.`,
      }
    }
    // The dispatch Lambdas hold these values; this one reads names only, by design.
    return {
      kind: 'SKIPPED',
      reason: 'NO_VALIDATE_ENDPOINT',
      message: 'Provisioned — the dispatch Lambdas hold the credentials; this page never reads them.',
    }
  }
  return validateProvider(descriptor, creds, fetchImpl ?? fetch)
}

/** Run the check, stamp the row, append the event and write the audit row. */
async function runValidate(
  deps: IntegrationDeps,
  descriptor: ProviderDescriptor,
  row: IntegrationRow,
  caller: IntegrationCaller,
): Promise<IntegrationRow> {
  const creds = await credentialsFor(descriptor)
  const secrets = secretValuesOf(creds)
  const outcome = await outcomeFor(descriptor, creds, deps.fetchImpl)
  const now = nowIso()
  const health = healthFrom(outcome, now)
  // Belt and braces: validateProvider already redacts, but a message assembled
  // from a thrown error anywhere else must not be the first one that does not.
  const detail = health.detail ? redactSecrets(health.detail, secrets) : null

  const event: IntegrationEvent = {
    at: now,
    action: 'VALIDATE',
    by: caller.email,
    outcome: health.status,
    detail: detail ?? undefined,
  }
  const next: IntegrationRow = {
    ...row,
    // A credential that just answered is a connection, whatever wrote it down:
    // a STACK secret is never "connected" by a page action, so without this the
    // badge would read "Not connected" for a key that worked one second ago.
    // DISCONNECTED is left alone — that is a deliberate act, undone by a connect.
    status: health.status === 'OK' && row.status !== 'DISCONNECTED' ? 'CONNECTED' : row.status,
    mode: modeOf(descriptor, creds),
    health: health.status,
    healthReason: health.reason ?? null,
    healthDetail: detail,
    lastCheckAt: now,
    lastCheckBy: caller.email,
    lastOkAt: health.status === 'OK' ? now : (row.lastOkAt ?? null),
    events: appendEvent(row, event),
    updatedBy: caller.email,
    updatedAt: now,
    version: (row.version ?? 0) + 1,
  }
  const written = await putRow(deps, next, row.version ?? 0, 'integration')
  await deps.writeAudit('INTEGRATION', descriptor.key, 'VALIDATE_INTEGRATION', caller, {
    provider: descriptor.key,
    health: health.status,
    reason: health.reason ?? null,
    statusCode: outcome.statusCode ?? null,
  })
  return written
}

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * Every provider, creating the rows that do not exist yet.
 *
 * The owner-profile-on-first-list precedent: a conditional Put per missing row
 * means there is no seed script and no migration, and a second call writes
 * nothing because every row now exists.
 *
 * `missingCredentials` is computed here and returned on the payload rather than
 * stored: for a STACK provider the answer is a function of this Lambda's
 * environment, so a column would go stale the moment a secret is set.
 */
async function listIntegrations(
  deps: IntegrationDeps,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>[]> {
  const existing = await scanRows(deps)
  const byId: Record<string, IntegrationRow> = {}
  for (const row of existing) byId[row.id] = row

  const now = nowIso()
  for (const descriptor of PROVIDERS) {
    if (byId[descriptor.key]) continue
    const seeded = seedRow(descriptor, caller, now)
    try {
      await putRow(deps, seeded, null, 'integration')
      byId[descriptor.key] = seeded
    } catch (err) {
      // Two admins opening the page at once: whoever lost the race reads the
      // row the winner wrote rather than failing the whole list.
      if (!isConditionalCheckFailed(err) && !(err instanceof Error && err.message.includes('changed by someone else'))) {
        throw err
      }
      const found = await getRow(deps, descriptor.key)
      if (found) byId[descriptor.key] = found
    }
  }

  const stackPresent = stackPresence()
  const rows: Record<string, unknown>[] = []
  const add = (row: IntegrationRow): void => {
    const descriptor = descriptorOf(row.provider)
    const missing = descriptor
      ? missingCredentials(descriptor, asJson<CredentialMaskEntry[]>(row.credentialMask), stackPresent)
      : []
    rows.push(present(row, { missingCredentials: missing }))
  }
  // Spec §8.1 order first — the index page's category tabs and the build log's
  // missing-credential list both print it — then the issued API clients.
  for (const descriptor of PROVIDERS) {
    const row = byId[descriptor.key]
    if (row) add(row)
  }
  for (const row of Object.values(byId)) {
    // A webhook receipt is an idempotency record, not something the page lists.
    if (row.kind === 'WEBHOOK_EVENT' || row.kind === 'PROVIDER') continue
    add(row)
  }
  return rows
}

async function connectIntegration(
  deps: IntegrationDeps,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = descriptorOrThrow(requiredString(input.provider, 'provider'))
  if (descriptor.credentialSource !== 'PAGE') refuseNonPage(descriptor)

  const credentials = stringMap(input.credentials, 'credentials')
  if (Object.keys(credentials).length === 0) throw new Error('No credentials were entered')

  // The page sends only the fields that were TYPED — a masked field it did not
  // touch has no value to send — so the thing to validate is the object that
  // will end up stored, not the partial that arrived. Rotating one password
  // must not answer "the e-mail is required".
  const held = await readPageCredentials(descriptor.key)
  const merged: Record<string, string> = { ...(held ?? {}) }
  for (const [key, value] of Object.entries(credentials)) {
    if (value.trim()) merged[key] = value
  }
  const checked = validateCredentials(descriptor, merged)
  if (!checked.ok) throw new Error(checked.errors.join(' '))

  const existing = await getRow(deps, descriptor.key)
  const row = existing ?? seedRow(descriptor, caller, nowIso())
  const stored = await writePageCredentials(descriptor.key, credentials)
  const mask = maskOf(credentialFieldsOf(descriptor), stored)
  const now = nowIso()

  const next: IntegrationRow = {
    ...row,
    credentialSource: 'PAGE',
    credentialRef: parameterNameFor(descriptor.key),
    credentialMask: mask,
    status: 'CONNECTED',
    mode: modeOf(descriptor, stored),
    connectedAt: now,
    connectedBy: caller.email,
    disconnectedAt: null,
    disconnectedBy: null,
    events: appendEvent(row, {
      at: now,
      action: 'CONNECT',
      by: caller.email,
      outcome: 'CONNECTED',
      detail: `Credentials stored for ${Object.keys(credentials).sort().join(', ')}`,
    }),
    updatedBy: caller.email,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
  }
  const written = await putRow(deps, next, existing ? (existing.version ?? 0) : null, 'integration')
  // Field NAMES and last-4 masks only. A value never reaches an audit row.
  await deps.writeAudit('INTEGRATION', descriptor.key, 'CONNECT_INTEGRATION', caller, {
    provider: descriptor.key,
    fields: Object.keys(credentials).sort(),
    mask,
    parameter: parameterNameFor(descriptor.key),
  })
  // Validate in the same call so the first badge the admin sees is a real one.
  const validated = await runValidate(deps, descriptor, written, caller)
  return present(validated)
}

async function validateIntegration(
  deps: IntegrationDeps,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = descriptorOrThrow(requiredString(input.provider, 'provider'))
  const row = (await getRow(deps, descriptor.key)) ?? (await putRow(deps, seedRow(descriptor, caller, nowIso()), null, 'integration'))
  return present(await runValidate(deps, descriptor, row, caller))
}

async function saveIntegrationSettings(
  deps: IntegrationDeps,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = descriptorOrThrow(requiredString(input.provider, 'provider'))
  const settings = jsonObject(input.settings, 'settings')
  const checked = validateProviderSettings(descriptor, settings)
  if (!checked.ok) throw new Error(checked.errors.join(' '))

  const row = await requireRow(deps, descriptor.key)
  const expected = input.expectedVersion
  if (expected != null && Number(expected) !== (row.version ?? 0)) {
    throw conflict('integration', new Error('version mismatch'))
  }
  const now = nowIso()
  const next: IntegrationRow = {
    ...row,
    settings: checked.value,
    updatedBy: caller.email,
    updatedAt: now,
    version: (row.version ?? 0) + 1,
  }
  const written = await putRow(deps, next, row.version ?? 0, 'integration')
  await deps.writeAudit('INTEGRATION', descriptor.key, 'SAVE_INTEGRATION_SETTINGS', caller, {
    provider: descriptor.key,
    settings: checked.value,
  })
  return present(written)
}

async function disconnectIntegration(
  deps: IntegrationDeps,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = descriptorOrThrow(requiredString(input.provider, 'provider'))
  if (descriptor.credentialSource !== 'PAGE') refuseNonPage(descriptor)

  const row = await requireRow(deps, descriptor.key)
  await deletePageCredentials(descriptor.key)
  const now = nowIso()
  const next: IntegrationRow = {
    ...row,
    // The settings and the row itself are kept: the behaviour card an admin
    // filled in survives a credential rotation.
    credentialMask: null,
    status: 'DISCONNECTED',
    mode: 'STUB',
    health: 'UNKNOWN',
    healthReason: 'NO_CREDENTIALS',
    healthDetail: null,
    disconnectedAt: now,
    disconnectedBy: caller.email,
    events: appendEvent(row, {
      at: now,
      action: 'DISCONNECT',
      by: caller.email,
      outcome: 'DISCONNECTED',
      detail: 'Stored credentials removed; behaviour settings kept.',
    }),
    updatedBy: caller.email,
    updatedAt: now,
    version: (row.version ?? 0) + 1,
  }
  const written = await putRow(deps, next, row.version ?? 0, 'integration')
  await deps.writeAudit('INTEGRATION', descriptor.key, 'DISCONNECT_INTEGRATION', caller, {
    provider: descriptor.key,
    parameter: parameterNameFor(descriptor.key),
  })
  return present(written)
}

function capabilityFn(adapter: Adapter, capability: Capability):
  | ((ctx: AdapterContext, input: Record<string, unknown>) => Promise<AdapterResult>)
  | null {
  switch (capability) {
    case 'post':
      return adapter.post ?? null
    case 'track':
      return adapter.track ?? null
    case 'quote':
      return adapter.quote ?? null
    case 'factor':
      return adapter.factor ?? null
    case 'sync':
      return adapter.sync ?? null
    case 'connect':
      return adapter.connect ?? null
    default:
      return null
  }
}

/**
 * Run the descriptor's stub for one capability.
 *
 * It takes a SAMPLE and no record id, writes exactly one `AuditLog` row and
 * touches nothing but this integration row's two counters. That is the whole
 * reason a factoring stub can exist at all without being a second door into AR.
 */
async function runStub(
  deps: IntegrationDeps,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = descriptorOrThrow(requiredString(input.provider, 'provider'))
  const capability = requiredString(input.capability, 'capability') as Capability
  if (!descriptor.capabilities.includes(capability)) {
    throw new Error(`${descriptor.label} does not declare the ${capability} capability.`)
  }
  const row = await requireRow(deps, descriptor.key)
  // `mode` is the row's overall state; what decides this is whether a REAL
  // implementation of THIS capability exists. Motive is LIVE and its `track` is
  // real, but nothing implements a live `post` for it — and a provider whose
  // credentials are complete is still stub-only until something can call out.
  if (liveCapabilitiesOf(descriptor).includes(capability)) {
    const where = descriptor.liveLink ? ` — use ${descriptor.liveLink.label}.` : ' — use the real action.'
    throw new Error(`${descriptor.label} is live for ${capability}${where}`)
  }

  const adapter = stubAdapter(descriptor)
  const run = capabilityFn(adapter, capability)
  if (!run) throw new Error(`The ${descriptor.label} stub does not implement ${capability}.`)

  const now = nowIso()
  const ctx: AdapterContext = {
    provider: descriptor.key,
    // A stub never needs a credential, so it is never handed one.
    credentials: {},
    settings: asJson<Record<string, unknown>>(row.settings) ?? {},
    now,
  }
  const result = await run(ctx, jsonObject(input.sample, 'sample'))

  const updated = await deps.dynamo.send(
    new UpdateItemCommand({
      TableName: deps.integrationTableName,
      Key: marshall({ id: descriptor.key }),
      UpdateExpression: 'SET lastStubAt = :at, updatedAt = :at, updatedBy = :by ADD stubCount :one, #version :one',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: {
        ':at': { S: now },
        ':by': { S: caller.email },
        ':one': { N: '1' },
      },
      ReturnValues: 'ALL_NEW',
    }),
  )
  await deps.writeAudit('INTEGRATION', descriptor.key, `STUB_${capability.toUpperCase()}`, caller, {
    stub: true,
    provider: descriptor.key,
    summary: result.message,
  })
  const nextRow = updated.Attributes ? (unmarshall(updated.Attributes) as IntegrationRow) : row
  return { row: present(nextRow), result }
}

// ── QuickBooks ───────────────────────────────────────────────────────────────

const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const QBO_TIMEOUT_MS = 10_000

interface QboTokens {
  accessToken: string
  refreshToken: string
}

async function exchangeQboToken(
  clientId: string,
  clientSecret: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<QboTokens> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QBO_TIMEOUT_MS)
  let res: Response
  let text: string
  try {
    res = await fetchImpl(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    })
    text = await res.text()
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    // Never echo the request body: it carries the code and the client secret.
    throw new Error(`QuickBooks refused the token exchange (${res.status}).`)
  }
  const parsed = asJson<Record<string, unknown>>(text)
  const accessToken = parsed?.access_token
  const refreshToken = parsed?.refresh_token
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new Error('QuickBooks returned a token response without an access or refresh token.')
  }
  return { accessToken, refreshToken }
}

async function connectQuickBooks(
  deps: IntegrationDeps,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = descriptorOrThrow('QUICKBOOKS_ONLINE')
  const code = requiredString(input.code, 'code')
  const realmId = requiredString(input.realmId, 'realmId')
  const redirectUri = requiredString(input.redirectUri, 'redirectUri')

  const stored = await readPageCredentials(descriptor.key)
  const clientId = stored?.clientId
  const clientSecret = stored?.clientSecret
  if (!clientId || !clientSecret) {
    throw new Error('Save the QuickBooks client id and secret before connecting.')
  }

  const tokens = await exchangeQboToken(
    clientId,
    clientSecret,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    deps.fetchImpl ?? fetch,
  )
  // The tokens land in the SecureString beside the client id and nowhere else.
  const merged = await writePageCredentials(descriptor.key, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    realmId,
  })

  const existing = await getRow(deps, descriptor.key)
  const row = existing ?? seedRow(descriptor, caller, nowIso())
  const now = nowIso()
  const next: IntegrationRow = {
    ...row,
    credentialRef: parameterNameFor(descriptor.key),
    credentialMask: maskOf(credentialFieldsOf(descriptor), merged),
    status: 'CONNECTED',
    mode: modeOf(descriptor, merged),
    connectedAt: now,
    connectedBy: caller.email,
    disconnectedAt: null,
    disconnectedBy: null,
    events: appendEvent(row, {
      at: now,
      action: 'CONNECT_QUICKBOOKS',
      by: caller.email,
      outcome: 'CONNECTED',
      detail: `Company ${realmId}`,
    }),
    updatedBy: caller.email,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
  }
  const written = await putRow(deps, next, existing ? (existing.version ?? 0) : null, 'integration')
  await deps.writeAudit('INTEGRATION', descriptor.key, 'CONNECT_QUICKBOOKS', caller, {
    provider: descriptor.key,
    realmId,
    parameter: parameterNameFor(descriptor.key),
  })
  return present(await runValidate(deps, descriptor, written, caller))
}

async function refreshQuickBooks(
  deps: IntegrationDeps,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = descriptorOrThrow('QUICKBOOKS_ONLINE')
  const stored = await readPageCredentials(descriptor.key)
  const clientId = stored?.clientId
  const clientSecret = stored?.clientSecret
  const refreshToken = stored?.refreshToken
  if (!clientId || !clientSecret) throw new Error('Save the QuickBooks client id and secret first.')
  if (!refreshToken) throw new Error('QuickBooks is not connected yet — run Connect to QuickBooks Online.')

  const tokens = await exchangeQboToken(
    clientId,
    clientSecret,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    deps.fetchImpl ?? fetch,
  )
  // Intuit rotates the refresh token on every exchange; the new one replaces the old.
  await writePageCredentials(descriptor.key, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  })
  const row = await requireRow(deps, descriptor.key)
  await deps.writeAudit('INTEGRATION', descriptor.key, 'REFRESH_QUICKBOOKS', caller, {
    provider: descriptor.key,
    rotated: true,
  })
  return present(await runValidate(deps, descriptor, row, caller))
}

/**
 * The payload QBO would receive, and nothing sent.
 *
 * The record arrives in the input — read by the client through its own
 * authenticated reads — because this Lambda holds no grant on Invoice,
 * CarrierBill or ArPayment and J is not the step that gives it one.
 */
function previewQboSync(input: Record<string, unknown>): Record<string, unknown> {
  const kind = requiredString(input.kind, 'kind')
  const record = jsonObject(input.record, 'record')
  const mappings = asJson<QboMappings>(input.mappings) ?? null
  switch (kind) {
    case 'INVOICE':
      return { payload: qboInvoiceFor(record as unknown as QboInvoiceInput, mappings), mode: 'STUB' }
    case 'BILL':
      return { payload: qboBillFor(record as unknown as QboBillInput, mappings), mode: 'STUB' }
    case 'PAYMENT': {
      const allocations = Array.isArray(record.applications)
        ? (record.applications as Array<{ invoiceId: string; amountCents: number }>)
        : []
      return {
        payload: qboPaymentFor(record as unknown as QboPaymentInput, allocations, mappings),
        mode: 'STUB',
      }
    }
    default:
      throw new Error(`kind must be one of INVOICE, BILL, PAYMENT`)
  }
}

// ── BCAT's own API clients ───────────────────────────────────────────────────

const OPENAPI_PROVIDER = 'OPENAPI'
/** The parameter key the token signer reads; minted once and kept. */
const SIGNING_KEY = 'signingKey'

async function issueApiClient(
  deps: IntegrationDeps,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = descriptorOrThrow(OPENAPI_PROVIDER)
  const name = requiredString(input.name, 'name')
  // READ is the only scope the API answers today; an omitted list means that one.
  const scopes = Array.isArray(input.scopes) && input.scopes.length > 0
    ? input.scopes.map((s) => requiredString(s, 'scopes'))
    : ['READ']
  const minted = mintClient(name, scopes)

  // The parameter tracking-api reads:
  //   { signingKey, clients: { <clientId>: { hash } } }
  // Only the HASH is written down — the secret is answered once, here, and then
  // exists nowhere: not in the row, not in the parameter, not in the audit log.
  const stored = (await readRawParameter(OPENAPI_PROVIDER)) ?? {}
  const existingKey = stored[SIGNING_KEY]
  const signingKey = typeof existingKey === 'string' && existingKey ? existingKey : randomBytes(32).toString('hex')
  const storedClients = stored.clients
  const clients: Record<string, unknown> =
    storedClients && typeof storedClients === 'object' && !Array.isArray(storedClients)
      ? { ...(storedClients as Record<string, unknown>) }
      : {}
  clients[minted.clientId] = { hash: minted.hash }
  await writeRawParameter(OPENAPI_PROVIDER, { ...stored, [SIGNING_KEY]: signingKey, clients })

  const now = nowIso()
  const row: IntegrationRow = {
    id: `api:${minted.clientId}`,
    __typename: 'Integration',
    provider: OPENAPI_PROVIDER,
    kind: 'API_CLIENT',
    category: descriptor.category,
    mode: 'LIVE',
    credentialSource: 'OWN',
    credentialRef: parameterNameFor(OPENAPI_PROVIDER),
    credentialMask: null,
    status: 'CONNECTED',
    health: 'OK',
    healthReason: 'OK',
    healthDetail: null,
    lastCheckAt: now,
    lastCheckBy: caller.email,
    lastOkAt: now,
    settings: {},
    capabilities: [],
    name,
    scopes: scopes.map((s) => s.toUpperCase()),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    stubCount: 0,
    lastStubAt: null,
    events: [
      { at: now, action: 'ISSUE_API_CLIENT', by: caller.email, outcome: 'CONNECTED', detail: name },
    ],
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  const written = await putRow(deps, row, null, 'API client')
  await deps.writeAudit('INTEGRATION', `api:${minted.clientId}`, 'ISSUE_API_CLIENT', caller, {
    provider: OPENAPI_PROVIDER,
    clientId: minted.clientId,
    name,
    scopes: row.scopes,
  })
  return { row: present(written), clientId: minted.clientId, secret: minted.secret }
}

async function revokeApiClient(
  deps: IntegrationDeps,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const clientId = requiredString(input.clientId, 'clientId')
  const row = await requireRow(deps, `api:${clientId}`)
  if (row.kind !== 'API_CLIENT') throw new Error(`${clientId} is not an API client`)
  const now = nowIso()
  // The row stays and the hash stays with it: `revokedAt` is what /api/token
  // checks, and a removed row would lose the history of what the client did.
  const next: IntegrationRow = {
    ...row,
    status: 'DISCONNECTED',
    revokedAt: now,
    health: 'UNKNOWN',
    healthReason: null,
    events: appendEvent(row, {
      at: now,
      action: 'REVOKE_API_CLIENT',
      by: caller.email,
      outcome: 'REVOKED',
    }),
    updatedBy: caller.email,
    updatedAt: now,
    version: (row.version ?? 0) + 1,
  }
  const written = await putRow(deps, next, row.version ?? 0, 'API client')
  await deps.writeAudit('INTEGRATION', `api:${clientId}`, 'REVOKE_API_CLIENT', caller, {
    provider: OPENAPI_PROVIDER,
    clientId,
  })
  return present(written)
}

// ── MyCarrierPackets (Step N2) ───────────────────────────────────────────────

const MCP_PROVIDER = 'MYCARRIERPACKETS'

function mcpDescriptor(): ProviderDescriptor {
  return descriptorOrThrow(MCP_PROVIDER)
}

async function mcpCredentials(): Promise<Record<string, string | null>> {
  return credentialsFor(mcpDescriptor())
}

async function getCarrierById(deps: IntegrationDeps, id: string): Promise<Record<string, unknown> | null> {
  const result = await deps.dynamo.send(
    new GetItemCommand({ TableName: deps.carrierTableName, Key: marshall({ id }), ConsistentRead: true }),
  )
  return result.Item ? unmarshall(result.Item) : null
}

async function queryCarriersByMc(deps: IntegrationDeps, mcNumber: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  let startKey: Record<string, AttributeValue> | undefined
  do {
    const page = await deps.dynamo.send(
      new ScanCommand({
        TableName: deps.carrierTableName,
        FilterExpression: 'attribute_exists(mcNumber) AND mcNumber = :mc',
        ExpressionAttributeValues: { ':mc': { S: mcNumber } },
        ExclusiveStartKey: startKey,
      }),
    )
    for (const item of page.Items ?? []) {
      items.push(unmarshall(item))
    }
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return items
}

/**
 * Apply one MCP carrier payload to the matching Carrier row(s). Looks up by
 * mcNumber and writes mcpStatus, safetyRating, insurancePolicies and review
 * fields without touching the directory status.
 */
async function updateCarrierFromMcp(
  deps: IntegrationDeps,
  mcp: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const mcNumber = typeof mcp.mcNumber === 'string' ? mcp.mcNumber.trim() : ''
  if (!mcNumber) return null
  const carriers = await queryCarriersByMc(deps, mcNumber)
  if (carriers.length === 0) return null
  const now = nowIso()
  const patch: Record<string, unknown> = {}
  if (typeof mcp.status === 'string') patch.mcpStatus = mcp.status
  if (typeof mcp.safetyRating === 'string') patch.safetyRating = mcp.safetyRating
  if (typeof mcp.reviewStatus === 'string') patch.mcpReviewStatus = mcp.reviewStatus
  if (typeof mcp.riskAssessmentPoints === 'number') patch.mcpRiskScore = mcp.riskAssessmentPoints
  if (typeof mcp.packetCompletedAt === 'string') patch.mcpPacketCompletedAt = mcp.packetCompletedAt
  // Insurance is merged into the existing list, preserving other policies.
  if (mcp.insurance && typeof mcp.insurance === 'object') {
    const existing = carriers[0].insurancePolicies
    const merged = mergeInsurancePolicies(
      existing as Array<Record<string, unknown>> | null | undefined,
      mcp.insurance as unknown as McpInsurance,
    )
    patch.insurancePolicies = merged
  }
  const updated: Record<string, unknown>[] = []
  for (const carrier of carriers) {
    const next = { ...carrier, ...patch, updatedAt: now }
    await deps.dynamo.send(
      new PutItemCommand({
        TableName: deps.carrierTableName,
        Item: marshall(next, { removeUndefinedValues: true }),
      }),
    )
    updated.push(next)
  }
  return updated[0] ?? null
}

/** Validate MCP credentials against the live token endpoint. */
export async function mcpValidate(
  deps: IntegrationDeps,
  _input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = mcpDescriptor()
  const row = await requireRow(deps, descriptor.key)
  const creds = await mcpCredentials()
  const presentCreds = Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, v ?? ''])) as Record<string, string>
  const mode = modeOf(descriptor, presentCreds)
  const now = nowIso()

  let healthStatus: IntegrationHealthStatus
  let healthReason: IntegrationHealthReason
  if (mode === 'STUB') {
    healthStatus = 'UNABLE_TO_VERIFY'
    healthReason = 'NO_CREDENTIALS'
  } else {
    const adapter = mcpAdapter(presentCreds, deps.fetchImpl)
    const ctx: AdapterContext = {
      provider: MCP_PROVIDER,
      credentials: presentCreds,
      settings: (row.settings ?? {}) as Record<string, unknown>,
      now,
    }
    const health = await adapter.validate!(ctx)
    healthStatus = health.status
    healthReason = health.reason ?? 'OK'
  }

  const event: IntegrationEvent = {
    at: now,
    action: 'VALIDATE',
    by: caller.email,
    outcome: healthStatus,
  }
  const next: IntegrationRow = {
    ...row,
    status: healthStatus === 'OK' && row.status !== 'DISCONNECTED' ? 'CONNECTED' : row.status,
    mode,
    health: healthStatus,
    healthReason,
    healthDetail: null,
    lastCheckAt: now,
    lastCheckBy: caller.email,
    lastOkAt: healthStatus === 'OK' ? now : (row.lastOkAt ?? null),
    events: appendEvent(row, event),
    updatedBy: caller.email,
    updatedAt: now,
  }
  const written = await putRow(deps, next, row.version ?? 0, 'integration')
  await deps.writeAudit('INTEGRATION', descriptor.key, 'MYCARRIERPACKETS_VALIDATE', caller, {
    provider: descriptor.key,
    health: healthStatus,
    reason: healthReason,
  })
  return present(written)
}

/** Sync one carrier from MCP, identified by mcNumber or carrierId. */
export async function mcpSyncCarrier(
  deps: IntegrationDeps,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = mcpDescriptor()
  const creds = await mcpCredentials()
  const mcNumber = typeof input.mcNumber === 'string' ? input.mcNumber.trim() : ''
  const carrierId = typeof input.carrierId === 'string' ? input.carrierId.trim() : ''
  if (!mcNumber && !carrierId) throw new Error('mcNumber or carrierId is required')

  let resolvedMc = mcNumber
  if (!resolvedMc && carrierId) {
    const carrier = await getCarrierById(deps, carrierId)
    if (!carrier) throw new Error(`Carrier not found: ${carrierId}`)
    resolvedMc = typeof carrier.mcNumber === 'string' ? carrier.mcNumber.trim() : ''
    if (!resolvedMc) throw new Error(`Carrier ${carrierId} has no mcNumber`)
  }

  const presentCreds = Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, v ?? ''])) as Record<string, string>
  const mode = modeOf(descriptor, presentCreds)
  let result: AdapterResult
  if (mode === 'STUB') {
    result = {
      mode: 'STUB',
      ok: true,
      message: 'STUB — MyCarrierPackets username/password are not configured; no sync was made.',
      detail: { provider: MCP_PROVIDER, capability: 'sync', sample: { mcNumber: resolvedMc } },
    }
  } else {
    const adapter = mcpAdapter(presentCreds, deps.fetchImpl)
    result = await adapter.sync!({
      provider: MCP_PROVIDER,
      credentials: presentCreds,
      settings: {},
      now: nowIso(),
    }, { mcNumber: resolvedMc })
  }

  const detail = result.detail ?? {}
  const mcp = (detail.carrier ?? detail) as Record<string, unknown>
  const updated = mode === 'LIVE' ? await updateCarrierFromMcp(deps, mcp) : null

  await deps.writeAudit('INTEGRATION', descriptor.key, 'MYCARRIERPACKETS_SYNC_CARRIER', caller, {
    mcNumber: resolvedMc,
    carrierId: carrierId || null,
    ok: result.ok,
    mode: result.mode,
    updatedCarrierId: updated ? String(updated.id ?? '') : null,
  })

  return { result: { mode: result.mode, ok: result.ok, message: result.message }, carrier: updated }
}

/** Sync every carrier with an mcNumber from MCP. */
export async function mcpSyncAll(
  deps: IntegrationDeps,
  _input: Record<string, unknown>,
  caller: IntegrationCaller,
): Promise<Record<string, unknown>> {
  const descriptor = mcpDescriptor()
  const creds = await mcpCredentials()
  const all: Record<string, unknown>[] = []
  let startKey: Record<string, AttributeValue> | undefined
  const now = nowIso()
  const credentials = Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, v ?? ''])) as Record<string, string>
  const mode = modeOf(descriptor, credentials)
  const adapter = mode === 'LIVE' ? mcpAdapter(credentials, deps.fetchImpl) : null

  do {
    const page = await deps.dynamo.send(
      new ScanCommand({
        TableName: deps.carrierTableName,
        FilterExpression: 'attribute_exists(mcNumber) AND NOT begins_with(mcNumber, :empty)',
        ExpressionAttributeValues: { ':empty': { S: '' } },
        ExclusiveStartKey: startKey,
      }),
    )
    for (const item of page.Items ?? []) {
      const carrier = unmarshall(item)
      const mcNumber = typeof carrier.mcNumber === 'string' ? carrier.mcNumber.trim() : ''
      if (!mcNumber) continue
      try {
        if (mode === 'STUB') {
          all.push({ mcNumber, ok: true, mode: 'STUB', carrierId: null })
          continue
        }
        const result = await adapter!.sync!({
          provider: MCP_PROVIDER,
          credentials,
          settings: {},
          now,
        }, { mcNumber })
        const detail = result.detail ?? {}
        const mcp = (detail.carrier ?? detail) as Record<string, unknown>
        const updated = await updateCarrierFromMcp(deps, mcp)
        all.push({ mcNumber, ok: result.ok, mode: result.mode, carrierId: updated ? String(updated.id ?? '') : null })
      } catch (err) {
        all.push({ mcNumber, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    startKey = page.LastEvaluatedKey
  } while (startKey)

  await deps.writeAudit('INTEGRATION', descriptor.key, 'MYCARRIERPACKETS_SYNC_ALL', caller, {
    count: all.length,
    ok: all.filter((r) => r.ok).length,
  })

  return { count: all.length, ok: all.filter((r) => r.ok).length, results: all }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export async function runIntegrationAction(
  action: IntegrationActionName,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
  deps: IntegrationDeps,
): Promise<unknown> {
  switch (action) {
    case 'LIST_INTEGRATIONS':
      return listIntegrations(deps, caller)
    case 'CONNECT_INTEGRATION':
      return connectIntegration(deps, input, caller)
    case 'VALIDATE_INTEGRATION':
      return validateIntegration(deps, input, caller)
    case 'SAVE_INTEGRATION_SETTINGS':
      return saveIntegrationSettings(deps, input, caller)
    case 'DISCONNECT_INTEGRATION':
      return disconnectIntegration(deps, input, caller)
    case 'RUN_STUB':
      return runStub(deps, input, caller)
    case 'CONNECT_QUICKBOOKS':
      return connectQuickBooks(deps, input, caller)
    case 'REFRESH_QUICKBOOKS':
      return refreshQuickBooks(deps, caller)
    case 'PREVIEW_QBO_SYNC':
      return previewQboSync(input)
    case 'ISSUE_API_CLIENT':
      return issueApiClient(deps, input, caller)
    case 'REVOKE_API_CLIENT':
      return revokeApiClient(deps, input, caller)
    case 'MYCARRIERPACKETS_VALIDATE':
      return mcpValidate(deps, input, caller)
    case 'MYCARRIERPACKETS_SYNC_CARRIER':
      return mcpSyncCarrier(deps, input, caller)
    case 'MYCARRIERPACKETS_SYNC_ALL':
      return mcpSyncAll(deps, input, caller)
    default:
      throw new Error(`Unknown integration action: ${String(action)}`)
  }
}
