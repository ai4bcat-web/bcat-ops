import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm'
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'

type HandlerModule = typeof import('./handler')

vi.mock('./scan', () => ({
  enhancePodImage: vi.fn().mockResolvedValue({
    bytes: Buffer.from('enhanced-image'),
    contentType: 'image/jpeg' as const,
  }),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}))

import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

interface WsHandlers {
  on(event: 'open' | 'message' | 'error', cb: unknown): void
  send(data: string): void
  close(): void
}

// Mutable WebSocket handler registry so sync tests can simulate the JobsDone socket.
let wsHandlers: WsHandlers = { on() {}, send() {}, close() {} }

vi.mock('ws', () => ({
  default: class WebSocket {
    on(event: 'open' | 'message' | 'error', cb: unknown) {
      wsHandlers.on(event, cb)
    }
    send(data: string) {
      wsHandlers.send(data)
    }
    close() {
      wsHandlers.close()
    }
  },
}))

let handler: HandlerModule['handler']
let parseInput: HandlerModule['parseInput']
let authorize: HandlerModule['authorize']
let configureAction: HandlerModule['configureAction']
let statusAction: HandlerModule['statusAction']
let listAction: HandlerModule['listAction']
let syncAction: HandlerModule['syncAction']
let assignAction: HandlerModule['assignAction']
let assetsAction: HandlerModule['assetsAction']
let stableDocumentId: HandlerModule['stableDocumentId']
let processPodDocument: HandlerModule['processPodDocument']
let resetConnectionConfigCache: HandlerModule['resetConnectionConfigCache']

const mockFetch = vi.fn()
const mockLambda = vi.fn()
const mockSsm = vi.fn()
const mockCognito = vi.fn()

let dynamoSpy: ReturnType<typeof vi.spyOn>
let lambdaSpy: ReturnType<typeof vi.spyOn>
let ssmSpy: ReturnType<typeof vi.spyOn>

// ── Minimal in-memory DynamoDB simulator for unit tests ──────────────────────
class MemoryStore {
  pods = new Map<string, Record<string, unknown>>()
  loads = new Map<string, Record<string, unknown>>()
  private tableFor(cmd: { input: { TableName?: string } }) {
    return cmd.input.TableName as string
  }
  private keyFor(cmd: { input: { Key?: Record<string, AttributeValue> } }): string {
    const key = unmarshall(cmd.input.Key as Record<string, AttributeValue>)
    return key.id as string
  }
  private evaluateCondition(
    condition: string,
    item: Record<string, unknown> | null,
    names: Record<string, string>,
    values: Record<string, AttributeValue>,
  ): boolean {
    const rawValues = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, unmarshall({ __v: v }).__v]),
    )
    const val = (expr: string) => {
      expr = expr.trim()
      if (expr.startsWith(':')) return rawValues[expr]
      if (expr.startsWith('#')) return item?.[names[expr] ?? expr]
      return expr.replace(/^['"]|['"]$/g, '') // strip quotes
    }
    const parts = condition.split(/\s+OR\s+/i)
    for (const part of parts) {
      const cmp = part.trim()
      if (cmp === 'attribute_exists(id)') return item != null
      if (cmp === 'attribute_not_exists(id)') return item == null
      if (cmp === 'attribute_not_exists(processingLeaseUntil)') return item == null || item.processingLeaseUntil == null
      if (cmp === 'attribute_not_exists(contentType)') return item == null || item.contentType == null
      const m = cmp.match(/^(#\w+|\S+)\s*(=|<|>)\s*(:\w+|#\w+|\S+)$/)
      if (!m) continue
      const [_, leftExpr, op, rightExpr] = m
      const left = leftExpr.startsWith('#') ? item?.[names[leftExpr] ?? leftExpr] : leftExpr
      const right = val(rightExpr)
      if (op === '=' && left === right) return true
      if (op === '<' && typeof left === 'string' && typeof right === 'string' && left < right) return true
      if (op === '>' && typeof left === 'string' && typeof right === 'string' && left > right) return true
    }
    return false
  }
  private applyUpdate(
    item: Record<string, unknown>,
    updateExpression: string,
    names: Record<string, string>,
    values: Record<string, AttributeValue>,
  ) {
    const rawValues = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, unmarshall({ __v: v }).__v]),
    )
    // DynamoDB rejects any #name placeholder that ExpressionAttributeNames does not
    // define; mirror that so a missing name fails here instead of only in the cloud.
    for (const placeholder of updateExpression.match(/#[A-Za-z0-9_]+/g) ?? []) {
      if (!(placeholder in names)) {
        const err = new Error(`Invalid UpdateExpression: An expression attribute name used in the document path is not defined; attribute name: ${placeholder}`)
        ;(err as unknown as Record<string, string>).name = 'ValidationException'
        throw err
      }
    }
    const setMatch = updateExpression.match(/^SET\s+(.+?)(?:\s+REMOVE\s+(.+))?$/i)
    if (!setMatch) {
      const removeMatch = updateExpression.match(/^REMOVE\s+(.+)$/i)
      if (removeMatch) {
        for (const expr of removeMatch[1].split(/,\s*/)) {
          const field = names[expr.trim()]
          if (field) delete item[field]
        }
        return
      }
      throw new Error('Unsupported update expression')
    }
    for (const pair of setMatch[1].split(/,\s*/)) {
      const [nameExpr, valueExpr] = pair.split('=').map((s) => s.trim())
      const field = names[nameExpr]
      if (!field) continue
      if (valueExpr === 'null' || valueExpr === ':emptyError' || valueExpr === ':empty') {
        // null sentinel values from handler
        const v = rawValues[valueExpr]
        item[field] = v ?? null
      } else {
        item[field] = rawValues[valueExpr]
      }
    }
    if (setMatch[2]) {
      for (const expr of setMatch[2].split(/,\s*/)) {
        const field = names[expr.trim()]
        if (field) delete item[field]
      }
    }
  }
  getItem(cmd: InstanceType<typeof GetItemCommand>) {
    const key = this.keyFor({ input: cmd.input })
    if (this.tableFor({ input: cmd.input }) === process.env.LOAD_TABLE_NAME) {
      return { Item: this.loads.has(key) ? marshall(this.loads.get(key)!) : undefined }
    }
    return { Item: this.pods.has(key) ? marshall(this.pods.get(key)!) : undefined }
  }
  putItem(cmd: InstanceType<typeof PutItemCommand>) {
    const key = unmarshall(cmd.input.Item as Record<string, AttributeValue>).id as string
    if (cmd.input.ConditionExpression === 'attribute_not_exists(id)' && this.pods.has(key)) {
      const err = new Error('conditional')
      ;(err as unknown as Record<string, string>).name = 'ConditionalCheckFailedException'
      throw err
    }
    this.pods.set(key, unmarshall(cmd.input.Item as Record<string, AttributeValue>))
    return {}
  }
  updateItem(cmd: InstanceType<typeof UpdateItemCommand>) {
    const key = this.keyFor({ input: cmd.input })
    const item = this.pods.get(key)
    if (cmd.input.ConditionExpression && !this.evaluateCondition(cmd.input.ConditionExpression, item ?? null, cmd.input.ExpressionAttributeNames ?? {}, cmd.input.ExpressionAttributeValues ?? {})) {
      const err = new Error('conditional')
      ;(err as unknown as Record<string, string>).name = 'ConditionalCheckFailedException'
      throw err
    }
    const current = item ?? (this.pods.get(key) || {})
    this.applyUpdate(current, cmd.input.UpdateExpression ?? '', cmd.input.ExpressionAttributeNames ?? {}, cmd.input.ExpressionAttributeValues ?? {})
    if (!item) this.pods.set(key, current)
    return {}
  }
  query(cmd: InstanceType<typeof QueryCommand>) {
    const index = cmd.input.IndexName
    const exprValues = Object.fromEntries(
      Object.entries(cmd.input.ExpressionAttributeValues ?? {} as Record<string, AttributeValue>).map(([k, v]) => [
        k,
        unmarshall({ __v: v }).__v,
      ]),
    ) as Record<string, unknown>
    const all = Array.from(this.pods.values()).filter((p) => {
      if (index === 'podDocumentsByClientIdAndReceivedAt') return p.clientId === exprValues[':clientId']
      if (index === 'podDocumentsByLoadIdAndReceivedAt') return p.loadId === exprValues[':loadId']
      return true
    })
    const filtered = cmd.input.FilterExpression
      ? all.filter((p) => p.clientId === exprValues[':clientId'])
      : all
    filtered.sort((a, b) => ((b.receivedAt as string) ?? '').localeCompare((a.receivedAt as string) ?? ''))
    const limit = cmd.input.Limit ?? filtered.length
    const start = 0
    const page = filtered.slice(start, start + limit)
    return { Items: page.map((item) => marshall(item)) }
  }
  transactWriteItems(cmd: InstanceType<typeof TransactWriteItemsCommand>) {
    const updates: { key: string; item: Record<string, unknown> }[] = []
    const items = cmd.input.TransactItems ?? []
    for (const tx of items) {
      if ('Update' in tx && tx.Update) {
        const key = unmarshall(tx.Update.Key as Record<string, AttributeValue>).id as string
        const item = this.pods.get(key)
        if (tx.Update.ConditionExpression && !this.evaluateCondition(tx.Update.ConditionExpression, item ?? null, tx.Update.ExpressionAttributeNames ?? {}, tx.Update.ExpressionAttributeValues ?? {})) {
          const err = new Error('transaction canceled')
          ;(err as unknown as Record<string, string>).name = 'TransactionCanceledException'
          throw err
        }
        const current = { ...(item ?? {}) }
        this.applyUpdate(current, tx.Update.UpdateExpression ?? '', tx.Update.ExpressionAttributeNames ?? {}, tx.Update.ExpressionAttributeValues ?? {})
        updates.push({ key, item: current })
      } else if ('ConditionCheck' in tx && tx.ConditionCheck) {
        const key = unmarshall(tx.ConditionCheck.Key as Record<string, AttributeValue>).id as string
        const exists = this.loads.has(key)
        if (tx.ConditionCheck.ConditionExpression === 'attribute_exists(id)' && !exists) {
          const err = new Error('transaction canceled')
          ;(err as unknown as Record<string, string>).name = 'TransactionCanceledException'
          throw err
        }
      }
    }
    for (const { key, item } of updates) this.pods.set(key, item)
    return {}
  }
}

const memory = new MemoryStore()

interface MockStream {
  on(event: string, cb: (chunk?: Buffer | Error) => void): void
}

function streamedBuffer(buf: Buffer): MockStream {
  return {
    on(event: string, cb: (chunk?: Buffer | Error) => void) {
      if (event === 'data') cb(buf)
      if (event === 'end') cb()
    },
  }
}

function setSsmConfig(config: { apiKey: string; clientId: string; companyName?: string | null } | null) {
  mockSsm.mockImplementation(async (cmd) => {
    if (cmd instanceof GetParameterCommand) {
      if (!config) {
        const err = new Error('Parameter not found')
        ;(err as unknown as Record<string, string>).name = 'ParameterNotFound'
        throw err
      }
      return { Parameter: { Value: JSON.stringify(config), Type: 'SecureString' } }
    }
    if (cmd instanceof PutParameterCommand) return {}
    return {}
  })
}

function setCognitoEmail(email: string) {
  mockCognito.mockImplementation(async (cmd) => {
    if (cmd instanceof AdminGetUserCommand) {
      return { UserAttributes: [{ Name: 'email', Value: email }] }
    }
    return {}
  })
}

const OWNER_IDENTITY: import('./handler').AppSyncIdentity = {
  sub: 'owner-sub',
  username: 'owner@bcatcorp.com',
  claims: { email: 'ryne@bcatcorp.com', 'cognito:groups': ['ADMIN'] },
}

const PAGE_PODS_IDENTITY: import('./handler').AppSyncIdentity = {
  sub: 'page-sub',
  username: 'dispatch@bcatcorp.com',
  claims: { email: 'dispatch@bcatcorp.com', 'cognito:groups': ['page-pods', 'DISPATCHER'] },
}

const DISPATCHER_IDENTITY: import('./handler').AppSyncIdentity = {
  sub: 'dispatch-sub',
  username: 'other@bcatcorp.com',
  claims: { email: 'other@bcatcorp.com', 'cognito:groups': ['DISPATCHER'] },
}

function event(action: string, input: Record<string, unknown> | string | null = null, identity: import('./handler').AppSyncIdentity = OWNER_IDENTITY) {
  return { arguments: { action, input }, identity }
}

function findCommand<T>(cls: abstract new (...args: never[]) => T, predicate?: (cmd: T) => boolean): T | undefined {
  return dynamoSpy.mock.calls.map((c: unknown[]) => c[0]).find((cmd: unknown) => cmd instanceof cls && (!predicate || predicate(cmd))) as T | undefined
}

function findSsmCommand<T>(cls: abstract new (...args: never[]) => T): T | undefined {
  return ssmSpy.mock.calls.map((c: unknown[]) => c[0]).find((cmd: unknown) => cmd instanceof cls) as T | undefined
}

function findLambdaCommand<T>(cls: abstract new (...args: never[]) => T): T | undefined {
  return lambdaSpy.mock.calls.map((c: unknown[]) => c[0]).find((cmd: unknown) => cmd instanceof cls) as T | undefined
}

beforeAll(async () => {
  process.env.POD_DOCUMENT_TABLE_NAME = 'PodDocument-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.BUCKET_NAME = 'bcat-test'
  process.env.POD_CONNECTION_PARAM_NAME = '/bcat/pods/pool/connection'
  process.env.POD_FUNCTION_NAME = 'pod-actions-test'
  process.env.USER_POOL_ID = 'us-east-1_testpool'

  const mod = await import('./handler')
  handler = mod.handler
  parseInput = mod.parseInput
  authorize = mod.authorize
  configureAction = mod.configureAction
  statusAction = mod.statusAction
  listAction = mod.listAction
  syncAction = mod.syncAction
  assignAction = mod.assignAction
  assetsAction = mod.assetsAction
  stableDocumentId = mod.stableDocumentId
  processPodDocument = mod.processPodDocument
  resetConnectionConfigCache = mod.resetConnectionConfigCache

  dynamoSpy = vi.spyOn(DynamoDBClient.prototype, 'send').mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetItemCommand) return Promise.resolve(memory.getItem(cmd))
    if (cmd instanceof PutItemCommand) return Promise.resolve(memory.putItem(cmd))
    if (cmd instanceof QueryCommand) return Promise.resolve(memory.query(cmd))
    if (cmd instanceof UpdateItemCommand) return Promise.resolve(memory.updateItem(cmd))
    if (cmd instanceof TransactWriteItemsCommand) return Promise.resolve(memory.transactWriteItems(cmd))
    return Promise.resolve({})
  })
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof PutObjectCommand) {
      const keyParts = (cmd.input.Key as string).split('/')
      const id = keyParts[1]
      const pod = memory.pods.get(id)
      if (pod) pod.originalBytes = cmd.input.Body as Buffer
      return {}
    }
    if (cmd instanceof GetObjectCommand) {
      const key = cmd.input.Key as string
      const id = key.split('/')[1]
      const stored = memory.pods.get(id)?.originalBytes
      if (!stored) throw new Error('S3 object not found')
      return { Body: streamedBuffer(stored as Buffer), ContentType: 'image/jpeg' }
    }
    return {}
  })
  lambdaSpy = vi.spyOn(LambdaClient.prototype, 'send').mockImplementation(mockLambda)
  ssmSpy = vi.spyOn(SSMClient.prototype, 'send').mockImplementation(mockSsm)
  vi.spyOn(CognitoIdentityProviderClient.prototype, 'send').mockImplementation(mockCognito)
})

beforeEach(() => {
  memory.pods.clear()
  memory.loads.clear()
  resetConnectionConfigCache()
  vi.clearAllMocks()
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }))
  mockLambda.mockResolvedValue({})
  mockSsm.mockResolvedValue({})
  mockCognito.mockResolvedValue({})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── input parser ───────────────────────────────────────────────────────────
describe('parseInput', () => {
  it('parses a JSON string into an object', () => {
    expect(parseInput('{"id":"abc"}')).toEqual({ id: 'abc' })
  })

  it('returns an empty object for null or empty string', () => {
    expect(parseInput(null)).toEqual({})
    expect(parseInput('')).toEqual({})
    expect(parseInput({})).toEqual({})
  })

  it('rejects arrays and primitives', () => {
    expect(() => parseInput('[]')).toThrow(/must be a JSON object/)
    expect(() => parseInput(42 as unknown as string)).toThrow(/must be an object/)
  })
})

// ── authorization ──────────────────────────────────────────────────────────
describe('authorize', () => {
  it('resolves owner by email claim', async () => {
    const caller = await authorize('configure', OWNER_IDENTITY)
    expect(caller.isOwner).toBe(true)
  })

  it('resolves page-pods group membership', async () => {
    const caller = await authorize('list', PAGE_PODS_IDENTITY)
    expect(caller.isPagePods).toBe(true)
  })

  it('falls back to Cognito AdminGetUser when the token lacks email', async () => {
    setCognitoEmail('resolver@bcatcorp.com')
    const identity: import('./handler').AppSyncIdentity = {
      sub: 'uuid-sub',
      username: 'uuid-sub',
      claims: { 'cognito:groups': ['page-pods'] },
    }
    const caller = await authorize('list', identity)
    expect(caller.email).toBe('resolver@bcatcorp.com')
  })

  it('requires owner or ADMIN for configure', async () => {
    await expect(authorize('configure', PAGE_PODS_IDENTITY)).rejects.toThrow(/configure requires owner or ADMIN/)
  })

  it('requires global role for sync, assign, and retry', async () => {
    await expect(authorize('sync', DISPATCHER_IDENTITY)).rejects.toThrow(/page-pods/)
    await expect(authorize('assign', DISPATCHER_IDENTITY)).rejects.toThrow(/page-pods/)
    await expect(authorize('retry', DISPATCHER_IDENTITY)).rejects.toThrow(/page-pods/)
  })

  it('allows any authenticated dispatcher to list by loadId', async () => {
    const caller = await authorize('list', DISPATCHER_IDENTITY)
    expect(caller.isPagePods).toBe(false)
  })

  it('refuses a sync request from a plain dispatcher before touching JobsDone', async () => {
    setSsmConfig({ apiKey: 'valid-key-9chars', clientId: 'tenant-1' })
    await expect(handler(event('sync', {}, DISPATCHER_IDENTITY))).rejects.toThrow(/page-pods/)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

// ── tenant / config ──────────────────────────────────────────────────────────
describe('configureAction + statusAction', () => {
  it('status returns configured:false when SSM is unset', async () => {
    setSsmConfig(null)
    const result = await statusAction()
    expect(result.configured).toBe(false)
  })

  it('status returns tenant info without exposing the API key', async () => {
    setSsmConfig({ apiKey: 'secret-api-key', clientId: 'tenant-1', companyName: 'Best Care' })
    const result = await statusAction()
    expect(result).toEqual({ configured: true, clientId: 'tenant-1', companyName: 'Best Care' })
  })

  it('validates JobsDone before storing config', async () => {
    setSsmConfig(null)
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ clientId: 'tenant-1', companyName: 'Best Care' }), { status: 200 }))

    const result = await configureAction({ apiKey: 'valid-key-9chars', clientId: 'tenant-1' })
    expect(result).toEqual({ configured: true, clientId: 'tenant-1', companyName: 'Best Care' })
    const put = findSsmCommand(PutParameterCommand)
    expect(put).toBeDefined()
    const stored = JSON.parse((put as unknown as { input: { Value: string } }).input.Value)
    expect(stored).toMatchObject({ clientId: 'tenant-1', companyName: 'Best Care' })
    expect(stored.apiKey).toBe('valid-key-9chars')
    expect(result).not.toHaveProperty('apiKey')
  })

  it('rejects changing the configured clientId to a different tenant', async () => {
    setSsmConfig({ apiKey: 'old-key-9chars', clientId: 'tenant-1' })
    await expect(configureAction({ apiKey: 'new-key-9chars', clientId: 'tenant-2' })).rejects.toThrow(/Refusing to change clientId/)
  })

  it('rejects URLs supplied as clientId', async () => {
    await expect(configureAction({ apiKey: 'valid-key-9chars', clientId: 'https://evil' })).rejects.toThrow()
  })

  it('surfaces the JobsDone sentinel string as an explicit error', async () => {
    setSsmConfig(null)
    mockFetch.mockImplementation(async () => new Response(JSON.stringify('No response from lambda'), { status: 200 }))
    await expect(configureAction({ apiKey: 'valid-key-9chars', clientId: 'tenant-1' })).rejects.toThrow(/No response from lambda/)
  })
})

// ── sync / dedupe / pagination ─────────────────────────────────────────────
describe('syncAction', () => {
  function makeWsInstance(opts: { messages?: unknown[]; lastEvaluatedKey?: unknown; error?: Error }) {
    let openCb: (() => void) | null = null
    let messageCb: ((data: string | Buffer) => void) | null = null
    let errorCb: ((err: Error) => void) | null = null
    let requestId = ''
    let started = false
    wsHandlers = {
      on(event, cb) {
        if (event === 'open') openCb = cb as () => void
        if (event === 'message') messageCb = cb as (data: string | Buffer) => void
        if (event === 'error') errorCb = cb as (err: Error) => void
        if (event === 'open' && !started) {
          started = true
          Promise.resolve().then(() => openCb?.())
          Promise.resolve().then(() => {
            if (errorCb && opts.error) {
              errorCb(opts.error)
              return
            }
            if (!messageCb) return
            // unrelated event should be ignored
            messageCb(JSON.stringify({ action: 'newMessage', data: { id: 'ignored' } }))
            messageCb(JSON.stringify({ action: 'getMessages', data: opts.messages ?? [], lastEvaluatedKey: opts.lastEvaluatedKey ?? null, meta: { requestId } }))
          })
        }
      },
      send(data) {
        const parsed = JSON.parse(data) as { meta?: { requestId?: string } }
        requestId = parsed.meta?.requestId ?? ''
      },
      close() {},
    }
  }

  beforeEach(() => {
    setSsmConfig({ apiKey: 'valid-key', clientId: 'tenant-1' })
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ clientId: 'tenant-1' }), { status: 200 }))
  })

  it('imports attachments and enqueues async processing', async () => {
    makeWsInstance({
      messages: [{
        id: 'msg-1',
        clientId: 'tenant-1',
        mediaUrl: ['https://media.jobsdone.io/file1.jpg'],
        createdAt: '2026-09-28T12:00:00.000Z',
        isAllowed: true,
      }],
    })

    const result = await syncAction({})
    expect(result.imported).toBe(1)
    expect(result.nextToken).toBeNull()

    const put = findCommand(PutItemCommand)
    expect(put).toBeDefined()
    const item = unmarshall((put as unknown as { input: { Item: Record<string, AttributeValue> } }).input.Item)
    expect(item.clientId).toBe('tenant-1')
    expect(item.sourceUrl).toBe('https://media.jobsdone.io/file1.jpg')
    expect(item.receivedAt).toBe('2026-09-28T12:00:00.000Z')
    expect(item.isAllowed).toBe(true)
    expect(item.processingStatus).toBe('PENDING')
    // loadId is the partition key of a GSI: DynamoDB rejects a NULL there, so an
    // unassigned import must omit the attribute entirely.
    expect('loadId' in item).toBe(false)

    const invoke = findLambdaCommand(InvokeCommand)
    expect(invoke).toBeDefined()
    expect(JSON.parse((invoke as unknown as { input: { Payload: Buffer } }).input.Payload.toString())).toEqual({ action: 'processPodId', processPodId: item.id })
  })

  it('deduplicates existing pods without resetting assignment status', async () => {
    const existingId = stableDocumentId('tenant-1', 'msg-1', 'https://media.jobsdone.io/file1.jpg', 0)
    memory.pods.set(existingId, { id: existingId, clientId: 'tenant-1', loadId: 'load-1', version: 3 })

    makeWsInstance({
      messages: [{
        id: 'msg-1',
        clientId: 'tenant-1',
        mediaUrl: ['https://media.jobsdone.io/file1.jpg'],
        createdAt: '2026-09-28T12:00:00.000Z',
      }],
    })

    const result = await syncAction({})
    expect(result.imported).toBe(0)
    expect(memory.pods.get(existingId)?.loadId).toBe('load-1')
    expect(memory.pods.get(existingId)?.version).toBe(3)
  })

  it('skips malformed and foreign rows but still imports the good ones on the same page', async () => {
    makeWsInstance({
      messages: [
        { id: 'msg-bad', clientId: 'tenant-1', mediaUrl: 'not-an-array' },
        { id: 'msg-foreign', clientId: 'tenant-2', mediaUrl: ['https://media.jobsdone.io/foreign.jpg'], createdAt: '2026-09-28T12:00:00Z' },
        { id: 'msg-good', clientId: 'tenant-1', mediaUrl: ['https://media.jobsdone.io/good.jpg'], createdAt: '2026-09-28T12:00:00Z' },
      ],
    })
    const result = await syncAction({})
    expect(result).toMatchObject({ imported: 1, skipped: 2 })
    const stored = Array.from(memory.pods.values())
    expect(stored).toHaveLength(1)
    expect(stored[0].sourceMessageId).toBe('msg-good')
  })

  it('records an off-host attachment as FAILED without fetching it and keeps importing', async () => {
    makeWsInstance({
      messages: [{
        id: 'msg-1', clientId: 'tenant-1', createdAt: '2026-09-28T12:00:00Z',
        mediaUrl: ['https://evil.example.com/steal.jpg', 'https://media.jobsdone.io/ok.jpg'],
      }],
    })
    const result = await syncAction({})
    expect(result.imported).toBe(2)
    const rows = Array.from(memory.pods.values())
    const bad = rows.find((r) => r.sourceUrl === 'https://evil.example.com/steal.jpg')!
    const ok = rows.find((r) => r.sourceUrl === 'https://media.jobsdone.io/ok.jpg')!
    expect(bad.processingStatus).toBe('FAILED')
    expect(String(bad.processingError)).toMatch(/media\.jobsdone\.io/)
    expect(ok.processingStatus).toBe('PENDING')
    // Only the good attachment is queued for download/enhancement.
    const queued = lambdaSpy.mock.calls.map((c: unknown[]) => JSON.parse(((c[0] as { input: { Payload: Buffer } }).input.Payload).toString()).processPodId)
    expect(queued).toEqual([ok.id])
  })

  it('returns a pagination token when JobsDone provides a cursor', async () => {
    makeWsInstance({
      messages: [],
      lastEvaluatedKey: { clientId: 'tenant-1', createdAt: '2026-09-01T00:00:00Z' },
    })

    const result = await syncAction({})
    expect(result.imported).toBe(0)
    expect(typeof result.nextToken).toBe('string')
    expect(JSON.parse(result.nextToken!)).toEqual({ clientId: 'tenant-1', createdAt: '2026-09-01T00:00:00Z' })
  })
})

// ── list tenant / cursor isolation ───────────────────────────────────────────
describe('listAction', () => {
  beforeEach(() => {
    setSsmConfig({ apiKey: 'valid-key', clientId: 'tenant-1' })
    memory.pods.set('pod-1', { id: 'pod-1', clientId: 'tenant-1', receivedAt: '2026-09-28T12:00:00Z', processingStatus: 'PENDING', version: 1 })
    memory.pods.set('pod-2', { id: 'pod-2', clientId: 'tenant-1', loadId: 'load-1', receivedAt: '2026-09-27T12:00:00Z', processingStatus: 'READY', version: 1 })
  })

  it('queries global unassigned list for authorized roles', async () => {
    const result = await listAction({}, await authorize('list', PAGE_PODS_IDENTITY))
    expect(result.items).toHaveLength(2)
    const query = findCommand(QueryCommand)!
    expect(query.input.IndexName).toBe('podDocumentsByClientIdAndReceivedAt')
  })

  it('rejects global list for plain dispatchers', async () => {
    await expect(listAction({}, await authorize('list', DISPATCHER_IDENTITY))).rejects.toThrow(/page-pods/)
  })

  it('filters by loadId and authenticates any signed-in user', async () => {
    const result = await listAction({ loadId: 'load-1' }, await authorize('list', DISPATCHER_IDENTITY))
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe('pod-2')
    const query = findCommand(QueryCommand, (q) => q.input.IndexName === 'podDocumentsByLoadIdAndReceivedAt')!
    expect(query.input.IndexName).toBe('podDocumentsByLoadIdAndReceivedAt')
  })
})

// ── assign CAS and load validation ──────────────────────────────────────────
describe('assignAction', () => {
  beforeEach(() => {
    setSsmConfig({ apiKey: 'valid-key', clientId: 'tenant-1' })
    memory.pods.set('pod-1', { id: 'pod-1', clientId: 'tenant-1', version: 1, processingStatus: 'READY' })
  })

  it('assigns to a valid load with version CAS', async () => {
    memory.loads.set('load-1', { id: 'load-1' })
    const result = await assignAction({ id: 'pod-1', loadId: 'load-1', expectedVersion: 1 }, await authorize('assign', PAGE_PODS_IDENTITY))
    expect(result.item.loadId).toBe('load-1')
    expect(result.item.version).toBe(2)
    const tx = findCommand(TransactWriteItemsCommand)!
    expect(tx.input.TransactItems).toHaveLength(2)
  })

  it('rejects assignment when the load does not exist', async () => {
    await expect(
      assignAction({ id: 'pod-1', loadId: 'missing-load', expectedVersion: 1 }, await authorize('assign', PAGE_PODS_IDENTITY)),
    ).rejects.toThrow(/Load/)
  })

  it('preserves original and enhanced keys through assignment updates', async () => {
    memory.pods.set('pod-1', { id: 'pod-1', clientId: 'tenant-1', version: 1, originalKey: 'pods/pod-1/original', enhancedKey: 'pods/pod-1/enhanced.jpg' })
    memory.loads.set('load-1', { id: 'load-1' })

    const result = await assignAction({ id: 'pod-1', loadId: 'load-1', expectedVersion: 1 }, await authorize('assign', PAGE_PODS_IDENTITY))
    expect(result.item.originalKey).toBe('pods/pod-1/original')
    expect(result.item.enhancedKey).toBe('pods/pod-1/enhanced.jpg')
  })

  it('unassigns by removing the load attributes rather than writing NULL', async () => {
    memory.pods.set('pod-1', { id: 'pod-1', clientId: 'tenant-1', version: 2, loadId: 'load-1', assignedBy: 'a@b.com', assignedAt: '2026-09-28T00:00:00Z' })
    const result = await assignAction({ id: 'pod-1', loadId: null, expectedVersion: 2 }, await authorize('assign', PAGE_PODS_IDENTITY))
    expect(result.item.version).toBe(3)
    expect(result.item.loadId).toBeUndefined()
    const tx = findCommand(TransactWriteItemsCommand)!
    const update = tx.input.TransactItems![0].Update!
    expect(update.UpdateExpression).toMatch(/REMOVE[^]*#loadId/)
    expect(Object.values(update.ExpressionAttributeValues ?? {})).not.toContainEqual({ NULL: true })
  })
})

// ── assets signed URLs ───────────────────────────────────────────────────────
describe('assetsAction', () => {
  it('returns short-lived signed URLs only for existing keys', async () => {
    setSsmConfig({ apiKey: 'valid-key', clientId: 'tenant-1' })
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed.example/key')
    memory.pods.set('pod-1', {
      id: 'pod-1',
      clientId: 'tenant-1',
      loadId: 'load-1',
      originalKey: 'pods/pod-1/original',
      enhancedKey: 'pods/pod-1/enhanced.jpg',
      processingStatus: 'READY',
      version: 1,
    })

    const result = await assetsAction({ id: 'pod-1' }, await authorize('assets', DISPATCHER_IDENTITY))
    expect(result.originalUrl).toMatch(/^https:\/\//)
    expect(result.enhancedUrl).toMatch(/^https:\/\//)
    expect(result.item.processingStatus).toBe('READY')
  })
})

// ── async processing ─────────────────────────────────────────────────────────
describe('processPodDocument', () => {
  it('downloads, stores the original, and enhances image files', async () => {
    const id = 'pod-1'
    memory.pods.set(id, {
      id,
      clientId: 'tenant-1',
      processingStatus: 'PENDING',
      sourceUrl: 'https://media.jobsdone.io/file1.jpg',
      version: 1,
    })
    mockFetch.mockResolvedValueOnce(new Response(Buffer.from('image-bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } }))

    await processPodDocument(id)
    const pod = memory.pods.get(id)!
    expect(pod.processingStatus).toBe('READY')
    expect(pod.processingError).toBeUndefined()
    expect(pod.originalKey).toBe(`pods/${id}/original`)
    expect(pod.enhancedKey).toBe(`pods/${id}/enhanced.jpg`)
  })

  it('reuses the archived original on retry instead of re-fetching', async () => {
    const id = 'pod-retry'
    memory.pods.set(id, {
      id,
      clientId: 'tenant-1',
      processingStatus: 'FAILED',
      processingError: 'previous failure',
      originalKey: `pods/${id}/original`,
      contentType: 'image/jpeg',
      sourceUrl: 'https://media.jobsdone.io/expired.jpg',
      version: 1,
    })
    memory.pods.get(id)!.originalBytes = Buffer.from('archived-image-bytes')

    await processPodDocument(id)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
