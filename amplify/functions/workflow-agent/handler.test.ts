/**
 * workflow-agent handler tests — the four doors and the action router.
 *
 * Same in-memory DynamoDB engine as `run.test.ts`, for the same reason: the
 * claims worth defending are about which rows moved and which calls were
 * refused, and only an engine that records every command can tell.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

type Row = Record<string, unknown>

const TABLES = {
  run: 'WorkflowRun-test',
  payable: 'VendorPayable-test',
  shipment: 'Shipment-test',
  customer: 'Customer-test',
  carrier: 'Carrier-test',
  carrierContact: 'CarrierContact-test',
  location: 'Location-test',
  quote: 'Quote-test',
  shipmentDocument: 'ShipmentDocument-test',
  settings: 'TmsSettings-test',
  integration: 'Integration-test',
  audit: 'AuditLog-test',
}

const store = vi.hoisted(() => {
  process.env.WORKFLOW_RUN_TABLE_NAME = 'WorkflowRun-test'
  process.env.TABLE_NAME = 'VendorPayable-test'
  process.env.SHIPMENT_TABLE_NAME = 'Shipment-test'
  process.env.ORDER_TABLE_NAME = 'Order-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.LOAD_CARRIER_TABLE_NAME = 'LoadCarrier-test'
  process.env.CUSTOMER_TABLE_NAME = 'Customer-test'
  process.env.CARRIER_TABLE_NAME = 'Carrier-test'
  process.env.CARRIER_CONTACT_TABLE_NAME = 'CarrierContact-test'
  process.env.LOCATION_TABLE_NAME = 'Location-test'
  process.env.QUOTE_TABLE_NAME = 'Quote-test'
  process.env.SHIPMENT_DOCUMENT_TABLE_NAME = 'ShipmentDocument-test'
  process.env.TMS_SETTINGS_TABLE_NAME = 'TmsSettings-test'
  process.env.INTAKE_ITEM_TABLE_NAME = 'IntakeItem-test'
  process.env.DRIVER_SUBMISSION_TABLE_NAME = 'DriverSubmission-test'
  process.env.PRO_CLAIM_TABLE_NAME = 'ProClaim-test'
  process.env.INTEGRATION_TABLE_NAME = 'Integration-test'
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog-test'
  process.env.BUCKET_NAME = 'bcat-test-bucket'
  process.env.USER_POOL_ID = 'us-east-1_test'
  process.env.INBOX_SECRET = 'inbox-secret'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  return new Map<string, Map<string, Row>>()
})

const commands = vi.hoisted(() => [] as Array<{ type: string; table: string; item?: Row; key?: string; sets?: Row }>)
const s3Objects = vi.hoisted(() => new Map<string, { body: string; contentType: string }>())
const modelPrompts = vi.hoisted(() => [] as unknown[])
const modelReplies = vi.hoisted(() => [] as unknown[])

function table(name: string): Map<string, Row> {
  let t = store.get(name)
  if (!t) {
    t = new Map<string, Row>()
    store.set(name, t)
  }
  return t
}

class ConditionalCheckFailed extends Error {
  name = 'ConditionalCheckFailedException'
  constructor(message: string) {
    super(`ConditionalCheckFailedException: ${message}`)
  }
}

function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === separator && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

function conditionHolds(expression: string | undefined, existing: Row | null, values: Row): boolean {
  if (!expression) return true
  const exists = /^attribute_(not_)?exists\((\w+)\)$/.exec(expression.trim())
  if (exists) {
    const present = existing != null && existing[exists[2]] != null
    return exists[1] ? !present : present
  }
  const compare = /^#version\s*=\s*(:\w+)$/.exec(expression.trim())
  if (compare) return (existing?.version ?? 0) === values[compare[1]]
  throw new Error(`Unhandled condition: ${expression}`)
}

interface UpdateSpec {
  TableName: string
  Key: Record<string, unknown>
  UpdateExpression: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, unknown>
  ConditionExpression?: string
}

function applyUpdate(spec: UpdateSpec): Row {
  const t = table(spec.TableName)
  const key = unmarshall(spec.Key as never) as { id: string }
  const existing = t.get(key.id) ?? null
  const values = spec.ExpressionAttributeValues ? (unmarshall(spec.ExpressionAttributeValues as never) as Row) : {}
  const names = spec.ExpressionAttributeNames ?? {}
  const resolve = (token: string): string => (token.startsWith('#') ? names[token] : token)

  if (!conditionHolds(spec.ConditionExpression, existing, values)) {
    throw new ConditionalCheckFailed(`${spec.ConditionExpression} on ${spec.TableName}/${key.id}`)
  }

  const next: Row = { ...(existing ?? { id: key.id }) }
  const sets: Row = {}
  for (const part of spec.UpdateExpression.split(/\s+(?=SET\s|REMOVE\s|ADD\s)/)) {
    const m = /^(SET|REMOVE|ADD)\s+(.*)$/s.exec(part.trim())
    if (!m) continue
    if (m[1] === 'SET') {
      for (const assignment of splitTopLevel(m[2], ',')) {
        const eq = assignment.indexOf('=')
        const field = resolve(assignment.slice(0, eq).trim())
        const rhs = assignment.slice(eq + 1).trim()
        const bump = /^if_not_exists\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)\s*\+\s*(:\w+)$/.exec(rhs)
        if (bump) {
          const base = next[resolve(bump[1])] ?? values[bump[2]]
          next[field] = Number(base) + Number(values[bump[3]])
        } else {
          next[field] = values[rhs]
        }
        sets[field] = next[field]
      }
    }
    if (m[1] === 'REMOVE') {
      for (const token of splitTopLevel(m[2], ',')) delete next[resolve(token)]
    }
  }
  commands.push({ type: 'Update', table: spec.TableName, key: key.id, sets })
  t.set(key.id, next)
  return next
}

function scanFilter(expression: string | undefined, row: Row, names: Record<string, string>, values: Row): boolean {
  if (!expression) return true
  return expression.split(' AND ').every((term) => {
    const missing = /^attribute_not_exists\((\w+)\)$/.exec(term.trim())
    if (missing) return row[missing[1]] == null
    const compare = /^([#\w]+)\s*=\s*(:\w+)$/.exec(term.trim())
    if (compare) {
      const field = compare[1].startsWith('#') ? names[compare[1]] : compare[1]
      return row[field] === values[compare[2]]
    }
    const inList = /^([#\w]+)\s+IN\s+\(([^)]+)\)$/.exec(term.trim())
    if (inList) {
      const field = inList[1].startsWith('#') ? names[inList[1]] : inList[1]
      return inList[2].split(',').map((token) => values[token.trim()]).includes(row[field])
    }
    throw new Error(`Unhandled filter: ${term}`)
  })
}

const send = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send = send
  }
  const make = (type: string) =>
    class {
      input: Record<string, unknown>
      __type = type
      constructor(input: Record<string, unknown>) {
        this.input = input
      }
    }
  return {
    DynamoDBClient,
    GetItemCommand: make('Get'),
    PutItemCommand: make('Put'),
    UpdateItemCommand: make('Update'),
    QueryCommand: make('Query'),
    ScanCommand: make('Scan'),
    DeleteItemCommand: make('Delete'),
  }
})

class NotFound extends Error {
  name = 'NotFound'
}

const s3Send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = s3Send
  }
  const make = (type: string) =>
    class {
      input: Record<string, unknown>
      __type = type
      constructor(input: Record<string, unknown>) {
        this.input = input
      }
    }
  return {
    S3Client,
    GetObjectCommand: make('GetObject'),
    PutObjectCommand: make('PutObject'),
    HeadObjectCommand: make('Head'),
  }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://signed.test/put') }))

const cognitoSend = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-cognito-identity-provider', () => {
  class CognitoIdentityProviderClient {
    send = cognitoSend
  }
  class AdminGetUserCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  return { CognitoIdentityProviderClient, AdminGetUserCommand }
})

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      stream: (params: unknown) => {
        modelPrompts.push(params)
        const reply = modelReplies.length ? modelReplies.shift() : {}
        return {
          finalMessage: async () => ({
            content: [{ type: 'text', text: JSON.stringify(reply) }],
            usage: { input_tokens: 11, output_tokens: 7 },
          }),
        }
      },
    }
  }
  return { default: Anthropic }
})

interface MockCommand {
  __type: string
  input: Record<string, unknown>
}

send.mockImplementation(async (cmd: MockCommand) => {
  const input = cmd.input
  switch (cmd.__type) {
    case 'Get': {
      const key = unmarshall(input.Key as never) as { id: string }
      const item = table(String(input.TableName)).get(String(key.id))
      return { Item: item ? marshall(item, { removeUndefinedValues: true }) : undefined }
    }
    case 'Put': {
      const item = unmarshall(input.Item as never) as Row
      const t = table(String(input.TableName))
      if (input.ConditionExpression === 'attribute_not_exists(id)' && t.has(String(item.id))) {
        throw new ConditionalCheckFailed(`${String(input.TableName)}/${String(item.id)} exists`)
      }
      commands.push({ type: 'Put', table: String(input.TableName), item })
      t.set(String(item.id), item)
      return {}
    }
    case 'Update': {
      const next = applyUpdate(input as unknown as UpdateSpec)
      return { Attributes: marshall(next, { removeUndefinedValues: true }) }
    }
    case 'Delete': {
      commands.push({ type: 'Delete', table: String(input.TableName) })
      return {}
    }
    case 'Query': {
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
      const values = unmarshall(input.ExpressionAttributeValues as never) as Row
      const condition = String(input.KeyConditionExpression)
      const hashToken = condition.split(' ')[0]
      const field = names[hashToken] ?? hashToken
      let rows = [...table(String(input.TableName)).values()].filter((row) => row[field] === values[':v'])
      if (values[':before'] !== undefined) rows = rows.filter((row) => String(row.runUpdatedAt ?? row.updatedAt ?? '') < String(values[':before']))
      if (input.FilterExpression) rows = rows.filter((row) => scanFilter(String(input.FilterExpression), row, names, values))
      rows.sort((a, b) => String(a.runUpdatedAt ?? a.updatedAt ?? '').localeCompare(String(b.runUpdatedAt ?? b.updatedAt ?? '')))
      if (input.ScanIndexForward === false) rows.reverse()
      if (typeof input.Limit === 'number') rows = rows.slice(0, input.Limit)
      return { Items: rows.map((row) => marshall(row, { removeUndefinedValues: true })) }
    }
    case 'Scan': {
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
      const values = input.ExpressionAttributeValues ? (unmarshall(input.ExpressionAttributeValues as never) as Row) : {}
      const rows = [...table(String(input.TableName)).values()]
        .filter((row) => scanFilter(input.FilterExpression ? String(input.FilterExpression) : undefined, row, names, values))
      return { Items: rows.map((row) => marshall(row, { removeUndefinedValues: true })) }
    }
    default:
      throw new Error(`Unhandled command: ${cmd.__type}`)
  }
})

s3Send.mockImplementation(async (cmd: MockCommand) => {
  const key = String(cmd.input.Key)
  if (cmd.__type === 'PutObject') {
    s3Objects.set(key, { body: String(cmd.input.Body), contentType: String(cmd.input.ContentType ?? '') })
    return {}
  }
  const object = s3Objects.get(key)
  if (!object) throw new NotFound(`no such key ${key}`)
  if (cmd.__type === 'Head') return { ContentLength: Buffer.byteLength(object.body), ContentType: object.contentType }
  return {
    Body: {
      transformToString: async () => object.body,
      transformToByteArray: async () => new Uint8Array(Buffer.from(object.body)),
    },
  }
})

import { handler } from './handler'

// ── Identities ───────────────────────────────────────────────────────────────

const ADMIN = { sub: 'admin-sub', username: 'ryne', claims: { email: 'ryne@bcatcorp.com', 'cognito:groups': ['ADMIN'] } }
const DESK = { sub: 'desk-sub', username: 'sam', claims: { email: 'sam@bcatcorp.com', 'cognito:groups': ['page-tms'] } }

function call(action: string, input: unknown, identity: unknown = ADMIN) {
  return handler({ arguments: { action, input }, identity } as never)
}

function seedRun(overrides: Row): Row {
  const base: Row = {
    id: 'wf:TENDER:abc',
    agent: 'TENDER',
    status: 'COMPLETED',
    outcome: 'PROPOSED',
    sourceKind: 'INBOX',
    sourceId: 'm1',
    steps: [],
    attempts: 1,
    version: 3,
    createdBy: 'workflow-agent',
    updatedBy: 'workflow-agent',
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
  }
  const row = { ...base, ...overrides }
  table(TABLES.run).set(String(row.id), row)
  return row
}

beforeEach(() => {
  store.clear()
  commands.length = 0
  s3Objects.clear()
  modelPrompts.length = 0
  modelReplies.length = 0
  cognitoSend.mockReset()
  table(TABLES.settings).set('default', { id: 'default', aiAgents: { dailyRunCap: 200 } })
  table(TABLES.customer).set('cust1', { id: 'cust1', name: 'BATORY FOODS', contacts: [{ email: 'dispatch@batory.com' }], aliases: [] })
  table(TABLES.carrier).set('carr1', { id: 'carr1', name: 'SWIFT HAUL LLC', email: 'billing@swifthaul.com' })
})

describe('event discrimination', () => {
  it('answers the old vendor-ap-extract { id } payload by running the AP agent', async () => {
    table(TABLES.payable).set('email:v1', {
      id: 'email:v1', source: 'EMAIL', status: 'NEED_TO_PAY', subject: 'Invoice 1',
      fromEmail: 'ap@vendor.example', emailBody: 'bill', receivedAt: '2026-10-02T12:00:00.000Z', attachments: [],
    })
    modelReplies.push({}, { vendor: 'Acme', invoiceNumber: '1', amountDollars: 10, invoiceDate: null, dueDate: null, confidence: 'high', note: null })

    const result = await handler({ id: 'email:v1' } as never)

    expect(result).toMatchObject({ ok: true, result: 'PROPOSED' })
    expect([...table(TABLES.run).values()]).toHaveLength(1)
  })

  it('answers the old { all: true } backfill over every unread e-mail payable', async () => {
    table(TABLES.payable).set('email:v1', {
      id: 'email:v1', source: 'EMAIL', status: 'NEED_TO_PAY', subject: 'Invoice 1',
      fromEmail: 'ap@vendor.example', emailBody: 'bill', receivedAt: '2026-10-02T12:00:00.000Z', attachments: [],
    })
    table(TABLES.payable).set('maintenance:m1', { id: 'maintenance:m1', source: 'MAINTENANCE', subject: 'x' })
    table(TABLES.payable).set('email:v2', { id: 'email:v2', source: 'EMAIL', subject: 'read already', extractedAt: '2026-10-01T00:00:00.000Z' })
    modelReplies.push({}, { vendor: 'Acme', invoiceNumber: '1', amountDollars: 10, invoiceDate: null, dueDate: null, confidence: 'high', note: null })

    const result = await handler({ all: true } as never)

    expect(result).toMatchObject({ ok: true })
    expect(Object.keys((result as { results: Record<string, string> }).results)).toEqual(['email:v1'])
  })

  it('refuses a Function URL request with a bad secret and a bad role', async () => {
    const bad = await handler({
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({ action: 'prepare', secret: 'wrong', role: 'AP', messageId: 'm1' }),
    } as never)
    expect(bad).toMatchObject({ statusCode: 401 })

    const role = await handler({
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({ action: 'prepare', secret: 'inbox-secret', role: 'PAYROLL', messageId: 'm1' }),
    } as never)
    expect(role).toMatchObject({ statusCode: 422 })
  })

  it('prepares presigned uploads and commits a run from the inbox', async () => {
    const prepared = await handler({
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        action: 'prepare', secret: 'inbox-secret', role: 'TENDER', messageId: 'msg-1',
        subject: 'Tender', fromEmail: 'dispatch@batory.com', bodyText: 'Ref #: 1',
        attachments: [{ name: 'ratecon.pdf', contentType: 'application/pdf', size: 12 }],
      }),
    } as never)
    const prepareBody = JSON.parse((prepared as { body: string }).body)
    expect(prepareBody.uploadUrls).toHaveLength(1)

    // The bridge uploads; the commit must verify what it finds.
    s3Objects.set(prepareBody.uploadUrls[0].s3Key, { body: '%PDF-1.4 fake', contentType: 'application/pdf' })
    modelReplies.push({}, { invoice: {}, freight: {}, pickup: {}, delivery: {} })

    const committed = await handler({
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        action: 'commit', secret: 'inbox-secret', role: 'TENDER', messageId: 'msg-1',
        subject: 'Tender', fromEmail: 'dispatch@batory.com', bodyText: 'Ref #: 1',
        attachments: [{ name: 'ratecon.pdf', contentType: 'application/pdf', size: 13, s3Key: prepareBody.uploadUrls[0].s3Key }],
      }),
    } as never)

    const commitBody = JSON.parse((committed as { body: string }).body)
    expect(commitBody).toMatchObject({ ok: true, duplicate: false, runId: prepareBody.runId })
    expect(table(TABLES.run).get(prepareBody.runId)).toMatchObject({ status: 'COMPLETED' })
  })

  it('refuses a commit that names an object outside its own message folder', async () => {
    // The object exists and its headers match what the caller claims, which is exactly
    // the point: the only thing standing between a holder of the shared secret and
    // another message's invoice is the prefix check.
    s3Objects.set('intake-pdfs/vendor-ap/someone-elses-invoice.pdf', { body: '%PDF-1.4 fake', contentType: 'application/pdf' })

    const raw = await handler({
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        action: 'commit', secret: 'inbox-secret', role: 'AP', messageId: 'msg-foreign',
        subject: 'Invoice', fromEmail: 'ap@carrier.example', bodyText: 'see attached',
        attachments: [{
          name: 'invoice.pdf',
          contentType: 'application/pdf',
          size: 13,
          s3Key: 'intake-pdfs/vendor-ap/someone-elses-invoice.pdf',
        }],
      }),
    } as never)

    // The Function URL door always answers this shape; `handler` returns the union of
    // all four doors, so the compiler cannot narrow it from the event alone.
    const result = raw as { statusCode: number; body: string }
    expect(result.statusCode).toBe(422)
    expect(JSON.parse(result.body).error).toMatch(/outside this message's folder/)
    // Nothing was recorded: no message.json, no run.
    expect(table(TABLES.run).size).toBe(0)
  })
})

describe('the action router', () => {
  it('refuses a retry of a run a person already applied', async () => {
    seedRun({ id: 'wf:TENDER:applied', status: 'COMPLETED', outcome: 'APPLIED', version: 2 })
    await expect(call('RETRY_RUN', { id: 'wf:TENDER:applied', expectedVersion: 2 })).rejects.toThrow(/cannot be retried/)
    expect(table(TABLES.run).get('wf:TENDER:applied')).toMatchObject({ outcome: 'APPLIED', status: 'COMPLETED' })
  })

  it('refuses to link a run to a voided shipment', async () => {
    seedRun({ id: 'wf:TENDER:prop', outcome: 'PROPOSED', version: 1 })
    table(TABLES.shipment).set('sh-void', { id: 'sh-void', number: 'S000900', voidedAt: '2026-10-20T00:00:00.000Z' })

    await expect(call('LINK_RUN', { id: 'wf:TENDER:prop', shipmentId: 'sh-void', expectedVersion: 1 })).rejects.toThrow(/voided/)
    expect(table(TABLES.run).get('wf:TENDER:prop')).toMatchObject({ outcome: 'PROPOSED' })
  })

  it('links a proposed run to a live shipment and audits it', async () => {
    seedRun({ id: 'wf:TENDER:prop2', outcome: 'PROPOSED', version: 1 })
    table(TABLES.shipment).set('sh-live', { id: 'sh-live', number: 'S000901' })

    await call('LINK_RUN', { id: 'wf:TENDER:prop2', shipmentId: 'sh-live', expectedVersion: 1 })

    expect(table(TABLES.run).get('wf:TENDER:prop2')).toMatchObject({ outcome: 'APPLIED', shipmentId: 'sh-live', appliedBy: 'ryne@bcatcorp.com' })
    expect([...table(TABLES.audit).values()]).toHaveLength(1)
  })

  it('refuses to link freight another run already owns, and allows re-linking its own', async () => {
    seedRun({ id: 'wf:TENDER:second', outcome: 'PROPOSED', version: 1 })
    table(TABLES.shipment).set('sh-taken', { id: 'sh-taken', number: 'S000903', workflowRunId: 'wf:TENDER:first' })

    await expect(call('LINK_RUN', { id: 'wf:TENDER:second', shipmentId: 'sh-taken', expectedVersion: 1 }))
      .rejects.toThrow(/already linked to another run/)
    expect(table(TABLES.run).get('wf:TENDER:second')).toMatchObject({ outcome: 'PROPOSED' })

    // The run the shipment names is still allowed to record the link.
    seedRun({ id: 'wf:TENDER:first', outcome: 'PROPOSED', version: 1 })
    await call('LINK_RUN', { id: 'wf:TENDER:first', shipmentId: 'sh-taken', expectedVersion: 1 })
    expect(table(TABLES.run).get('wf:TENDER:first')).toMatchObject({ outcome: 'APPLIED', shipmentId: 'sh-taken' })
  })

  it('refuses RUN_SAMPLE from a page-tms caller who is not an admin', async () => {
    await expect(call('RUN_SAMPLE', { agent: 'QUOTE', subject: 's', body: 'b', fromEmail: 'a@b.com' }, DESK))
      .rejects.toThrow(/requires owner or ADMIN/)
    expect(modelPrompts).toHaveLength(0)
  })

  it('refuses a stale expectedVersion', async () => {
    seedRun({ id: 'wf:TENDER:stale', outcome: 'PROPOSED', version: 4 })
    await expect(call('DISMISS_RUN', { id: 'wf:TENDER:stale', reason: 'spam', expectedVersion: 2 }))
      .rejects.toThrow(/changed by someone else/)
  })

  it('dismisses with a reason and clears the exception', async () => {
    seedRun({ id: 'wf:TENDER:ex', outcome: 'UNKNOWN_PARTY', exceptionOpen: 'OPEN', version: 1 })
    await call('DISMISS_RUN', { id: 'wf:TENDER:ex', reason: 'Not our freight', expectedVersion: 1 })
    const row = table(TABLES.run).get('wf:TENDER:ex')
    expect(row).toMatchObject({ outcome: 'DISMISSED', dismissReason: 'Not our freight' })
    expect(row?.exceptionOpen).toBeUndefined()
  })

  it('keeps only the last twenty pieces of feedback', async () => {
    seedRun({ id: 'wf:TENDER:fb', feedback: Array.from({ length: 20 }, (_, i) => ({ at: `t${i}`, by: 'x', rating: 'UP', text: String(i) })) })
    await call('SAVE_FEEDBACK', { id: 'wf:TENDER:fb', rating: 'DOWN', text: 'twenty-one' })
    const feedback = table(TABLES.run).get('wf:TENDER:fb')?.feedback as Array<{ text: string }>
    expect(feedback).toHaveLength(20)
    expect(feedback[19].text).toBe('twenty-one')
    expect(feedback[0].text).toBe('1')
  })

  it('lists the exception queue and a single agent', async () => {
    seedRun({ id: 'wf:AP:open', agent: 'AP', outcome: 'UNKNOWN_PARTY', exceptionOpen: 'OPEN', updatedAt: '2026-10-29T11:00:00.000Z' })
    seedRun({ id: 'wf:TENDER:done', agent: 'TENDER', updatedAt: '2026-10-29T09:00:00.000Z' })

    const exceptions = (await call('LIST_EXCEPTIONS', {})) as Row[]
    expect(exceptions.map((r) => r.id)).toEqual(['wf:AP:open'])

    const tenders = (await call('LIST_RUNS', { agent: 'TENDER' })) as Row[]
    expect(tenders.map((r) => r.id)).toEqual(['wf:TENDER:done'])
  })

  it('never issues a DeleteItem, whatever the action', async () => {
    seedRun({ id: 'wf:TENDER:d1', outcome: 'UNKNOWN_PARTY', exceptionOpen: 'OPEN', version: 1 })
    table(TABLES.shipment).set('sh-live', { id: 'sh-live', number: 'S000902' })

    await call('LIST_RUNS', {})
    await call('GET_RUN', { id: 'wf:TENDER:d1' })
    await call('LIST_RUNS_FOR_SHIPMENT', { shipmentId: 'sh-live' })
    await call('LIST_EXCEPTIONS', {})
    await call('RESOLVE_EXCEPTION', { id: 'wf:TENDER:d1', reason: 'handled' })
    await call('SAVE_FEEDBACK', { id: 'wf:TENDER:d1', rating: 'UP' })
    const live = Number(table(TABLES.run).get('wf:TENDER:d1')?.version)
    await call('DISMISS_RUN', { id: 'wf:TENDER:d1', reason: 'done', expectedVersion: live })
    await call('SWEEP_STALLED', {})
    await call('BACKFILL_AP', {})

    expect(commands.filter((c) => c.type === 'Delete')).toEqual([])
  })
})
