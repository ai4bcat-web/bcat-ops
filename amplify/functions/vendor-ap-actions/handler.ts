import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import type { VendorPayable, VendorPayableStatus } from '../../../src/types/vendorAp'

const dynamo = new DynamoDBClient({})
const TABLE_NAME = process.env.TABLE_NAME!
const MAINTENANCE_TABLE_NAME = process.env.MAINTENANCE_TABLE_NAME!
// `||` so an empty string also falls back (same as userManagement).
const USER_POOL_ID = process.env.USER_POOL_ID || 'us-east-1_IbPKPNJC9'
const cognito = new CognitoIdentityProviderClient({})

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'

const MAX_VENDOR_LEN = 255
const MAX_INVOICE_NUMBER_LEN = 100
const MAX_DESCRIPTION_LEN = 4000
const MAX_PAYMENT_METHOD_LEN = 100
const MAX_PAYMENT_REFERENCE_LEN = 255

// ── Event shapes ───────────────────────────────────────────────────────────

interface AppSyncIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

interface AppSyncEvent {
  arguments: {
    action: string
    id?: string | null
    maintenanceInvoiceId?: string | null
    input?: string | Record<string, unknown> | null
  }
  identity?: AppSyncIdentity | null
}

type Action = 'SEND_MAINTENANCE' | 'UPDATE_DETAILS' | 'COMPLETE' | 'REOPEN'

interface ActionResult {
  item: VendorPayable
  duplicate?: boolean
}

// ── Input / auth helpers ───────────────────────────────────────────────────

export function parseInput(input: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (input == null) return {}
  if (typeof input === 'string') {
    if (!input.trim()) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(input)
    } catch {
      throw new Error('Invalid input: not valid JSON')
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Invalid input: must be a JSON object')
    }
    return parsed as Record<string, unknown>
  }
  if (Array.isArray(input) || typeof input !== 'object') {
    throw new Error('Invalid input: must be an object')
  }
  return input
}

/**
 * Amplify sends the Cognito ACCESS token, which has no `email` claim, and usernames
 * here are UUIDs — so after the cheap claim checks fall back to AdminGetUser, exactly
 * like userManagement does. Groups are always in the token, so authorization never
 * depends on this lookup; only the owner check and `paidBy` do.
 */
async function getCallerEmail(identity: AppSyncIdentity): Promise<string> {
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
    console.warn('[vendor-ap-actions] could not resolve caller email:', String(err))
    return ''
  }
}

function getGroups(identity?: AppSyncIdentity | null): string[] {
  if (!identity) return []
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

/** ES2020 lib lacks the ErrorOptions constructor; attach the cause explicitly. */
function conflictError(message: string, cause: unknown): Error {
  const error = new Error(message)
  ;(error as Error & { cause?: unknown }).cause = cause
  return error
}

function errorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    return err.name
  }
  return undefined
}

async function authorize(action: Action, identity?: AppSyncIdentity | null): Promise<{ email: string; sub: string }> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await getCallerEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  const isOwner = email === OWNER_EMAIL
  const isAdmin = groups.includes(ADMIN_GROUP)
  const hasVendorAp = groups.includes('page-vendorAp')

  if (action === 'SEND_MAINTENANCE') {
    const hasInvoices = groups.includes('page-invoices')
    if (!isOwner && !isAdmin && !hasInvoices && !hasVendorAp) {
      throw new Error('Forbidden: SEND_MAINTENANCE requires owner, ADMIN, page-invoices, or page-vendorAp')
    }
  } else {
    if (!isOwner && !isAdmin && !hasVendorAp) {
      throw new Error(`Forbidden: ${action} requires owner, ADMIN, or page-vendorAp`)
    }
  }

  return { email, sub: identity.sub }
}

// ── Validation helpers ─────────────────────────────────────────────────────

function assertDefined<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`${label} is required`)
  return value
}

function validateNonEmptyString(value: unknown, maxLen: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} cannot be empty`)
  if (trimmed.length > maxLen) throw new Error(`${label} exceeds maximum length of ${maxLen}`)
  return trimmed
}

function validateNullableString(value: unknown, maxLen: number): string | null {
  if (value == null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > maxLen) throw new Error(`Field exceeds maximum length of ${maxLen}`)
  return trimmed
}

function validateIntegerCents(value: unknown): number {
  let num: number
  if (typeof value === 'string') {
    num = Number(value)
  } else if (typeof value === 'number') {
    num = value
  } else {
    throw new Error('Amount must be an integer number of cents')
  }
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error('Amount must be an integer number of cents')
  }
  if (num < 0) throw new Error('Amount cannot be negative')
  return num
}

function snapshotAmount(value: unknown): number | null {
  if (value == null || value === '') return null
  return validateIntegerCents(value)
}

function validateDateString(value: unknown): string {
  const str = typeof value === 'string' ? value : String(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    throw new Error('Date must be YYYY-MM-DD')
  }
  const [year, month, day] = str.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error('Date is not a valid calendar date')
  }
  return str
}

function nowIso(): string {
  return new Date().toISOString()
}

// ── Domain helpers ─────────────────────────────────────────────────────────

function sourcePaymentMethod(source: Record<string, unknown>): string | null {
  const value = source.paymentMethod
  if (value == null || value === '') return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function sourcePaymentDate(source: Record<string, unknown>): string | null {
  const value = source.paymentDate
  if (value == null || value === '') return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function buildMaintenanceSubject(vendor: string | null, invoiceNumber: string | null): string {
  const v = vendor ?? 'Repair'
  if (invoiceNumber) return `${v} #${invoiceNumber}`
  return v
}

interface MaintenanceSnapshot {
  vendor: string | null
  invoiceNumber: string | null
  amount: number | null
  invoiceDate: string | null
  description: string | null
  subject: string
}

function buildSnapshotFromSource(source: Record<string, unknown>): MaintenanceSnapshot {
  const vendor = validateNullableString(source.vendor, MAX_VENDOR_LEN)
  const invoiceNumber = validateNullableString(source.invoiceNumber, MAX_INVOICE_NUMBER_LEN)
  const description = validateNullableString(source.description, MAX_DESCRIPTION_LEN)
  const amount = snapshotAmount(source.amount)
  const invoiceDate = source.date != null && source.date !== '' ? validateDateString(source.date) : null
  const subject = buildMaintenanceSubject(vendor, invoiceNumber)
  return { vendor, invoiceNumber, amount, invoiceDate, description, subject }
}

// ── DynamoDB helpers ───────────────────────────────────────────────────────

async function getAp(id: string): Promise<VendorPayable | null> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ id }),
      ConsistentRead: true,
    }),
  )
  if (!result.Item) return null
  return unmarshall(result.Item) as VendorPayable
}

async function getMaintenanceInvoice(id: string): Promise<Record<string, unknown> | null> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: MAINTENANCE_TABLE_NAME,
      Key: marshall({ id }),
      ConsistentRead: true,
    }),
  )
  if (!result.Item) return null
  return unmarshall(result.Item)
}


// ── Actions ────────────────────────────────────────────────────────────────

async function sendMaintenanceAction(
  args: { maintenanceInvoiceId?: string | null },
): Promise<ActionResult> {
  const maintenanceInvoiceId = assertDefined(args.maintenanceInvoiceId, 'maintenanceInvoiceId')
  const id = `maintenance:${maintenanceInvoiceId}`

  // Check for an existing AP row first. A DONE row is returned as a duplicate
  // even if the source invoice has since been paid or archived.
  const existing = await getAp(id)
  if (existing?.status === 'DONE') {
    return { item: existing, duplicate: true }
  }

  const source = await getMaintenanceInvoice(maintenanceInvoiceId)
  if (!source) {
    throw new Error(`Source maintenance invoice not found: ${maintenanceInvoiceId}`)
  }

  const snapshot = buildSnapshotFromSource(source)
  const now = nowIso()

  if (existing) {
    // A queued invoice must stay resolvable even if the source was archived later; the
    // snapshot refresh only fails when the source no longer exists.
    // Refresh the read-only snapshot without touching status / payment fields.
    const names: Record<string, string> = {
      '#updatedAt': 'updatedAt',
      '#vendor': 'vendor',
      '#invoiceNumber': 'invoiceNumber',
      '#amount': 'amount',
      '#invoiceDate': 'invoiceDate',
      '#description': 'description',
      '#subject': 'subject',
    }
    const values: Record<string, AttributeValue> = {
      ':updatedAt': { S: now },
      ':vendor': snapshot.vendor != null ? { S: snapshot.vendor } : { NULL: true },
      ':invoiceNumber': snapshot.invoiceNumber != null ? { S: snapshot.invoiceNumber } : { NULL: true },
      ':amount': snapshot.amount != null ? { N: String(snapshot.amount) } : { NULL: true },
      ':invoiceDate': snapshot.invoiceDate != null ? { S: snapshot.invoiceDate } : { NULL: true },
      ':description': snapshot.description != null ? { S: snapshot.description } : { NULL: true },
      ':subject': { S: snapshot.subject },
    }
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ id }),
        ConditionExpression: 'attribute_exists(id)',
        UpdateExpression:
          'SET #updatedAt = :updatedAt, #vendor = :vendor, #invoiceNumber = :invoiceNumber, #amount = :amount, #invoiceDate = :invoiceDate, #description = :description, #subject = :subject',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    if (!result.Attributes) throw new Error('Refresh failed')
    return { item: unmarshall(result.Attributes) as VendorPayable, duplicate: true }
  }

  // No existing AP: enforce source eligibility rules.
  if (source.status === 'ARCHIVED') {
    throw new Error('Cannot send archived maintenance invoice to AP')
  }
  if (sourcePaymentDate(source)) {
    throw new Error('Cannot send already-paid maintenance invoice to AP')
  }

  const item: VendorPayable & { __typename: string } = {
    __typename: 'VendorPayable',
    id,
    status: 'NEED_TO_PAY',
    source: 'MAINTENANCE',
    sourceInvoiceId: maintenanceInvoiceId,
    sourceMessageId: null,
    subject: snapshot.subject,
    vendor: snapshot.vendor,
    invoiceNumber: snapshot.invoiceNumber,
    amount: snapshot.amount,
    invoiceDate: snapshot.invoiceDate,
    description: snapshot.description,
    fromEmail: null,
    emailBody: null,
    attachments: [],
    receivedAt: now,
    paymentMethod: null,
    paymentDate: null,
    paymentReference: null,
    paidBy: null,
    paidAt: null,
    createdAt: now,
    updatedAt: now,
  }

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )
    return { item }
  } catch (err: unknown) {
    if (errorName(err) === 'ConditionalCheckFailedException') {
      const race = await getAp(id)
      if (!race) throw conflictError('Duplicate detection failed: item disappeared', err)
      return { item: race, duplicate: true }
    }
    throw err
  }
}

async function updateDetailsAction(
  args: { id?: string | null; input?: Record<string, unknown> },
): Promise<ActionResult> {
  const id = assertDefined(args.id, 'id')
  const input = args.input ?? {}
  const expectedUpdatedAt = assertDefined(input.expectedUpdatedAt, 'expectedUpdatedAt')
  if (typeof expectedUpdatedAt !== 'string') throw new Error('expectedUpdatedAt must be a string')

  const existing = await getAp(id)
  if (!existing) throw new Error(`Vendor payable not found: ${id}`)

  if (existing.source === 'MAINTENANCE') {
    throw new Error('Maintenance source details cannot be edited from AP; edit the original invoice')
  }
  if (existing.source !== 'EMAIL') {
    throw new Error(`Unsupported source for update: ${existing.source}`)
  }

  const updates: Partial<Pick<VendorPayable, 'vendor' | 'invoiceNumber' | 'amount' | 'invoiceDate' | 'description'>> = {}

  if ('vendor' in input) updates.vendor = validateNullableString(input.vendor, MAX_VENDOR_LEN)
  if ('invoiceNumber' in input) {
    updates.invoiceNumber = validateNullableString(input.invoiceNumber, MAX_INVOICE_NUMBER_LEN)
  }
  if ('amount' in input) updates.amount = input.amount != null ? validateIntegerCents(input.amount) : null
  if ('invoiceDate' in input) {
    updates.invoiceDate = input.invoiceDate != null ? validateDateString(input.invoiceDate) : null
  }
  if ('description' in input) updates.description = validateNullableString(input.description, MAX_DESCRIPTION_LEN)

  if (Object.keys(updates).length === 0) {
    throw new Error('No editable fields provided')
  }

  const now = nowIso()
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' }
  const values: Record<string, AttributeValue> = {
    ':updatedAt': { S: now },
    ':expectedUpdatedAt': { S: expectedUpdatedAt },
  }
  const setParts: string[] = ['#updatedAt = :updatedAt']

  for (const [key, value] of Object.entries(updates)) {
    names[`#${key}`] = key
    values[`:${key}`] = marshall({ [key]: value })[key]
    setParts.push(`#${key} = :${key}`)
  }

  let result
  try {
    result = await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ id }),
        ConditionExpression: '#updatedAt = :expectedUpdatedAt',
        UpdateExpression: `SET ${setParts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
  } catch (err: unknown) {
    if (errorName(err) === 'ConditionalCheckFailedException') {
      throw conflictError('This invoice changed since you opened it. Refresh the queue and try again.', err)
    }
    throw err
  }
  if (!result.Attributes) throw new Error('Update failed')
  return { item: unmarshall(result.Attributes) as VendorPayable }
}

async function completeAction(
  args: { id?: string | null; input?: Record<string, unknown> },
  caller: { email: string; sub: string },
): Promise<ActionResult> {
  const id = assertDefined(args.id, 'id')
  const input = args.input ?? {}
  const expectedUpdatedAt = assertDefined(input.expectedUpdatedAt, 'expectedUpdatedAt')
  if (typeof expectedUpdatedAt !== 'string') throw new Error('expectedUpdatedAt must be a string')

  const paymentDate = validateDateString(input.paymentDate)
  const paymentMethod = validateNonEmptyString(input.paymentMethod, MAX_PAYMENT_METHOD_LEN, 'paymentMethod')
  const paymentReference = input.paymentReference != null
    ? validateNonEmptyString(input.paymentReference, MAX_PAYMENT_REFERENCE_LEN, 'paymentReference')
    : null

  const existing = await getAp(id)
  if (!existing) throw new Error(`Vendor payable not found: ${id}`)

  const sourceInvoiceId = existing.sourceInvoiceId
  const now = nowIso()

  const transactItems: TransactWriteItem[] = []

  // AP update: optimistic on expectedUpdatedAt; allow completion from NEED_TO_PAY
  // or correction of a DONE row (source payment is verified separately against the
  // existing AP payment, not the new input).
  const apNames: Record<string, string> = {
    '#status': 'status',
    '#updatedAt': 'updatedAt',
    '#paymentMethod': 'paymentMethod',
    '#paymentDate': 'paymentDate',
    '#paymentReference': 'paymentReference',
    '#paidBy': 'paidBy',
    '#paidAt': 'paidAt',
  }
  const apValues: Record<string, AttributeValue> = {
    ':expectedUpdatedAt': { S: expectedUpdatedAt },
    ':needToPay': { S: 'NEED_TO_PAY' },
    ':done': { S: 'DONE' as VendorPayableStatus },
    ':updatedAt': { S: now },
    ':method': { S: paymentMethod },
    ':date': { S: paymentDate },
    ':reference': paymentReference != null ? { S: paymentReference } : { NULL: true },
    ':paidBy': { S: caller.email },
    ':paidAt': { S: now },
  }
  const apSetParts = [
    '#status = :done', '#updatedAt = :updatedAt', '#paymentMethod = :method', '#paymentDate = :date',
    '#paymentReference = :reference', '#paidBy = :paidBy', '#paidAt = :paidAt',
  ]

  if (sourceInvoiceId) {
    const source = await getMaintenanceInvoice(sourceInvoiceId)
    if (!source) {
      throw new Error(`Linked maintenance invoice not found: ${sourceInvoiceId}.`)
    }

    // The source may have been edited (vendor typo, amount fix) since it was sent.
    // The source `updatedAt` guard below makes this read consistent with the write, so
    // fold the current snapshot into the AP row instead of refusing the payment.
    const snapshot = buildSnapshotFromSource(source)
    Object.assign(apNames, {
      '#vendor': 'vendor', '#invoiceNumber': 'invoiceNumber', '#amount': 'amount',
      '#invoiceDate': 'invoiceDate', '#description': 'description', '#subject': 'subject',
    })
    Object.assign(apValues, {
      ':vendor': snapshot.vendor != null ? { S: snapshot.vendor } : { NULL: true },
      ':invoiceNumber': snapshot.invoiceNumber != null ? { S: snapshot.invoiceNumber } : { NULL: true },
      ':amount': snapshot.amount != null ? { N: String(snapshot.amount) } : { NULL: true },
      ':invoiceDate': snapshot.invoiceDate != null ? { S: snapshot.invoiceDate } : { NULL: true },
      ':description': snapshot.description != null ? { S: snapshot.description } : { NULL: true },
      ':subject': { S: snapshot.subject },
    })
    apSetParts.push(
      '#vendor = :vendor', '#invoiceNumber = :invoiceNumber', '#amount = :amount',
      '#invoiceDate = :invoiceDate', '#description = :description', '#subject = :subject',
    )

    const existingApMethod = existing.paymentMethod ?? ''
    const existingApDate = existing.paymentDate ?? ''
    const sourceMethod = sourcePaymentMethod(source) ?? ''
    const sourceDate = sourcePaymentDate(source) ?? ''

    if (existingApDate !== '') {
      // AP already recorded a payment. The source must still reflect that same
      // payment before we overwrite it with the corrected/new input.
      if (sourceMethod !== existingApMethod || sourceDate !== existingApDate) {
        throw new Error(
          `Linked maintenance invoice payment does not match this AP (${existingApMethod || 'method'} / ${existingApDate || 'date'}).`,
        )
      }
    } else if (sourceDate !== '') {
      throw new Error(
        `Linked maintenance invoice is already paid (${sourceMethod || 'method'} / ${sourceDate || 'date'}).`,
      )
    }

    const sourceUpdatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : ''
    const sourceNames: Record<string, string> = {
      '#updatedAt': 'updatedAt',
      '#paymentMethod': 'paymentMethod',
      '#paymentDate': 'paymentDate',
    }
    const sourceValues: Record<string, AttributeValue> = {}
    const sourceConditionParts = ['attribute_exists(id)']

    if (sourceUpdatedAt !== '') {
      sourceValues[':sourceUpdatedAt'] = { S: sourceUpdatedAt }
      sourceConditionParts.push('#updatedAt = :sourceUpdatedAt')
    } else {
      // Legacy rows without updatedAt: match the observed payment fields.
      if (sourceMethod !== '') {
        sourceValues[':sourceMethod'] = { S: sourceMethod }
        sourceConditionParts.push('#paymentMethod = :sourceMethod')
      } else {
        sourceConditionParts.push('attribute_not_exists(#paymentMethod)')
      }
      if (sourceDate !== '') {
        sourceValues[':sourceDate'] = { S: sourceDate }
        sourceConditionParts.push('#paymentDate = :sourceDate')
      } else {
        sourceConditionParts.push('attribute_not_exists(#paymentDate)')
      }
    }

    transactItems.push({
      Update: {
        TableName: MAINTENANCE_TABLE_NAME,
        Key: marshall({ id: sourceInvoiceId }),
        ConditionExpression: sourceConditionParts.join(' AND '),
        UpdateExpression: 'SET #paymentMethod = :method, #paymentDate = :date, #updatedAt = :updatedAt',
        ExpressionAttributeNames: sourceNames,
        ExpressionAttributeValues: {
          ...sourceValues,
          ':method': { S: paymentMethod },
          ':date': { S: paymentDate },
          ':updatedAt': { S: now },
        },
      },
    })
  }

  // AP item leads the transaction (tests and the conflict message read it as [0]).
  transactItems.unshift({
    Update: {
      TableName: TABLE_NAME,
      Key: marshall({ id }),
      ConditionExpression: '#updatedAt = :expectedUpdatedAt AND (#status = :needToPay OR #status = :done)',
      UpdateExpression: `SET ${apSetParts.join(', ')}`,
      ExpressionAttributeNames: apNames,
      ExpressionAttributeValues: apValues,
    },
  })

  try {
    await dynamo.send(new TransactWriteItemsCommand({ TransactItems: transactItems }))
  } catch (err: unknown) {
    if (errorName(err) === 'TransactionCanceledException') {
      throw conflictError(
        'Conflict: the linked maintenance invoice was paid or edited by someone else, or this AP row changed. Refresh the queue and try again.',
        err,
      )
    }
    throw err
  }

  const updated = await getAp(id)
  if (!updated) throw new Error('AP item disappeared after update')
  return { item: updated }
}

async function reopenAction(
  args: { id?: string | null; input?: Record<string, unknown> },
): Promise<ActionResult> {
  const id = assertDefined(args.id, 'id')
  const input = args.input ?? {}
  const expectedUpdatedAt = assertDefined(input.expectedUpdatedAt, 'expectedUpdatedAt')
  if (typeof expectedUpdatedAt !== 'string') throw new Error('expectedUpdatedAt must be a string')

  const existing = await getAp(id)
  if (!existing) throw new Error(`Vendor payable not found: ${id}`)
  if (existing.status !== 'DONE') {
    throw new Error('Cannot reopen: vendor payable is not completed')
  }

  const sourceInvoiceId = existing.sourceInvoiceId
  const now = nowIso()

  const transactItems: TransactWriteItem[] = []

  transactItems.push({
    Update: {
      TableName: TABLE_NAME,
      Key: marshall({ id }),
      ConditionExpression: '#updatedAt = :expectedUpdatedAt AND #status = :done',
      UpdateExpression:
        'SET #status = :needToPay, #updatedAt = :updatedAt, #paymentMethod = :empty, #paymentDate = :empty, #paymentReference = :empty, #paidBy = :empty, #paidAt = :empty',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#updatedAt': 'updatedAt',
        '#paymentMethod': 'paymentMethod',
        '#paymentDate': 'paymentDate',
        '#paymentReference': 'paymentReference',
        '#paidBy': 'paidBy',
        '#paidAt': 'paidAt',
      },
      ExpressionAttributeValues: {
        ':expectedUpdatedAt': { S: expectedUpdatedAt },
        ':done': { S: 'DONE' as VendorPayableStatus },
        ':needToPay': { S: 'NEED_TO_PAY' },
        ':updatedAt': { S: now },
        ':empty': { NULL: true },
      },
    },
  })

  if (sourceInvoiceId) {
    const source = await getMaintenanceInvoice(sourceInvoiceId)
    if (!source) {
      throw new Error(`Linked maintenance invoice not found: ${sourceInvoiceId}. Cannot reopen without source.`)
    }

    const apMethod = existing.paymentMethod ?? ''
    const apDate = existing.paymentDate ?? ''
    const sourceMethod = sourcePaymentMethod(source) ?? ''
    const sourceDate = sourcePaymentDate(source) ?? ''

    if (apDate === '') {
      throw new Error('Cannot reopen: AP has no recorded payment date')
    }
    if (sourceMethod !== apMethod || sourceDate !== apDate) {
      throw new Error(
        'Cannot reopen: linked maintenance invoice payment has changed externally. Undo the external payment first.',
      )
    }

    const sourceUpdatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : ''
    const sourceNames: Record<string, string> = {
      '#updatedAt': 'updatedAt',
      '#paymentMethod': 'paymentMethod',
      '#paymentDate': 'paymentDate',
    }
    const sourceValues: Record<string, AttributeValue> = {}
    const sourceConditionParts = ['attribute_exists(id)']

    if (sourceUpdatedAt !== '') {
      sourceValues[':sourceUpdatedAt'] = { S: sourceUpdatedAt }
      sourceConditionParts.push('#updatedAt = :sourceUpdatedAt')
    } else {
      // Legacy rows without updatedAt: match the observed payment fields.
      if (sourceMethod !== '') {
        sourceValues[':sourceMethod'] = { S: sourceMethod }
        sourceConditionParts.push('#paymentMethod = :sourceMethod')
      } else {
        sourceConditionParts.push('attribute_not_exists(#paymentMethod)')
      }
      if (sourceDate !== '') {
        sourceValues[':sourceDate'] = { S: sourceDate }
        sourceConditionParts.push('#paymentDate = :sourceDate')
      } else {
        sourceConditionParts.push('attribute_not_exists(#paymentDate)')
      }
    }

    transactItems.push({
      Update: {
        TableName: MAINTENANCE_TABLE_NAME,
        Key: marshall({ id: sourceInvoiceId }),
        ConditionExpression: sourceConditionParts.join(' AND '),
        UpdateExpression: 'REMOVE #paymentMethod, #paymentDate SET #updatedAt = :updatedAt',
        ExpressionAttributeNames: sourceNames,
        ExpressionAttributeValues: { ...sourceValues, ':updatedAt': { S: now } },
      },
    })
  }

  try {
    await dynamo.send(new TransactWriteItemsCommand({ TransactItems: transactItems }))
  } catch (err: unknown) {
    if (errorName(err) === 'TransactionCanceledException') {
      throw conflictError('Conflict: linked invoice was modified or the AP row was already updated', err)
    }
    throw err
  }

  const updated = await getAp(id)
  if (!updated) throw new Error('AP item disappeared after reopen')
  return { item: updated }
}

// ── Handler ────────────────────────────────────────────────────────────────

export const handler = async (event: AppSyncEvent): Promise<ActionResult> => {
  const action = event.arguments.action as Action
  const caller = await authorize(action, event.identity)
  const input = parseInput(event.arguments.input)

  switch (action) {
    case 'SEND_MAINTENANCE':
      return sendMaintenanceAction({ maintenanceInvoiceId: event.arguments.maintenanceInvoiceId })
    case 'UPDATE_DETAILS':
      return updateDetailsAction({ id: event.arguments.id, input })
    case 'COMPLETE':
      return completeAction({ id: event.arguments.id, input }, caller)
    case 'REOPEN':
      return reopenAction({ id: event.arguments.id, input })
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
