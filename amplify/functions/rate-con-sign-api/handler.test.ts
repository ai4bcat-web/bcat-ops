/**
 * rate-con-sign-api handler tests.
 *
 * The DynamoDB mock is a small in-memory engine rather than scripted responses: the
 * whole point of this Lambda is that a token opens exactly one assignment exactly
 * once, and only a store that remembers what the last call wrote can tell a correct
 * once-only guard from a broken one.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type * as HandlerModule from './handler'

type Row = Record<string, unknown>

const ddbSend = vi.hoisted(() => vi.fn())
const s3Send = vi.hoisted(() => vi.fn())
const getSignedUrl = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(function () {}),
}))

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: ddbSend }) },
  ScanCommand: vi.fn(function (params: Row) { return { __type: 'Scan', ...params } }),
  GetCommand: vi.fn(function (params: Row) { return { __type: 'Get', ...params } }),
  PutCommand: vi.fn(function (params: Row) { return { __type: 'Put', ...params } }),
  UpdateCommand: vi.fn(function (params: Row) { return { __type: 'Update', ...params } }),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () { return { send: s3Send } }),
  GetObjectCommand: vi.fn(function (params: Row) { return params }),
  PutObjectCommand: vi.fn(function (params: Row) { return params }),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }))

const TABLES = {
  loadCarrier: 'LoadCarrier-test',
  load: 'Load-test',
  carrierDoc: 'CarrierDocument-test',
  division: 'Division-test',
  settings: 'TmsSettings-test',
  audit: 'AuditLog-test',
}

/** TableName -> primary key value -> row. Division is keyed by `key`, the rest by `id`. */
const store = new Map<string, Map<string, Row>>()

function table(name: string): Map<string, Row> {
  let t = store.get(name)
  if (!t) {
    t = new Map<string, Row>()
    store.set(name, t)
  }
  return t
}

function keyValue(key: Row): string {
  return String(key.id ?? key.key)
}

/** Apply the one `SET …` shape this handler emits, including the token counter. */
function applyUpdate(spec: Row): Row {
  const t = table(String(spec.TableName))
  const id = keyValue(spec.Key as Row)
  const names = (spec.ExpressionAttributeNames ?? {}) as Record<string, string>
  const values = (spec.ExpressionAttributeValues ?? {}) as Row
  const next: Row = { ...(t.get(id) ?? { id }) }
  const sets = /SET\s+(.*)$/s.exec(String(spec.UpdateExpression))?.[1] ?? ''
  // Assignments cannot be split on commas: `if_not_exists(x, :zero)` contains one.
  const assignments = sets.matchAll(/([#\w]+)\s*=\s*(if_not_exists\([^)]*\)(?:\s*\+\s*:\w+)?|:\w+)/g)
  for (const [, rawField, rhs] of assignments) {
    const field = rawField.startsWith('#') ? names[rawField] : rawField
    const counter = /^if_not_exists\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)\s*\+\s*(:\w+)$/.exec(rhs)
    if (counter) {
      const target = counter[1].startsWith('#') ? names[counter[1]] : counter[1]
      next[field] = Number(next[target] ?? values[counter[2]]) + Number(values[counter[3]])
      continue
    }
    next[field] = values[rhs]
  }
  t.set(id, next)
  return next
}

/**
 * Evaluate a ConditionExpression the way DynamoDB would: against the row as it is
 * now, not as the handler last read it. Without this the once-only guard is
 * untestable, because every racing write would simply land.
 */
function conditionHolds(spec: Row, current: Row | undefined): boolean {
  const expression = spec.ConditionExpression
  if (!expression) return true
  const names = (spec.ExpressionAttributeNames ?? {}) as Record<string, string>
  const values = (spec.ExpressionAttributeValues ?? {}) as Row
  return String(expression).split(/\s+AND\s+/).every((raw) => {
    const clause = raw.trim()
    const member = /^([#\w]+)\s+IN\s*\(([^)]*)\)$/.exec(clause)
    if (member) {
      const attribute = member[1].startsWith('#') ? names[member[1]] : member[1]
      return member[2].split(',').map((v) => values[v.trim()]).includes(current?.[attribute])
    }
    const equals = /^([#\w]+)\s*=\s*(:\w+)$/.exec(clause)
    if (!equals) throw new Error(`Unhandled condition: ${clause}`)
    const attribute = equals[1].startsWith('#') ? names[equals[1]] : equals[1]
    return current?.[attribute] === values[equals[2]]
  })
}

function runCommand(cmd: Row): unknown {
  switch (cmd.__type) {
    case 'Scan': {
      const names = (cmd.ExpressionAttributeNames ?? {}) as Record<string, string>
      const values = (cmd.ExpressionAttributeValues ?? {}) as Row
      const filter = String(cmd.FilterExpression)
      const [left, , right] = filter.split(' ')
      const field = left.startsWith('#') ? names[left] : left
      const wanted = values[right]
      return { Items: [...table(String(cmd.TableName)).values()].filter((row) => row[field] === wanted) }
    }
    case 'Get':
      return { Item: table(String(cmd.TableName)).get(keyValue(cmd.Key as Row)) }
    case 'Put': {
      const item = cmd.Item as Row
      table(String(cmd.TableName)).set(keyValue(item), item)
      return {}
    }
    case 'Update': {
      const current = table(String(cmd.TableName)).get(keyValue(cmd.Key as Row))
      if (!conditionHolds(cmd, current)) {
        const failure = new Error('The conditional request failed')
        failure.name = 'ConditionalCheckFailedException'
        throw failure
      }
      return { Attributes: applyUpdate(cmd) }
    }
    default:
      throw new Error(`Unhandled command: ${String(cmd.__type)}`)
  }
}

let handler: typeof HandlerModule.handler

// The handler reads its table names at module scope, so the import has to happen
// after the environment is set — a static import would evaluate too early.
beforeAll(async () => {
  process.env.LOAD_CARRIER_TABLE_NAME = TABLES.loadCarrier
  process.env.LOAD_TABLE_NAME = TABLES.load
  process.env.CARRIER_DOCUMENT_TABLE_NAME = TABLES.carrierDoc
  process.env.DIVISION_TABLE_NAME = TABLES.division
  process.env.SETTINGS_TABLE_NAME = TABLES.settings
  process.env.AUDIT_LOG_TABLE_NAME = TABLES.audit
  process.env.BUCKET_NAME = 'bcat-test-bucket'
  handler = (await import('./handler')).handler
})

const TOKEN = 'tok-abc123'
const PDF_BASE64 = Buffer.from('%PDF-1.4 signed').toString('base64')

function seedLoadCarrier(extra: Row = {}): Row {
  const row: Row = {
    id: 'lcr-1',
    __typename: 'LoadCarrier',
    loadId: 'lod-1',
    shipmentId: 'shp-1',
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierId: 'car-1',
    carrierName: 'SWIFT TRANSPORTATION',
    carrierRateCents: 180_000,
    costCents: 180_000,
    rateConStatus: 'SENT',
    rateConToken: TOKEN,
    rateConVersion: 1,
    rateConDocumentId: 'cdoc-1',
    rateConExpiresAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...extra,
  }
  table(TABLES.loadCarrier).set(String(row.id), row)
  return row
}

function seedRest(): void {
  table(TABLES.load).set('lod-1', { id: 'lod-1', loadNumber: 'S000001-1', divisionKey: 'BCAT_LOGISTICS' })
  table(TABLES.division).set('BCAT_LOGISTICS', { key: 'BCAT_LOGISTICS', name: 'BCAT Logistics', legalName: 'BCAT Logistics LLC' })
  table(TABLES.carrierDoc).set('cdoc-1', { id: 'cdoc-1', carrierId: 'car-1', type: 'RATE_CON', s3Key: 'rate-confirms/carrier/lod-1/lcr-1-v1.pdf' })
  table(TABLES.settings).set('default', { id: 'default' })
}

function post(body: unknown, method = 'POST') {
  return handler({ body: JSON.stringify(body), requestContext: { http: { method, sourceIp: '203.0.113.9' } } })
}

async function json(res: Promise<{ statusCode: number; body: string }>) {
  const settled = await res
  return { status: settled.statusCode, body: JSON.parse(settled.body) as Row }
}

/**
 * Let a rival answer land between the handler's read and its write — the window the
 * ConditionExpression exists to close. The row the handler is holding is left alone;
 * the stored one moves on without it, exactly as a concurrent Lambda would leave it.
 */
function raceAfterScan(patch: Row): void {
  ddbSend.mockImplementation(async (cmd: Row) => {
    const result = runCommand(cmd)
    if (cmd.__type === 'Scan' && cmd.TableName === TABLES.loadCarrier) {
      const current = table(TABLES.loadCarrier).get('lcr-1')
      if (current) table(TABLES.loadCarrier).set('lcr-1', { ...current, ...patch })
    }
    return result
  })
}

beforeEach(() => {
  store.clear()
  ddbSend.mockReset()
  s3Send.mockReset()
  getSignedUrl.mockReset()
  ddbSend.mockImplementation(async (cmd: Row) => runCommand(cmd))
  s3Send.mockResolvedValue({})
  getSignedUrl.mockResolvedValue('https://signed.example/rate-con.pdf')
  seedRest()
})

describe('rate-con-sign-api', () => {
  it('answers preflight without ever setting a CORS header of its own', async () => {
    const res = await post({}, 'OPTIONS')
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.headers)).toEqual(['Content-Type'])
  })

  describe('get', () => {
    it('returns the rate con and opens it on first read', async () => {
      seedLoadCarrier()
      const { status, body } = await json(post({ token: TOKEN, action: 'get' }))

      expect(status).toBe(200)
      expect(body).toMatchObject({
        loadNumber: 'S000001-1',
        carrierName: 'SWIFT TRANSPORTATION',
        brokerName: 'BCAT Logistics LLC',
        status: 'OPENED',
        totalCents: 180_000,
        requiredFields: ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER'],
        pdfUrl: 'https://signed.example/rate-con.pdf',
      })
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row.rateConStatus).toBe('OPENED')
      expect(row.rateConRequestCount).toBe(1)
    })

    it('takes the required fields from settings when they are configured', async () => {
      seedLoadCarrier()
      table(TABLES.settings).set('default', { id: 'default', rateConRequiredFields: ['DRIVER_NAME', 'TRAILER_NUMBER'] })
      const { body } = await json(post({ token: TOKEN, action: 'get' }))
      expect(body.requiredFields).toEqual(['DRIVER_NAME', 'TRAILER_NUMBER'])
    })

    it('is a 404 for a token nobody holds', async () => {
      seedLoadCarrier()
      const { status } = await json(post({ token: 'nope', action: 'get' }))
      expect(status).toBe(404)
    })

    it('expires the link where it finds it', async () => {
      seedLoadCarrier({ rateConExpiresAt: '2026-01-01T00:00:00.000Z' })
      const { status, body } = await json(post({ token: TOKEN, action: 'get' }))

      expect(status).toBe(410)
      expect(String(body.error)).toMatch(/expired/)
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row.rateConStatus).toBe('EXPIRED')
      expect(row.rateConToken).toBeNull()
    })

    it('stops answering a token that has been hammered', async () => {
      seedLoadCarrier({ rateConRequestCount: 201 })
      const { status } = await json(post({ token: TOKEN, action: 'get' }))
      expect(status).toBe(429)
    })

    it('refuses a token two assignments answer to rather than picking one', async () => {
      seedLoadCarrier()
      seedLoadCarrier({ id: 'lcr-2', loadId: 'lod-2' })
      const { status, body } = await json(post({ token: TOKEN, action: 'get' }))
      expect(status).toBe(409)
      expect(String(body.error)).toMatch(/ambiguous/)
    })
  })

  describe('submit', () => {
    const payload = {
      signerName: 'Yuri Petrov',
      fields: { DRIVER_NAME: 'Yuri Petrov', DRIVER_PHONE: '312-555-0101', TRUCK_NUMBER: '4471' },
      pdfBase64: PDF_BASE64,
    }

    it('signs once, stores the PDF and fills only what was still blank', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED', driverName: 'Dispatch Knew This' })
      const { status, body } = await json(post({ token: TOKEN, action: 'submit', payload }))

      expect(status).toBe(200)
      expect(body).toEqual({ ok: true })
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row).toMatchObject({
        rateConStatus: 'SIGNED',
        rateConSignerName: 'Yuri Petrov',
        rateConSignerIp: '203.0.113.9',
        rateConKey: 'rate-confirms/carrier/lod-1/lcr-1-v1-signed.pdf',
        rateConToken: null,
        // The office's value is never overwritten by the signature page.
        driverName: 'Dispatch Knew This',
        driverPhone: '312-555-0101',
        truckNumber: '4471',
      })
      expect(s3Send).toHaveBeenCalledTimes(1)
      const signed = [...table(TABLES.carrierDoc).values()].find((d) => d.source === 'SIGNED')!
      expect(signed).toMatchObject({ carrierId: 'car-1', type: 'RATE_CON', loadCarrierId: 'lcr-1', uploadedBy: 'CARRIER_PORTAL' })
      const audit = [...table(TABLES.audit).values()][0]
      expect(audit).toMatchObject({ entityType: 'LOAD_CARRIER', entityId: 'lcr-1', action: 'rate_con_signed', user: 'CARRIER_PORTAL' })
    })

    it('refuses a second signature on the same rate con', async () => {
      seedLoadCarrier({ rateConStatus: 'SIGNED' })
      const { status, body } = await json(post({ token: TOKEN, action: 'submit', payload }))
      expect(status).toBe(409)
      expect(String(body.error)).toMatch(/already been answered/)
    })

    it('writes neither a signed PDF nor a second document when the row is already signed', async () => {
      seedLoadCarrier({ rateConStatus: 'SIGNED', rateConSignerName: 'Yuri Petrov' })
      const { status } = await json(post({ token: TOKEN, action: 'submit', payload: { ...payload, signerName: 'Impostor' } }))

      expect(status).toBe(409)
      expect(s3Send).not.toHaveBeenCalled()
      expect([...table(TABLES.carrierDoc).values()].filter((d) => d.source === 'SIGNED')).toHaveLength(0)
      expect(table(TABLES.loadCarrier).get('lcr-1')!.rateConSignerName).toBe('Yuri Petrov')
    })

    it('refuses a signature another answer beat to the write, leaving nothing behind', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED' })
      // The rival signs while this request is still deciding what to upload.
      raceAfterScan({ rateConStatus: 'SIGNED', rateConToken: null, rateConSignerName: 'First Signer' })

      const { status, body } = await json(post({ token: TOKEN, action: 'submit', payload: { ...payload, signerName: 'Second Signer' } }))

      expect(status).toBe(409)
      expect(String(body.error)).toMatch(/already been answered/)
      expect(table(TABLES.loadCarrier).get('lcr-1')!.rateConSignerName).toBe('First Signer')
      expect(s3Send).not.toHaveBeenCalled()
      expect([...table(TABLES.carrierDoc).values()].filter((d) => d.source === 'SIGNED')).toHaveLength(0)
      expect([...table(TABLES.audit).values()]).toHaveLength(0)
    })

    it('counts the request against the token', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED' })
      await post({ token: TOKEN, action: 'submit', payload })
      expect(table(TABLES.loadCarrier).get('lcr-1')!.rateConRequestCount).toBe(1)
    })

    it('stops answering a token that has been hammered', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED', rateConRequestCount: 201 })
      const { status } = await json(post({ token: TOKEN, action: 'submit', payload }))
      expect(status).toBe(429)
      expect(s3Send).not.toHaveBeenCalled()
    })

    it('leaves the link dead once it has been signed', async () => {
      seedLoadCarrier()
      await post({ token: TOKEN, action: 'submit', payload })
      const { status } = await json(post({ token: TOKEN, action: 'submit', payload }))
      expect(status).toBe(404)
    })

    it('needs a typed name and every required field', async () => {
      seedLoadCarrier()
      const noName = await json(post({ token: TOKEN, action: 'submit', payload: { ...payload, signerName: '  ' } }))
      expect(noName.status).toBe(400)

      const missing = await json(post({
        token: TOKEN,
        action: 'submit',
        payload: { ...payload, fields: { DRIVER_NAME: 'Yuri Petrov' } },
      }))
      expect(missing.status).toBe(400)
      expect(String(missing.body.error)).toMatch(/DRIVER_PHONE, TRUCK_NUMBER/)
      expect(table(TABLES.loadCarrier).get('lcr-1')!.rateConStatus).toBe('SENT')
    })

    it('refuses a body over the megabyte cap before it parses it', async () => {
      seedLoadCarrier()
      const res = await handler({
        body: JSON.stringify({ token: TOKEN, action: 'submit', payload: { pdfBase64: 'A'.repeat(1_100_000) } }),
        requestContext: { http: { method: 'POST' } },
      })
      expect(res.statusCode).toBe(413)
    })
  })

  describe('decline', () => {
    it('declines with a reason and burns the token', async () => {
      seedLoadCarrier()
      const { status } = await json(post({ token: TOKEN, action: 'decline', payload: { reason: 'Rate too low' } }))

      expect(status).toBe(200)
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row.rateConStatus).toBe('DECLINED')
      expect(row.rateConToken).toBeNull()
      const audit = [...table(TABLES.audit).values()][0]
      expect(audit).toMatchObject({ action: 'rate_con_declined', user: 'CARRIER_PORTAL' })
      expect(String(audit.changes)).toMatch(/Rate too low/)
    })

    it('needs a reason', async () => {
      seedLoadCarrier()
      const { status } = await json(post({ token: TOKEN, action: 'decline', payload: {} }))
      expect(status).toBe(400)
    })

    it('refuses to decline a voided rate con', async () => {
      seedLoadCarrier({ rateConStatus: 'VOIDED' })
      const { status } = await json(post({ token: TOKEN, action: 'decline', payload: { reason: 'too late' } }))
      expect(status).toBe(409)
    })

    it('cannot bury a signature that landed first', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED' })
      raceAfterScan({ rateConStatus: 'SIGNED', rateConToken: null, rateConSignerName: 'Yuri Petrov' })

      const { status } = await json(post({ token: TOKEN, action: 'decline', payload: { reason: 'Rate too low' } }))

      expect(status).toBe(409)
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row.rateConStatus).toBe('SIGNED')
      expect(row.rateConSignerName).toBe('Yuri Petrov')
      expect([...table(TABLES.audit).values()]).toHaveLength(0)
    })

    it('refuses to decline a rate con that was already signed', async () => {
      seedLoadCarrier({ rateConStatus: 'SIGNED', rateConSignerName: 'Yuri Petrov' })
      const { status } = await json(post({ token: TOKEN, action: 'decline', payload: { reason: 'changed my mind' } }))

      expect(status).toBe(409)
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row.rateConStatus).toBe('SIGNED')
      expect(row.rateConSignerName).toBe('Yuri Petrov')
    })

    it('counts the request against the token', async () => {
      seedLoadCarrier()
      await post({ token: TOKEN, action: 'decline', payload: { reason: 'Rate too low' } })
      expect(table(TABLES.loadCarrier).get('lcr-1')!.rateConRequestCount).toBe(1)
    })
  })

  it('refuses an action it does not serve', async () => {
    seedLoadCarrier()
    const { status } = await json(post({ token: TOKEN, action: 'deleteEverything' }))
    expect(status).toBe(400)
  })
})
