/**
 * Carrier tax-ID vault (Docs/tms-build/AW_TAXID_DESIGN.md).
 *
 * The clear number exists only inside the calling Lambda, between validation and `kms:Encrypt` (or between
 * `kms:Decrypt` and the REVEAL response). What is stored is a KMS ciphertext bound to the carrier by encryption
 * context, in the Lambda-only table `CarrierTaxVault` (its own CDK stack, not an Amplify model), plus an HMAC
 * fingerprint for duplicate detection and the masked last four. The Carrier row only carries the three mirror
 * fields `taxIdLast4`, `taxIdType`, `taxIdOnFileAt`.
 *
 * Nothing in here may log, throw or audit the value. Errors are fixed sentences; `redactTaxIds` is applied to
 * every free-text field that comes from a person (the reveal reason).
 *
 * Names are derived, not passed through env (the data stack's template budget and tms-directory-actions' env
 * budget are both full): the stack's API id is cut out of the Carrier table name, exactly as backend.ts does, and
 * the table / key aliases are `CarrierTaxVault-<apiId>`, `alias/bcat-tax-vault-<apiId>`, `alias/bcat-tax-vault-mac-<apiId>`.
 */
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { DecryptCommand, EncryptCommand, GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { randomUUID } from 'node:crypto'

/** The production AppSync API id (scripts/lib/stackConfig.mjs PRODUCTION.apiId). Synthetic IDs are refused here. */
export const PRODUCTION_API_ID = '5ucwdyvwivelbo4k4jomvrwel4'

export const REVEAL_MIN_REASON = 8
export const REVEAL_MAX_REASON = 500
export const REVEAL_LIMIT_PER_HOUR = 20
export const REVEAL_VISIBLE_SECONDS = 30
export const FINGERPRINT_INDEX = 'byFingerprint'

export type TaxIdType = 'EIN' | 'SSN'
export type TaxIdSource = 'ALJEX' | 'MCP' | 'MANUAL'

/** A failure whose message is safe to show anyone: it never carries the number. */
export class TaxIdError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'TaxIdError'
  }
}

// ── Names ───────────────────────────────────────────────────────────────────

export interface VaultNames {
  apiId: string
  table: string
  keyId: string
  macKeyId: string
}

/** `Carrier-<apiId>-NONE` -> the vault's names. */
export function vaultNamesFor(carrierTableName: string): VaultNames {
  const apiId = carrierTableName.split('-')[1] ?? ''
  if (!apiId) throw new TaxIdError('Tax ID store is not configured', 'NOT_CONFIGURED')
  return {
    apiId,
    table: `CarrierTaxVault-${apiId}`,
    keyId: `alias/bcat-tax-vault-${apiId}`,
    macKeyId: `alias/bcat-tax-vault-mac-${apiId}`,
  }
}

export interface VaultDeps {
  dynamo: Pick<DynamoDBClient, 'send'>
  kms: Pick<KMSClient, 'send'>
  carrierTable: string
  auditTable: string
  names: VaultNames
  now?: () => Date
}

/** Real clients for a Lambda whose env carries CARRIER_TABLE_NAME (+ AUDIT_LOG_TABLE_NAME). */
export function vaultDepsFromEnv(dynamo: Pick<DynamoDBClient, 'send'>, kms: Pick<KMSClient, 'send'> = new KMSClient({})): VaultDeps {
  const carrierTable = process.env.CARRIER_TABLE_NAME ?? ''
  return { dynamo, kms, carrierTable, auditTable: process.env.AUDIT_LOG_TABLE_NAME ?? '', names: vaultNamesFor(carrierTable) }
}

export const isProductionApi = (apiId: string): boolean => apiId === PRODUCTION_API_ID

// ── Validation ──────────────────────────────────────────────────────────────

/** IRS campus prefixes that are never issued, plus 00 (never issued, and the synthetic family below). */
const EIN_NEVER_ISSUED = new Set(['17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89'])
/** Prefixes no real EIN can have. Accepted ONLY off production, where fixtures and rehearsal imports use them. */
const EIN_SYNTHETIC_PREFIXES = new Set(['00', '07', '08', '09'])

export interface NormalizedTaxId {
  digits: string
  type: TaxIdType
  /** True when the number is one of the IRS-impossible synthetic shapes. */
  synthetic: boolean
}

/**
 * Nine digits, classified EIN or SSN, with the IRS's own "never issued" rules. The message of every failure is a
 * fixed sentence.
 */
export function normalizeTaxId(raw: unknown, requested?: unknown, opts: { allowSynthetic?: boolean } = {}): NormalizedTaxId {
  if (typeof raw !== 'string') throw new TaxIdError('Tax ID must be text', 'INVALID_FORMAT')
  const text = raw.trim()
  const digits = text.replace(/\D/g, '')
  if (digits.length !== 9) throw new TaxIdError('Tax ID must have 9 digits', 'INVALID_FORMAT')
  if (requested != null && requested !== 'EIN' && requested !== 'SSN') throw new TaxIdError('Tax ID type must be EIN or SSN', 'INVALID_FORMAT')
  const shape: TaxIdType | null = /^\d{2}-\d{7}$/.test(text) ? 'EIN' : /^\d{3}-\d{2}-\d{4}$/.test(text) ? 'SSN' : null
  if (requested && shape && requested !== shape) throw new TaxIdError('Tax ID does not match the type given', 'INVALID_FORMAT')
  const type = (requested as TaxIdType | undefined) ?? shape
  if (!type) throw new TaxIdError('Tax ID type (EIN or SSN) is required', 'TYPE_REQUIRED')

  let synthetic: boolean
  if (type === 'EIN') {
    const prefix = digits.slice(0, 2)
    if (EIN_NEVER_ISSUED.has(prefix)) throw new TaxIdError('Tax ID is not a valid EIN', 'INVALID_FORMAT')
    synthetic = EIN_SYNTHETIC_PREFIXES.has(prefix)
  } else {
    const area = Number(digits.slice(0, 3))
    if (digits.slice(3, 5) === '00' || digits.slice(5) === '0000') throw new TaxIdError('Tax ID is not a valid SSN', 'INVALID_FORMAT')
    synthetic = area === 0 || area === 666 || area >= 900
  }
  if (synthetic && !opts.allowSynthetic) throw new TaxIdError(type === 'EIN' ? 'Tax ID is not a valid EIN' : 'Tax ID is not a valid SSN', 'INVALID_FORMAT')
  return { digits, type, synthetic }
}

export function formatTaxId(digits: string, type: TaxIdType): string {
  return type === 'EIN' ? `${digits.slice(0, 2)}-${digits.slice(2)}` : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
}

/** Belt and braces for text a person typed (the reveal reason): the three tax-ID shapes become `[redacted]`. */
export function redactTaxIds(text: string): string {
  return text
    .replace(/\b\d{2}-\d{7}\b/g, '[redacted]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]')
    .replace(/\b\d{9}\b/g, '[redacted]')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>
const nowOf = (deps: VaultDeps): Date => (deps.now ? deps.now() : new Date())
const ctxOf = (deps: VaultDeps, carrierId: string): Record<string, string> => ({ carrierId, field: 'taxId', api: deps.names.apiId })
const keyOf = (carrierId: string): Record<string, AttributeValue> => ({ carrierId: { S: carrierId } })

async function fingerprintOf(deps: VaultDeps, digits: string): Promise<string> {
  const out = await deps.kms.send(new GenerateMacCommand({ KeyId: deps.names.macKeyId, MacAlgorithm: 'HMAC_SHA_256', Message: Buffer.from(digits, 'utf8') }))
  if (!out.Mac) throw new TaxIdError('Tax ID store unavailable', 'KMS')
  return Buffer.from(out.Mac).toString('base64')
}

/** The vault item for a carrier; `withCiphertext` false never even fetches the blob. */
async function getVaultItem(deps: VaultDeps, carrierId: string, withCiphertext: boolean): Promise<Row | null> {
  const out = await deps.dynamo.send(new GetItemCommand({
    TableName: deps.names.table,
    Key: keyOf(carrierId),
    ConsistentRead: true,
    ProjectionExpression: withCiphertext
      ? 'carrierId, ciphertext, keyArn, #t, last4, fingerprint, setAt, setBy, #s, version'
      : 'carrierId, keyArn, #t, last4, fingerprint, setAt, setBy, #s, version',
    ExpressionAttributeNames: { '#t': 'type', '#s': 'source' },
  }))
  return out.Item ? (unmarshall(out.Item) as Row) : null
}

async function duplicateOwner(deps: VaultDeps, fingerprint: string, carrierId: string): Promise<string | null> {
  const out = await deps.dynamo.send(new QueryCommand({
    TableName: deps.names.table,
    IndexName: FINGERPRINT_INDEX,
    KeyConditionExpression: 'fingerprint = :f',
    ExpressionAttributeValues: { ':f': { S: fingerprint } },
  }))
  const other = (out.Items ?? []).map((i) => String(unmarshall(i).carrierId)).find((id) => id !== carrierId)
  return other ?? null
}

interface AuditInput {
  carrierId: string
  action: string
  user: string
  changes: Row
}

/** One AuditLog row. `strict` fails the caller (REVEAL: no audit row, no decrypt); otherwise best effort. */
async function writeVaultAudit(deps: VaultDeps, a: AuditInput, strict: boolean): Promise<void> {
  if (!deps.auditTable) {
    if (strict) throw new TaxIdError('Audit log is not configured', 'AUDIT')
    return
  }
  const now = nowOf(deps).toISOString()
  try {
    await deps.dynamo.send(new PutItemCommand({
      TableName: deps.auditTable,
      Item: marshall({
        id: randomUUID(), __typename: 'AuditLog', entityType: 'CARRIER', entityId: a.carrierId, action: a.action,
        user: a.user, changes: JSON.stringify(a.changes), createdAt: now, updatedAt: now,
      }, { removeUndefinedValues: true }),
    }))
  } catch {
    if (strict) throw new TaxIdError('Audit log write failed; nothing was revealed', 'AUDIT')
  }
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : '')

/** The DynamoDB cancellation code of item `index` in a failed TransactWriteItems. */
function cancelReason(err: unknown, index: number): string | undefined {
  if (!(err instanceof Error) || !('CancellationReasons' in err) || !Array.isArray(err.CancellationReasons)) return undefined
  const reason: unknown = err.CancellationReasons[index]
  return reason && typeof reason === 'object' && 'Code' in reason && typeof reason.Code === 'string' ? reason.Code : undefined
}

// ── SET ─────────────────────────────────────────────────────────────────────

export interface SetTaxIdInput {
  carrierId: string
  value: unknown
  type?: unknown
  source: TaxIdSource
  /** E-mail of the admin, or 'aljex-import' / 'mcp-sync'. */
  setBy: string
  /** MCP's rule: a number a person (or the Aljex file) put there is never overwritten. */
  onlyIfAbsent?: boolean
}

export type SetTaxIdResult =
  | { ok: true; last4: string; type: TaxIdType; unchanged: boolean }
  | { ok: false; duplicateOf: string }

export async function setTaxId(deps: VaultDeps, input: SetTaxIdInput): Promise<SetTaxIdResult> {
  const { carrierId } = input
  const n = normalizeTaxId(input.value, input.type, { allowSynthetic: !isProductionApi(deps.names.apiId) })
  const last4 = n.digits.slice(-4)

  const existing = await getVaultItem(deps, carrierId, false)
  if (existing && input.onlyIfAbsent) return { ok: true, last4: String(existing.last4), type: existing.type as TaxIdType, unchanged: true }

  const fingerprint = await fingerprintOf(deps, n.digits)
  if (existing && existing.fingerprint === fingerprint && existing.type === n.type) return { ok: true, last4, type: n.type, unchanged: true }
  const other = await duplicateOwner(deps, fingerprint, carrierId)
  if (other) return { ok: false, duplicateOf: other }

  const enc = await deps.kms.send(new EncryptCommand({
    KeyId: deps.names.keyId, Plaintext: Buffer.from(n.digits, 'utf8'), EncryptionContext: ctxOf(deps, carrierId),
  }))
  if (!enc.CiphertextBlob) throw new TaxIdError('Tax ID store unavailable', 'KMS')

  const now = nowOf(deps).toISOString()
  const version = Number(existing?.version ?? 0) + 1
  const item = marshall({
    carrierId, ciphertext: enc.CiphertextBlob, keyArn: enc.KeyId, type: n.type, last4, fingerprint,
    setAt: now, setBy: input.setBy, source: input.source, version,
  }, { removeUndefinedValues: true })
  try {
    await deps.dynamo.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: deps.names.table, Item: item,
            ConditionExpression: 'attribute_not_exists(carrierId) OR version = :v',
            ExpressionAttributeValues: { ':v': { N: String(version - 1) } },
          },
        },
        {
          Update: {
            TableName: deps.carrierTable, Key: { id: { S: carrierId } },
            ConditionExpression: 'attribute_exists(id)',
            UpdateExpression: 'SET taxIdLast4 = :l, taxIdType = :t, taxIdOnFileAt = :a',
            ExpressionAttributeValues: { ':l': { S: last4 }, ':t': { S: n.type }, ':a': { S: now } },
          },
        },
      ],
    }))
  } catch (err) {
    if (cancelReason(err, 1) === 'ConditionalCheckFailed') throw new TaxIdError('Carrier not found', 'NOT_FOUND')
    if (errName(err) === 'TransactionCanceledException') throw new TaxIdError('Tax ID changed concurrently; try again', 'CONFLICT')
    throw err
  }
  await writeVaultAudit(deps, {
    carrierId, action: 'TAX_ID_SET', user: input.setBy,
    changes: { last4, type: n.type, source: input.source, previousLast4: existing ? String(existing.last4) : null },
  }, false)
  return { ok: true, last4, type: n.type, unchanged: false }
}

/** MyCarrierPackets' W-9 number into the vault; never overwrites a number somebody else set. */
export function setTaxIdFromMcp(deps: VaultDeps, carrierId: string, value: string): Promise<SetTaxIdResult> {
  return setTaxId(deps, { carrierId, value, source: 'MCP', setBy: 'mcp-sync', onlyIfAbsent: true })
}

// ── STATUS ──────────────────────────────────────────────────────────────────

export interface TaxIdStatus {
  onFile: boolean
  last4: string | null
  type: TaxIdType | null
  setAt: string | null
  source: TaxIdSource | null
}

/** No KMS call and no ciphertext: the masked facts only. */
export async function taxIdStatus(deps: VaultDeps, carrierId: string): Promise<TaxIdStatus> {
  const item = await getVaultItem(deps, carrierId, false)
  if (!item) return { onFile: false, last4: null, type: null, setAt: null, source: null }
  return {
    onFile: true, last4: String(item.last4), type: item.type as TaxIdType,
    setAt: (item.setAt as string | undefined) ?? null, source: (item.source as TaxIdSource | undefined) ?? null,
  }
}

// ── REVEAL ──────────────────────────────────────────────────────────────────

export interface RevealInput {
  carrierId: string
  reason: unknown
  /** The caller's e-mail (already proven ADMIN by the handler). */
  user: string
  ip?: string | null
}

const hourKey = (d: Date): string => d.toISOString().slice(0, 13)

/**
 * Order is the contract: reason checked -> item exists -> rate limit taken -> AuditLog row written (strict) ->
 * Decrypt. A crash after the audit row therefore never yields an unaudited reveal.
 */
export async function revealTaxId(deps: VaultDeps, input: RevealInput): Promise<{ value: string; expiresInSeconds: number }> {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < REVEAL_MIN_REASON) throw new TaxIdError(`A reason of at least ${REVEAL_MIN_REASON} characters is required`, 'REASON')
  if (reason.length > REVEAL_MAX_REASON) throw new TaxIdError(`The reason is too long (max ${REVEAL_MAX_REASON})`, 'REASON')

  const item = await getVaultItem(deps, input.carrierId, true)
  if (!item || !item.ciphertext) throw new TaxIdError('No tax ID on file for this carrier', 'NOT_FOUND')

  const now = nowOf(deps)
  try {
    await deps.dynamo.send(new UpdateItemCommand({
      TableName: deps.names.table,
      Key: keyOf(`rl#${input.user.toLowerCase()}#${hourKey(now)}`),
      UpdateExpression: 'ADD #c :one SET ttlEpoch = :ttl',
      ConditionExpression: 'attribute_not_exists(#c) OR #c < :max',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':one': { N: '1' }, ':max': { N: String(REVEAL_LIMIT_PER_HOUR) }, ':ttl': { N: String(Math.floor(now.getTime() / 1000) + 48 * 3600) } },
    }))
  } catch (err) {
    if (errName(err) === 'ConditionalCheckFailedException') {
      throw new TaxIdError(`Reveal limit reached (${REVEAL_LIMIT_PER_HOUR} per hour)`, 'RATE_LIMIT')
    }
    throw err
  }

  await writeVaultAudit(deps, {
    carrierId: input.carrierId, action: 'TAX_ID_REVEALED', user: input.user,
    changes: { reason: redactTaxIds(reason), last4: String(item.last4), type: item.type, ip: input.ip ?? null },
  }, true)

  let plain: Uint8Array | undefined
  try {
    const out = await deps.kms.send(new DecryptCommand({
      KeyId: deps.names.keyId, CiphertextBlob: item.ciphertext as Uint8Array, EncryptionContext: ctxOf(deps, input.carrierId),
    }))
    plain = out.Plaintext
  } catch {
    throw new TaxIdError('Tax ID store unavailable', 'KMS')
  }
  if (!plain) throw new TaxIdError('Tax ID store unavailable', 'KMS')
  const buf = Buffer.from(plain)
  const digits = buf.toString('utf8')
  buf.fill(0)
  if (!/^\d{9}$/.test(digits)) throw new TaxIdError('Tax ID store unavailable', 'KMS')
  return { value: formatTaxId(digits, item.type as TaxIdType), expiresInSeconds: REVEAL_VISIBLE_SECONDS }
}

// ── CLEAR ───────────────────────────────────────────────────────────────────

export async function clearTaxId(deps: VaultDeps, input: { carrierId: string; reason: unknown; user: string }): Promise<{ ok: true; cleared: boolean }> {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < REVEAL_MIN_REASON) throw new TaxIdError(`A reason of at least ${REVEAL_MIN_REASON} characters is required`, 'REASON')
  if (reason.length > REVEAL_MAX_REASON) throw new TaxIdError(`The reason is too long (max ${REVEAL_MAX_REASON})`, 'REASON')
  const item = await getVaultItem(deps, input.carrierId, false)
  if (!item) return { ok: true, cleared: false }
  try {
    await deps.dynamo.send(new TransactWriteItemsCommand({
      TransactItems: [
        { Delete: { TableName: deps.names.table, Key: keyOf(input.carrierId), ConditionExpression: 'attribute_exists(carrierId)' } },
        {
          Update: {
            TableName: deps.carrierTable, Key: { id: { S: input.carrierId } }, ConditionExpression: 'attribute_exists(id)',
            UpdateExpression: 'REMOVE taxIdLast4, taxIdType, taxIdOnFileAt',
          },
        },
      ],
    }))
  } catch (err) {
    if (errName(err) === 'TransactionCanceledException') throw new TaxIdError('Tax ID changed concurrently; try again', 'CONFLICT')
    throw err
  }
  await writeVaultAudit(deps, {
    carrierId: input.carrierId, action: 'TAX_ID_CLEARED', user: input.user,
    changes: { reason: redactTaxIds(reason), previousLast4: String(item.last4), type: item.type },
  }, false)
  return { ok: true, cleared: true }
}

// ── IMPORT (operator CLI, direct Lambda invoke) ─────────────────────────────

export interface ImportRow {
  aljexCarrierId: string
  mcNumber: string
  dotNumber: string
  value: string
}

export interface ImportSummary {
  set: number
  unchanged: number
  duplicates: Array<{ carrierId: string; duplicateOfCarrierId: string }>
  invalidFormat: number
  unmatched: string[]
  failed: number
  /** Name of the first non-validation error (e.g. AccessDeniedException); never a message. */
  firstErrorName: string | null
}

export const MAX_IMPORT_ROWS = 100

/**
 * Counts and ids only. A row's value is validated and encrypted inside setTaxId and is not retained here; the
 * response never carries a value or a last four. Sequential on purpose: the in-batch `owner` map makes a number
 * repeated inside the batch a duplicate even before the GSI has caught up.
 */
export async function importTaxIds(
  deps: VaultDeps,
  rows: ImportRow[],
  resolveCarrier: (row: ImportRow) => Promise<string | null>,
): Promise<ImportSummary> {
  if (rows.length > MAX_IMPORT_ROWS) throw new TaxIdError(`At most ${MAX_IMPORT_ROWS} rows per call`, 'TOO_MANY')
  const out: ImportSummary = { set: 0, unchanged: 0, duplicates: [], invalidFormat: 0, unmatched: [], failed: 0, firstErrorName: null }
  for (const row of rows) {
    const carrierId = await resolveCarrier(row)
    if (!carrierId) { out.unmatched.push(row.aljexCarrierId); continue }
    try {
      const r = await setTaxId(deps, { carrierId, value: row.value, source: 'ALJEX', setBy: 'aljex-import' })
      if (!r.ok) out.duplicates.push({ carrierId, duplicateOfCarrierId: r.duplicateOf })
      else if (r.unchanged) out.unchanged++
      else out.set++
    } catch (err) {
      if (err instanceof TaxIdError && (err.code === 'INVALID_FORMAT' || err.code === 'TYPE_REQUIRED')) out.invalidFormat++
      else {
        out.failed++
        out.firstErrorName ??= err instanceof Error ? err.name : 'Error'
      }
    }
  }
  return out
}
