/**
 * The clients, table names, readers and transaction builders every finance action
 * shares.
 *
 * It sits below `handler.ts`, `invoices.ts`, `payments.ts` and `factor.ts` so those
 * four never import each other and the bundle has no cycle. Everything that writes
 * money builds a `TransactWriteItem` here — the conditional ADD that spends a credit,
 * the REMOVE that takes an invoice out of the open book, the order update conditioned
 * on the invoice it belongs to — so the conditions live in one readable place rather
 * than inline in five actions.
 */
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { createHash, randomUUID } from 'crypto'
import {
  getById as storeGetById,
  marshallRow,
  nowIso,
  numberOrNull,
  queryIndex as storeQueryIndex,
  transact as storeTransact,
  type Row,
} from '../_shared/shipmentStore'
import type { Caller } from '../_shared/actionInputs'
import type { ReleaseGateDeps } from '../_shared/releaseGateInput'
import { DEFAULT_INVOICE_NUMBER_FORMAT, formatInvoiceNumber } from '../../../src/lib/invoiceBuild'

export const dynamo = new DynamoDBClient({})
export const cognito = new CognitoIdentityProviderClient({})
export const s3 = new S3Client({})
export const ses = new SESv2Client({})

export const INVOICE_TABLE_NAME = process.env.INVOICE_TABLE_NAME ?? ''
export const AR_PAYMENT_TABLE_NAME = process.env.AR_PAYMENT_TABLE_NAME ?? ''
export const ORDER_TABLE_NAME = process.env.ORDER_TABLE_NAME ?? ''
export const SHIPMENT_TABLE_NAME = process.env.SHIPMENT_TABLE_NAME ?? ''
export const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME ?? ''
export const LOAD_CARRIER_TABLE_NAME = process.env.LOAD_CARRIER_TABLE_NAME ?? ''
export const LOAD_FINANCIALS_TABLE_NAME = process.env.LOAD_FINANCIALS_TABLE_NAME ?? ''
export const LOAD_CHARGE_TABLE_NAME = process.env.LOAD_CHARGE_TABLE_NAME ?? ''
export const CUSTOMER_TABLE_NAME = process.env.CUSTOMER_TABLE_NAME ?? ''
export const DIVISION_TABLE_NAME = process.env.DIVISION_TABLE_NAME ?? ''
export const SETTINGS_TABLE_NAME = process.env.SETTINGS_TABLE_NAME ?? ''
export const AUDIT_LOG_TABLE_NAME = process.env.AUDIT_LOG_TABLE_NAME ?? ''
export const FACTORING_ITEM_TABLE_NAME = process.env.FACTORING_ITEM_TABLE_NAME ?? ''
export const SHIPMENT_DOCUMENT_TABLE_NAME = process.env.SHIPMENT_DOCUMENT_TABLE_NAME ?? ''
export const SHIPMENT_NOTICE_TABLE_NAME = process.env.SHIPMENT_NOTICE_TABLE_NAME ?? ''
export const CARRIER_BILL_TABLE_NAME = process.env.CARRIER_BILL_TABLE_NAME ?? ''
export const AP_PAYMENT_TABLE_NAME = process.env.AP_PAYMENT_TABLE_NAME ?? ''
export const CARRIER_TABLE_NAME = process.env.CARRIER_TABLE_NAME ?? ''
export const CARRIER_PAYMENT_METHOD_TABLE_NAME = process.env.CARRIER_PAYMENT_METHOD_TABLE_NAME ?? ''
export const CARRIER_CONTACT_TABLE_NAME = process.env.CARRIER_CONTACT_TABLE_NAME ?? ''
// Step I: the commission ledger, its pay periods, and the staff directory the
// commission roles resolve a manager and a display name from.
export const COMMISSION_TABLE_NAME = process.env.COMMISSION_TABLE_NAME ?? ''
export const COMMISSION_PAY_PERIOD_TABLE_NAME = process.env.COMMISSION_PAY_PERIOD_TABLE_NAME ?? ''
export const USER_PROFILE_TABLE_NAME = process.env.USER_PROFILE_TABLE_NAME ?? ''
export const BUCKET_NAME = process.env.BUCKET_NAME ?? ''
export const FROM_ADDRESS = process.env.FROM_ADDRESS ?? ''
export const USER_POOL_ID = process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'

export const OWNER_EMAIL = 'ryne@bcatcorp.com'
export const ADMIN_GROUP = 'ADMIN'
export const INVOICING_PAGE_GROUP = 'page-invoicing'
/** AP is its own permission: the people who bill customers are not the people who pay carriers. */
export const CARRIER_PAY_PAGE_GROUP = 'page-carrierPay'
export const SETTINGS_ID = 'default'

/**
 * Amplify derives these from the model name and the index keys; they are not guesses.
 * Only the ones this Lambda itself queries are here — the AR boards read Invoice and
 * ArPayment straight off their own indexes from the browser.
 */
export const IDX_ORDERS_BY_SHIPMENT = 'ordersByShipmentId'
export const IDX_LOADS_BY_SHIPMENT = 'loadsByShipmentId'
export const IDX_CHARGES_BY_SHIPMENT = 'loadChargesByShipmentIdAndSortOrder'
export const IDX_CARRIERS_BY_SHIPMENT = 'loadCarriersByShipmentId'
export const IDX_DOCUMENTS_BY_SHIPMENT = 'shipmentDocumentsByShipmentIdAndUploadedAt'
export const IDX_PAYMENT_METHODS_BY_CARRIER = 'carrierPaymentMethodsByCarrierId'
export const IDX_CONTACTS_BY_CARRIER = 'carrierContactsByCarrierId'
export const IDX_BILLS_BY_CARRIER = 'carrierBillsByCarrierIdAndRecordedAt'
export const IDX_COMMISSIONS_BY_INVOICE = 'commissionsByInvoiceId'
export const IDX_COMMISSIONS_BY_REP = 'commissionsByRepIdAndCommissionMonth'
export const IDX_COMMISSIONS_BY_MONTH = 'commissionsByCommissionMonthAndTriggerAt'
export const IDX_COMMISSIONS_BY_PAY_PERIOD = 'commissionsByPayPeriodId'

/** How long a download offered after a refused send stays good. */
export const DOWNLOAD_URL_TTL_SECONDS = 3600
/** SES's raw-message ceiling, less the base64 and MIME overhead. */
export const MAX_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_BATCH = 25

export { nowIso, numberOrNull, type Row }

export function getById(tableName: string, id: string): Promise<Row | null> {
  return storeGetById(dynamo, tableName, id)
}

/**
 * Division is keyed on `key`, not `id` (`amplify/data/resource.ts`, `.identifier(['key'])`),
 * so the generic `getById` — which builds `Key: { id }` — is answered with a
 * ValidationException, not an empty read: an invoice, a bill or a remittance on a row
 * carrying a `divisionKey` would fail outright. Every finance read of a division goes
 * through here, as the notifier and the tracking router already do.
 */
export async function getDivision(key: string): Promise<Row | null> {
  if (!key || !DIVISION_TABLE_NAME) return null
  const result = await dynamo.send(new GetItemCommand({ TableName: DIVISION_TABLE_NAME, Key: marshall({ key }) }))
  return result.Item ? (unmarshall(result.Item) as Row) : null
}

export function queryIndex(tableName: string, indexName: string, keyName: string, keyValue: string): Promise<Row[]> {
  return storeQueryIndex(dynamo, tableName, indexName, keyName, keyValue)
}

export function transact(items: TransactWriteItem[], label: string): Promise<void> {
  return storeTransact(dynamo, items, label)
}

/**
 * The tables the release gate reads, bound to this Lambda's client. The check-call
 * table is not among them: finance holds no grant on it, so the open-exception
 * count comes from `Load.openIncidentCount`, which the tracking router keeps honest.
 */
export const releaseGateDeps: ReleaseGateDeps = {
  db: dynamo,
  tables: {
    shipment: SHIPMENT_TABLE_NAME,
    order: ORDER_TABLE_NAME,
    load: LOAD_TABLE_NAME,
    loadCarrier: LOAD_CARRIER_TABLE_NAME,
    shipmentDocument: SHIPMENT_DOCUMENT_TABLE_NAME,
    customer: CUSTOMER_TABLE_NAME,
    settings: SETTINGS_TABLE_NAME,
  },
}


// ── identity ────────────────────────────────────────────────────────────────

export interface AppSyncIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

export async function getCallerEmail(identity: AppSyncIdentity): Promise<string> {
  const claims = identity.claims ?? {}
  const candidates = [claims.email, identity.username, claims['cognito:username']]
  const found = candidates.find((v): v is string => typeof v === 'string' && v.includes('@'))
  if (found) return found.toLowerCase().trim()
  const lookup = identity.username ?? identity.sub
  if (!lookup) return ''
  try {
    const me = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: String(lookup) }))
    return (me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
  } catch (err) {
    console.warn('[tms-finance-actions] could not resolve caller email:', String(err))
    return ''
  }
}

export function getGroups(identity?: AppSyncIdentity | null): string[] {
  if (!identity) return []
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

// ── audit ───────────────────────────────────────────────────────────────────

/**
 * Best-effort, outside the transaction and on purpose: a posted payment that cannot
 * write its audit row is still a posted payment, and failing the write would leave
 * the money unrecorded instead.
 */
export async function writeAudit(
  entityType: string,
  entityId: string,
  action: string,
  caller: Caller,
  changes: Row,
): Promise<void> {
  if (!AUDIT_LOG_TABLE_NAME) return
  const now = nowIso()
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: AUDIT_LOG_TABLE_NAME,
        Item: marshallRow({
          id: randomUUID(),
          __typename: 'AuditLog',
          entityType,
          entityId,
          action,
          user: caller.email,
          changes: JSON.stringify(changes),
          createdAt: now,
          updatedAt: now,
        }),
      }),
    )
  } catch (err) {
    console.warn('[tms-finance-actions] audit log write failed:', String(err))
  }
}

// ── transaction builders ────────────────────────────────────────────────────

function expressionFor(patch: Row, remove: string[]): {
  names: Record<string, string>
  values: Record<string, AttributeValue>
  expression: string
} {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const sets: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    names[`#${key}`] = key
    values[`:${key}`] = marshallRow({ [key]: value })[key]
    sets.push(`#${key} = :${key}`)
  }
  const removes: string[] = []
  for (const key of remove) {
    names[`#${key}`] = key
    removes.push(`#${key}`)
  }
  const parts: string[] = []
  if (sets.length > 0) parts.push(`SET ${sets.join(', ')}`)
  if (removes.length > 0) parts.push(`REMOVE ${removes.join(', ')}`)
  return { names, values, expression: parts.join(' ') }
}

/**
 * A SET/REMOVE update with an optional extra condition.
 *
 * `remove` exists because `arOpen` has to LEAVE the row when an invoice settles.
 * Writing null instead is what step C's carrier index already proved fatal:
 * DynamoDB answers `Type mismatch for Index Key … Actual: NULL` and refuses the write.
 */
export function updateTx(
  tableName: string,
  id: string,
  patch: Row,
  options: { remove?: string[]; condition?: string; extraValues?: Record<string, AttributeValue> } = {},
): TransactWriteItem {
  const { names, values, expression } = expressionFor(patch, options.remove ?? [])
  for (const [key, value] of Object.entries(options.extraValues ?? {})) values[key] = value
  return {
    Update: {
      TableName: tableName,
      Key: marshall({ id }),
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
      ...(options.condition ? { ConditionExpression: options.condition } : {}),
    },
  }
}

/**
 * Spend part of a credit with an atomic ADD, refused if somebody else spent it first
 * or if the row has been reversed.
 *
 * Two people allocating the same $250 credit in the same second is exactly the race a
 * read-then-write would lose, so the amount left is never read into the decision: the
 * condition and the subtraction are the same statement. A reversal zeroes the same
 * field under its own CAS, so the two orderings resolve the same way — whichever
 * commits first stands, and the other is refused.
 */
export function spendCreditTx(
  tableName: string,
  id: string,
  usedCents: number,
  now: string,
  by: string,
): TransactWriteItem {
  return {
    Update: {
      TableName: tableName,
      Key: marshall({ id }),
      UpdateExpression: 'ADD unappliedCents :negUsed, appliedCents :used SET updatedAt = :now, updatedBy = :by',
      ConditionExpression: `unappliedCents >= :used AND ${unsetCondition('reversedByPaymentId')}`,
      ExpressionAttributeValues: {
        ':used': { N: String(usedCents) },
        ':negUsed': { N: String(-usedCents) },
        ':now': { S: now },
        ':by': { S: by },
        ':nullType': NULL_TYPE_VALUE,
      },
    },
  }
}

/**
 * "This field is not set" — as DynamoDB means it, not as JavaScript does.
 *
 * `attribute_not_exists(x)` is FALSE for an attribute explicitly stored as NULL, and
 * `tms-shipment-actions` creates every order with `invoiceId: null` (handler.ts:1099,
 * 1858) because `marshall` only strips `undefined`. A bare `attribute_not_exists`
 * would therefore refuse to invoice any order this system has ever booked. Every
 * caller pairs this with `:nullType` in `extraValues`.
 */
export const NULL_TYPE_VALUE: AttributeValue = { S: 'NULL' }

export function unsetCondition(field: string): string {
  return `(attribute_not_exists(${field}) OR attribute_type(${field}, :nullType))`
}

/** Put a row that must not already exist. */
export function putTx(tableName: string, item: Row): TransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: marshallRow(item),
      ConditionExpression: 'attribute_not_exists(id)',
    },
  }
}

/**
 * A deterministic row id when the caller supplies a request token.
 *
 * The dialog sends one per Post press, so a retried mutation — a dropped response, a
 * double click, a Lambda retry — finds the row it already wrote and returns it instead
 * of moving the money twice.
 */
export function paymentId(prefix: string, partyId: string, clientRequestId: string | null): string {
  if (!clientRequestId) return `${prefix}-${randomUUID()}`
  const digest = createHash('sha256').update(`${partyId}:${clientRequestId}`).digest('hex')
  return `${prefix}-${digest.slice(0, 32)}`
}

/**
 * Post the transaction, treating "that row already exists" as success.
 *
 * The caller's pre-flight read catches a retry that arrives after the first one
 * finished; this catches the harder case — two copies of the same Post in flight at
 * once, where both read nothing and both try to write. The loser's transaction is
 * refused by `attribute_not_exists(id)` on the ledger put, and the right answer for it
 * is the row the winner wrote, not an error the user would retry a third time.
 *
 * Only ever reached with a caller-supplied `clientRequestId`: without one the id is a
 * fresh UUID and a collision is not a duplicate, it is a bug worth surfacing.
 */
export async function postOnce(
  tableName: string,
  writes: TransactWriteItem[],
  label: string,
  id: string,
  idempotent: boolean,
): Promise<boolean> {
  try {
    await transact(writes, label)
    return false
  } catch (err) {
    if (!idempotent) throw err
    const existing = await getById(tableName, id)
    if (!existing) throw err
    return true
  }
}

// ── settings and numbering ──────────────────────────────────────────────────

export async function getSettings(): Promise<Row> {
  return (await getById(SETTINGS_TABLE_NAME, SETTINGS_ID)) ?? { id: SETTINGS_ID }
}

/**
 * The next invoice number, taken with an atomic ADD.
 *
 * Deliberately taken BEFORE the transaction and never given back: if the transaction
 * fails, that number is simply never used. A gap in the sequence is a bookkeeping
 * curiosity; two invoices sharing a number is a dispute with a customer.
 */
export async function nextInvoiceNumber(caller: Caller, prefix: string, invoiceDate: string): Promise<string> {
  const now = nowIso()
  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: SETTINGS_TABLE_NAME,
      Key: marshall({ id: SETTINGS_ID }),
      UpdateExpression:
        'ADD nextInvoiceNumber :one SET createdAt = if_not_exists(createdAt, :now), updatedAt = :now, updatedBy = :by, #tn = if_not_exists(#tn, :tn)',
      ExpressionAttributeNames: { '#tn': '__typename' },
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':now': { S: now },
        ':by': { S: caller.email },
        ':tn': { S: 'TmsSettings' },
      },
      ReturnValues: 'ALL_NEW',
    }),
  )
  const settings = result.Attributes ? unmarshall(result.Attributes) : null
  const counter = numberOrNull(settings?.nextInvoiceNumber) ?? 1
  const format = typeof settings?.invoiceNumberFormat === 'string' && settings.invoiceNumberFormat.trim()
    ? settings.invoiceNumberFormat.trim()
    : DEFAULT_INVOICE_NUMBER_FORMAT
  return formatInvoiceNumber(format, { prefix, n: counter, date: invoiceDate })
}

// ── S3 ──────────────────────────────────────────────────────────────────────

export async function s3Bytes(key: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }))
  const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
  if (!body?.transformToByteArray) throw new Error(`Could not read ${key} out of storage`)
  return { bytes: await body.transformToByteArray(), contentType: out.ContentType ?? 'application/pdf' }
}

/** Store rendered PDF bytes under a key this Lambda built. Used for invoices and remittances. */
export async function putPdf(key: string, bytes: Uint8Array): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: bytes,
      ContentType: 'application/pdf',
    }),
  )
}

export function signedDownload(key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), {
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
  })
}

/** `invoices/{customerId}/{number}-v{n}.pdf` — the row and its bytes name each other. */
export function invoicePdfKey(customerId: string, number: string, version: number): string {
  const safeNumber = number.replace(/[^A-Za-z0-9._-]+/g, '-')
  return `invoices/${customerId}/${safeNumber}-v${version}.pdf`
}

/** `remittances/{carrierId}/{paymentId}-v{n}.pdf` — the row and its bytes name each other. */
export function remittancePdfKey(carrierId: string, paymentRowId: string, version: number): string {
  const safeId = paymentRowId.replace(/[^A-Za-z0-9._-]+/g, '-')
  return `remittances/${carrierId}/${safeId}-v${version}.pdf`
}
