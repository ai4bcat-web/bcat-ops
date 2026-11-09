/**
 * rate-con-sign-api handler tests.
 *
 * The DynamoDB mock is a small in-memory engine rather than scripted responses: the
 * whole point of this Lambda is that a token opens exactly one assignment exactly
 * once, and only a store that remembers what the last call wrote can tell a correct
 * once-only guard from a broken one.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
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
  QueryCommand: vi.fn(function (params: Row) { return { __type: 'Query', ...params } }),
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
  shipment: 'Shipment-test',
  carrierDoc: 'CarrierDocument-test',
  division: 'Division-test',
  settings: 'TmsSettings-test',
  audit: 'AuditLog-test',
  shipmentDoc: 'ShipmentDocument-test',
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
    case 'Query': {
      const names = (cmd.ExpressionAttributeNames ?? {}) as Record<string, string>
      const values = (cmd.ExpressionAttributeValues ?? {}) as Row
      const keyField = names['#k']
      const sortField = names['#s']
      return {
        Items: [...table(String(cmd.TableName)).values()].filter((row) =>
          row[keyField] === values[':k'] && (!sortField || row[sortField] === values[':s'])),
      }
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
  process.env.SHIPMENT_TABLE_NAME = TABLES.shipment
  process.env.CARRIER_DOCUMENT_TABLE_NAME = TABLES.carrierDoc
  process.env.DIVISION_TABLE_NAME = TABLES.division
  process.env.SETTINGS_TABLE_NAME = TABLES.settings
  process.env.AUDIT_LOG_TABLE_NAME = TABLES.audit
  process.env.SHIPMENT_DOCUMENT_TABLE_NAME = TABLES.shipmentDoc
  process.env.BUCKET_NAME = 'bcat-test-bucket'
  handler = (await import('./handler')).handler
})

const TOKEN = 'tok-abc123'
const IP = '203.0.113.9'
const UA = 'Mozilla/5.0 (TestBrowser)'

/** A real two-page PDF: the unsigned rate con the Lambda reads back from S3. */
let unsignedPdf: Uint8Array
beforeAll(async () => {
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  doc.addPage([612, 792])
  unsignedPdf = await doc.save()
})

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
    rateConSentAt: '2026-03-01T12:00:00.000Z',
    rateConSentTo: 'dispatch@swift.example',
    rateConExpiresAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...extra,
  }
  table(TABLES.loadCarrier).set(String(row.id), row)
  return row
}

function seedRest(): void {
  table(TABLES.load).set('lod-1', { id: 'lod-1', loadNumber: 'S000001-1', divisionKey: 'BCAT_LOGISTICS' })
  table(TABLES.shipment).set('shp-1', { id: 'shp-1', number: 'S000001' })
  table(TABLES.division).set('BCAT_LOGISTICS', { key: 'BCAT_LOGISTICS', name: 'BCAT Logistics', legalName: 'BCAT Logistics LLC' })
  table(TABLES.carrierDoc).set('cdoc-1', { id: 'cdoc-1', carrierId: 'car-1', type: 'RATE_CON', s3Key: 'rate-confirms/carrier/lod-1/lcr-1-v1.pdf' })
  table(TABLES.settings).set('default', { id: 'default' })
}

function post(body: unknown, method = 'POST') {
  return handler({
    body: JSON.stringify(body),
    headers: { 'cloudfront-viewer-city': 'Chicago', 'cloudfront-viewer-country': 'US' },
    requestContext: { http: { method, sourceIp: IP, userAgent: UA } },
  })
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

const auditRows = () => [...table(TABLES.audit).values()]
const auditActions = () => auditRows().map((r) => r.action)
const docs = (type?: string) => [...table(TABLES.shipmentDoc).values()].filter((d) => !type || d.type === type)
const puts = () => s3Send.mock.calls.map((c) => c[0] as Row).filter((c) => c.Body)

/** Every flate stream of the PDF, inflated and joined: where pdf-lib keeps the text it drew (as hex strings). */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes)
  const out: string[] = []
  let from = 0
  for (;;) {
    const start = raw.indexOf('stream\n', from, 'latin1')
    if (start < 0) break
    const end = raw.indexOf('endstream', start, 'latin1')
    try { out.push(inflateSync(raw.subarray(start + 7, end)).toString('latin1')) } catch { /* not a flate stream */ }
    from = end + 9
  }
  return out.join('\n')
}

async function putPdf(): Promise<PDFDocument> {
  return PDFDocument.load(puts()[0].Body as Uint8Array)
}

beforeEach(() => {
  store.clear()
  ddbSend.mockReset()
  s3Send.mockReset()
  getSignedUrl.mockReset()
  ddbSend.mockImplementation(async (cmd: Row) => runCommand(cmd))
  s3Send.mockImplementation(async (cmd: Row) =>
    cmd.Body ? {} : { Body: { transformToByteArray: async () => unsignedPdf } })
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
    it('returns the rate con and opens it on first read, logging who opened it', async () => {
      seedLoadCarrier()
      const { status, body } = await json(post({ token: TOKEN, action: 'get' }))

      expect(status).toBe(200)
      expect(body).toMatchObject({
        loadNumber: 'S000001-1',
        carrierName: 'SWIFT TRANSPORTATION',
        brokerName: 'BCAT Logistics LLC',
        status: 'OPENED',
        version: 1,
        totalCents: 180_000,
        // Step AM: the four driver fields are always asked for, and only those still empty.
        requiredFields: ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER', 'TRAILER_NUMBER'],
        driverInfo: { driverName: null, driverPhone: null, truckNumber: null, trailerNumber: null },
        pdfUrl: 'https://signed.example/rate-con.pdf',
      })
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row.rateConStatus).toBe('OPENED')
      expect(row.rateConRequestCount).toBe(1)
      const opened = auditRows().find((r) => r.action === 'rate_con_opened')!
      expect(opened).toMatchObject({ entityType: 'LOAD_CARRIER', entityId: 'lcr-1', user: 'CARRIER_PORTAL' })
      expect(JSON.parse(String(opened.changes))).toMatchObject({ version: 1, ip: IP, userAgent: UA, location: 'Chicago, US' })
    })

    it('logs the first open only', async () => {
      seedLoadCarrier()
      await post({ token: TOKEN, action: 'get' })
      await post({ token: TOKEN, action: 'get' })
      expect(auditActions().filter((a) => a === 'rate_con_opened')).toHaveLength(1)
    })

    it('asks for the settings\' extra fields on top of the four driver fields', async () => {
      seedLoadCarrier()
      table(TABLES.settings).set('default', { id: 'default', rateConRequiredFields: ['DRIVER_NAME', 'PLATES'] })
      const { body } = await json(post({ token: TOKEN, action: 'get' }))
      expect(body.requiredFields).toEqual(['DRIVER_NAME', 'PLATES', 'DRIVER_PHONE', 'TRUCK_NUMBER', 'TRAILER_NUMBER'])
    })

    it('does not ask the carrier again for what the office already entered, and prefills it', async () => {
      seedLoadCarrier({ driverName: 'Yuri Petrov', truckNumber: '4471' })
      const { body } = await json(post({ token: TOKEN, action: 'get' }))
      expect(body.requiredFields).toEqual(['DRIVER_PHONE', 'TRAILER_NUMBER'])
      expect(body.driverInfo).toEqual({ driverName: 'Yuri Petrov', driverPhone: null, truckNumber: '4471', trailerNumber: null })
    })

    it('is a 404 for a token nobody ever held, and writes nothing about the guess', async () => {
      seedLoadCarrier()
      const { status } = await json(post({ token: 'nope', action: 'get' }))
      expect(status).toBe(404)
      expect(auditRows()).toHaveLength(0)
    })

    it('says "replaced" on a link a newer send killed, and logs the attempt against the assignment', async () => {
      // v2 was sent: the row now holds the v2 token, and the v1 token survives only as its issued-link audit row.
      seedLoadCarrier({ rateConVersion: 2, rateConToken: 'tok-v2' })
      const hash = createHash('sha256').update(TOKEN).digest('hex')
      table(TABLES.audit).set('a1', { id: 'a1', entityType: 'RATE_CON_TOKEN', entityId: hash, action: 'rate_con_link_issued', changes: JSON.stringify({ loadCarrierId: 'lcr-1', version: 1 }) })

      const { status, body } = await json(post({ token: TOKEN, action: 'get' }))
      expect(status).toBe(410)
      expect(body).toMatchObject({ code: 'REPLACED', error: 'This rate confirmation was replaced; use the newest link' })
      const refused = auditRows().find((r) => r.action === 'rate_con_link_rejected')!
      expect(refused).toMatchObject({ entityType: 'LOAD_CARRIER', entityId: 'lcr-1' })
      expect(JSON.parse(String(refused.changes))).toMatchObject({ reason: 'SUPERSEDED', linkVersion: 1, currentVersion: 2, ip: IP })
    })

    it('cannot sign on a replaced link: nothing is written', async () => {
      seedLoadCarrier({ rateConVersion: 2, rateConToken: 'tok-v2' })
      const hash = createHash('sha256').update(TOKEN).digest('hex')
      table(TABLES.audit).set('a1', { id: 'a1', entityType: 'RATE_CON_TOKEN', entityId: hash, action: 'rate_con_link_issued', changes: JSON.stringify({ loadCarrierId: 'lcr-1', version: 1 }) })

      const { status, body } = await json(post({ token: TOKEN, action: 'submit', payload: validPayload() }))
      expect(status).toBe(410)
      expect(body.code).toBe('REPLACED')
      expect(puts()).toHaveLength(0)
      expect(docs()).toHaveLength(0)
      expect(table(TABLES.loadCarrier).get('lcr-1')!.rateConStatus).toBe('SENT')
    })

    it('expires the link where it finds it, and logs the refusal', async () => {
      seedLoadCarrier({ rateConExpiresAt: '2026-01-01T00:00:00.000Z' })
      const { status, body } = await json(post({ token: TOKEN, action: 'get' }))

      expect(status).toBe(410)
      expect(String(body.error)).toMatch(/expired/)
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row.rateConStatus).toBe('EXPIRED')
      expect(row.rateConToken).toBeNull()
      expect(JSON.parse(String(auditRows().find((r) => r.action === 'rate_con_link_rejected')!.changes))).toMatchObject({ reason: 'EXPIRED' })
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

    it('shows a signed link as signed: no form, no document link', async () => {
      seedLoadCarrier({ rateConStatus: 'SIGNED', rateConSignerName: 'Yuri Petrov', rateConSignedAt: '2026-03-02T00:00:00.000Z' })
      const { status, body } = await json(post({ token: TOKEN, action: 'get' }))
      expect(status).toBe(200)
      expect(body).toMatchObject({ status: 'SIGNED', requiredFields: [], pdfUrl: '', signerName: 'Yuri Petrov' })
      expect(getSignedUrl).not.toHaveBeenCalled()
    })
  })

  function validPayload(over: Row = {}): Row {
    return {
      signerName: 'Yuri Petrov',
      agreed: true,
      fields: { DRIVER_NAME: 'Yuri Petrov', DRIVER_PHONE: '(312) 555-0101', TRUCK_NUMBER: '4471', TRAILER_NUMBER: 'T-88' },
      ...over,
    }
  }

  describe('submit', () => {
    it('signs once: stamps server-side, files a Public Signed Rate Confirmation, fills only what was blank', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED', driverName: 'Dispatch Knew This' })
      const { status, body } = await json(post({ token: TOKEN, action: 'submit', payload: validPayload() }))

      expect(status).toBe(200)
      expect(body).toMatchObject({ ok: true, alreadySigned: false, signerName: 'Yuri Petrov', version: 1 })
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row).toMatchObject({
        rateConStatus: 'SIGNED',
        rateConSignerName: 'Yuri Petrov',
        rateConSignerIp: IP,
        // The office's value is never overwritten by the signature page.
        driverName: 'Dispatch Knew This',
        // Normalized to E.164 before it is stored.
        driverPhone: '+13125550101',
        truckNumber: '4471',
        trailerNumber: 'T-88',
        // Signing with all four driver fields in reaches the top rung, and the board mirrors it.
        assignmentStatus: 'DRIVER_INFO_ENTERED',
      })
      expect(String(row.rateConKey)).toMatch(/^shipment-docs\/shp-1\/.+-signed-v1\.pdf$/)
      expect(table(TABLES.shipment).get('shp-1')!.carrierAssignmentStatus).toBe('DRIVER_INFO_ENTERED')

      // One PDF written, one page longer than the original (the certificate), at the key the row names.
      expect(puts()).toHaveLength(1)
      expect(puts()[0].Key).toBe(row.rateConKey)
      expect((await putPdf()).getPageCount()).toBe(3)

      // The load's Documents: Public folder (audience ALL), the type the invoice packet looks for.
      const [signed] = docs('RATE_CON')
      expect(signed).toMatchObject({
        shipmentId: 'shp-1', loadId: 'lod-1', loadCarrierId: 'lcr-1', name: 'Signed Rate Confirmation v1.pdf',
        audience: 'ALL', status: 'ACTIVE', version: 1, s3Key: row.rateConKey, pages: 3, source: 'GENERATED',
      })
      expect(signed.reviewStatus).toBeUndefined()

      const audit = auditRows().find((r) => r.action === 'rate_con_signed')!
      expect(audit).toMatchObject({ entityType: 'LOAD_CARRIER', entityId: 'lcr-1', user: 'CARRIER_PORTAL' })
      expect(JSON.parse(String(audit.changes))).toMatchObject({
        version: 1, signerName: 'Yuri Petrov', ip: IP, userAgent: UA, location: 'Chicago, US',
        documentId: signed.id, unsignedSha256: createHash('sha256').update(unsignedPdf).digest('hex'),
      })
      // The driver's phone never reaches the audit log.
      expect(JSON.stringify(audit)).not.toMatch(/555-0101|5550101/)
    })

    it('prints the cert evidence: unsigned-PDF hash, signer, IP, user agent and the SENT/VIEWED/SIGNED times', async () => {
      seedLoadCarrier()
      table(TABLES.audit).set('s1', { id: 's1', entityType: 'LOAD_CARRIER', entityId: 'lcr-1', action: 'SEND_RATE_CON', user: 'ryne@bcatcorp.com', createdAt: '2026-03-01T12:00:01.000Z', changes: JSON.stringify({ version: 1 }) })
      await post({ token: TOKEN, action: 'get' })
      await post({ token: TOKEN, action: 'submit', payload: validPayload() })
      const stream = pdfText(puts()[0].Body as Uint8Array)
      const hex = (t: string) => Buffer.from(t, 'latin1').toString('hex').toUpperCase()
      for (const text of [createHash('sha256').update(unsignedPdf).digest('hex'), IP, UA, 'dispatch@swift.example', 'ryne@bcatcorp.com', 'Chicago, US', 'SIGNING CERTIFICATE']) {
        expect(stream, text).toContain(hex(text))
      }
    })

    // ── the server validation matrix: every row must refuse and write nothing ──
    const bad: Array<[string, Row, string]> = [
      ['blank name', { signerName: '   ' }, 'signerName'],
      ['digits as a name', { signerName: '12345' }, 'signerName'],
      ['one-letter name', { signerName: 'Y' }, 'signerName'],
      ['name over the limit', { signerName: 'A'.repeat(121) }, 'signerName'],
      ['unticked agreement', { agreed: false }, 'agreed'],
      ['agreement as a string', { agreed: 'true' }, 'agreed'],
      ['no agreement at all', { agreed: undefined }, 'agreed'],
      ['no driver name', { fields: { DRIVER_PHONE: '312-555-0101', TRUCK_NUMBER: '4471', TRAILER_NUMBER: 'T-88' } }, 'DRIVER_NAME'],
      ['no driver phone', { fields: { DRIVER_NAME: 'Yuri Petrov', TRUCK_NUMBER: '4471', TRAILER_NUMBER: 'T-88' } }, 'DRIVER_PHONE'],
      ['phone too short', { fields: { DRIVER_NAME: 'Yuri Petrov', DRIVER_PHONE: '555-0101', TRUCK_NUMBER: '4471', TRAILER_NUMBER: 'T-88' } }, 'DRIVER_PHONE'],
      ['phone with letters', { fields: { DRIVER_NAME: 'Yuri Petrov', DRIVER_PHONE: 'call me', TRUCK_NUMBER: '4471', TRAILER_NUMBER: 'T-88' } }, 'DRIVER_PHONE'],
      ['area code starting 0', { fields: { DRIVER_NAME: 'Yuri Petrov', DRIVER_PHONE: '012-555-0101', TRUCK_NUMBER: '4471', TRAILER_NUMBER: 'T-88' } }, 'DRIVER_PHONE'],
      ['all-same-digit phone', { fields: { DRIVER_NAME: 'Yuri Petrov', DRIVER_PHONE: '555-555-5555', TRUCK_NUMBER: '4471', TRAILER_NUMBER: 'T-88' } }, 'DRIVER_PHONE'],
      ['no truck', { fields: { DRIVER_NAME: 'Yuri Petrov', DRIVER_PHONE: '312-555-0101', TRAILER_NUMBER: 'T-88' } }, 'TRUCK_NUMBER'],
      ['punctuation-only trailer', { fields: { DRIVER_NAME: 'Yuri Petrov', DRIVER_PHONE: '312-555-0101', TRUCK_NUMBER: '4471', TRAILER_NUMBER: '---' } }, 'TRAILER_NUMBER'],
      ['field over the limit', { fields: { DRIVER_NAME: 'Yuri Petrov', DRIVER_PHONE: '312-555-0101', TRUCK_NUMBER: 'X'.repeat(121), TRAILER_NUMBER: 'T-88' } }, 'TRUCK_NUMBER'],
      ['a field value that is not text', { fields: { DRIVER_NAME: 'Yuri Petrov', DRIVER_PHONE: 3125550101, TRUCK_NUMBER: '4471', TRAILER_NUMBER: 'T-88' } }, 'DRIVER_PHONE'],
    ]
    it.each(bad)('refuses %s with a specific error and writes nothing', async (_label, over, key) => {
      seedLoadCarrier()
      const { status, body } = await json(post({ token: TOKEN, action: 'submit', payload: validPayload(over) }))

      expect(status).toBe(400)
      expect(body.code).toBe('INVALID')
      expect(Object.keys(body.fieldErrors as Row)).toContain(key)
      expect(String(body.error).length).toBeGreaterThan(5)
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row.rateConStatus).toBe('SENT')
      expect(row.driverPhone).toBeUndefined()
      expect(puts()).toHaveLength(0)
      expect(docs()).toHaveLength(0)
      // The refusal itself is an audit row on the assignment, with the reasons but not the typed values.
      const refused = auditRows().find((r) => r.action === 'rate_con_sign_rejected')!
      expect(refused).toMatchObject({ entityId: 'lcr-1' })
      expect(Object.keys(JSON.parse(String(refused.changes)).errors)).toContain(key)
    })

    it('refuses a phone the office already holds only when the carrier retypes it badly', async () => {
      seedLoadCarrier({ driverName: 'Office Entered', driverPhone: '312-555-0000', truckNumber: '1', trailerNumber: '2' })
      const ok = await json(post({ token: TOKEN, action: 'submit', payload: { signerName: 'Yuri Petrov', agreed: true, fields: {} } }))
      expect(ok.status).toBe(200)
    })

    it('a bad optional value is refused too, not stored', async () => {
      seedLoadCarrier({ driverName: 'Office Entered', driverPhone: '312-555-0000', truckNumber: '1', trailerNumber: '2' })
      table(TABLES.settings).set('default', { id: 'default', rateConRequiredFields: ['PICKUP_ETA'] })
      const { status, body } = await json(post({ token: TOKEN, action: 'submit', payload: { signerName: 'Yuri Petrov', agreed: true, fields: { PICKUP_ETA: 'whenever' } } }))
      expect(status).toBe(400)
      expect(Object.keys(body.fieldErrors as Row)).toEqual(['PICKUP_ETA'])
    })

    it('ignores any PDF the browser sends: the stored original is what gets stamped', async () => {
      seedLoadCarrier()
      await post({ token: TOKEN, action: 'submit', payload: validPayload({ pdfBase64: Buffer.from('%PDF-evil').toString('base64') }) })
      expect((await putPdf()).getPageCount()).toBe(3)
      expect(Buffer.from(puts()[0].Body as Uint8Array).toString('latin1')).not.toContain('evil')
    })

    it('an assignment at RATE_CON_SENT climbs to the top on signing and keeps its earlier timestamp', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED', assignmentStatus: 'RATE_CON_SENT', assignmentTimes: JSON.stringify({ RATE_CON_SENT: '2026-03-01T00:00:00.000Z' }) })
      await post({ token: TOKEN, action: 'submit', payload: validPayload() })
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row.assignmentStatus).toBe('DRIVER_INFO_ENTERED')
      expect(JSON.parse(String(row.assignmentTimes))).toMatchObject({ RATE_CON_SENT: '2026-03-01T00:00:00.000Z', DRIVER_INFO_ENTERED: expect.any(String) })
    })

    it('is idempotent: a second POST after signing returns the first result and signs nothing again', async () => {
      seedLoadCarrier()
      const first = await json(post({ token: TOKEN, action: 'submit', payload: validPayload() }))
      const second = await json(post({ token: TOKEN, action: 'submit', payload: validPayload({ signerName: 'Impostor Name' }) }))

      expect(first.body.alreadySigned).toBe(false)
      expect(second.status).toBe(200)
      expect(second.body).toMatchObject({ ok: true, alreadySigned: true, signerName: 'Yuri Petrov', signedAt: first.body.signedAt })
      expect(puts()).toHaveLength(1)
      expect(docs('RATE_CON')).toHaveLength(1)
      expect(auditActions().filter((a) => a === 'rate_con_signed')).toHaveLength(1)
      expect(table(TABLES.loadCarrier).get('lcr-1')!.rateConSignerName).toBe('Yuri Petrov')
    })

    it('a lost race returns the winner\'s signature: still exactly one signed document', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED' })
      // The rival signs while this request is still deciding; the token stays on the row once signed.
      raceAfterScan({ rateConStatus: 'SIGNED', rateConSignerName: 'First Signer', rateConSignedAt: '2026-03-02T00:00:00.000Z' })

      const { status, body } = await json(post({ token: TOKEN, action: 'submit', payload: validPayload({ signerName: 'Second Signer' }) }))

      expect(status).toBe(200)
      expect(body).toMatchObject({ alreadySigned: true, signerName: 'First Signer' })
      expect(table(TABLES.loadCarrier).get('lcr-1')!.rateConSignerName).toBe('First Signer')
      expect(auditActions()).not.toContain('rate_con_signed')
    })

    it('heals a signature whose Documents row was lost after the claim', async () => {
      seedLoadCarrier({ rateConStatus: 'SIGNED', rateConSignerName: 'Yuri Petrov', rateConKey: 'shipment-docs/shp-1/x-signed-v1.pdf', rateConSignedAt: '2026-03-02T00:00:00.000Z' })
      const { status } = await json(post({ token: TOKEN, action: 'submit', payload: validPayload() }))
      expect(status).toBe(200)
      expect(docs('RATE_CON')).toHaveLength(1)
      expect(docs('RATE_CON')[0]).toMatchObject({ s3Key: 'shipment-docs/shp-1/x-signed-v1.pdf', status: 'ACTIVE', audience: 'ALL' })
      // Replaying again does not mint a second one.
      await post({ token: TOKEN, action: 'submit', payload: validPayload() })
      expect(docs('RATE_CON')).toHaveLength(1)
    })

    it('the new signed version REPLACES the old one: old is SUPERSEDED (kept), new is ACTIVE', async () => {
      seedLoadCarrier({ rateConVersion: 2, rateConToken: 'tok-v2', rateConStatus: 'SENT' })
      table(TABLES.shipmentDoc).set('old-signed', { id: 'old-signed', shipmentId: 'shp-1', loadId: 'lod-1', loadCarrierId: 'lcr-1', type: 'RATE_CON', status: 'ACTIVE', version: 1, audience: 'ALL', s3Key: 'shipment-docs/shp-1/old-signed-v1.pdf' })
      table(TABLES.shipmentDoc).set('other-carrier', { id: 'other-carrier', shipmentId: 'shp-1', loadId: 'lod-1', loadCarrierId: 'lcr-9', type: 'RATE_CON', status: 'ACTIVE', version: 1, audience: 'ALL', s3Key: 'shipment-docs/shp-1/other.pdf' })
      table(TABLES.shipmentDoc).set('pod', { id: 'pod', shipmentId: 'shp-1', loadId: 'lod-1', type: 'POD', status: 'ACTIVE', audience: 'ALL', s3Key: 'shipment-docs/shp-1/pod.pdf' })

      const { status } = await json(post({ token: 'tok-v2', action: 'submit', payload: validPayload() }))
      expect(status).toBe(200)

      expect(table(TABLES.shipmentDoc).get('old-signed')).toMatchObject({ status: 'SUPERSEDED' })
      expect(table(TABLES.shipmentDoc).get('other-carrier')!.status).toBe('ACTIVE')
      expect(table(TABLES.shipmentDoc).get('pod')!.status).toBe('ACTIVE')
      const fresh = docs('RATE_CON').find((d) => d.version === 2)!
      expect(fresh).toMatchObject({ status: 'ACTIVE', audience: 'ALL', supersedesId: 'old-signed', name: 'Signed Rate Confirmation v2.pdf' })
      const superseded = auditRows().find((r) => r.action === 'rate_con_document_superseded')!
      expect(JSON.parse(String(superseded.changes))).toMatchObject({ supersededDocumentId: 'old-signed', byDocumentId: fresh.id, version: 2 })
    })

    it('counts the request against the token', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED' })
      await post({ token: TOKEN, action: 'submit', payload: validPayload() })
      expect(table(TABLES.loadCarrier).get('lcr-1')!.rateConRequestCount).toBe(1)
    })

    it('stops answering a token that has been hammered', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED', rateConRequestCount: 201 })
      const { status } = await json(post({ token: TOKEN, action: 'submit', payload: validPayload() }))
      expect(status).toBe(429)
      expect(puts()).toHaveLength(0)
    })

    it('refuses a voided or expired link and logs it', async () => {
      seedLoadCarrier({ rateConStatus: 'VOIDED' })
      const { status } = await json(post({ token: TOKEN, action: 'submit', payload: validPayload() }))
      expect(status).toBe(410)
      expect(auditActions()).toContain('rate_con_link_rejected')
      expect(puts()).toHaveLength(0)
    })

    it('refuses a body over the cap before it parses it', async () => {
      seedLoadCarrier()
      const res = await handler({
        body: JSON.stringify({ token: TOKEN, action: 'submit', payload: { junk: 'A'.repeat(70_000) } }),
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
      const audit = auditRows()[0]
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
      expect(status).toBe(410)
    })

    it('cannot bury a signature that landed first', async () => {
      seedLoadCarrier({ rateConStatus: 'OPENED' })
      raceAfterScan({ rateConStatus: 'SIGNED', rateConSignerName: 'Yuri Petrov' })

      const { status } = await json(post({ token: TOKEN, action: 'decline', payload: { reason: 'Rate too low' } }))

      expect(status).toBe(409)
      const row = table(TABLES.loadCarrier).get('lcr-1')!
      expect(row.rateConStatus).toBe('SIGNED')
      expect(row.rateConSignerName).toBe('Yuri Petrov')
      expect(auditActions()).not.toContain('rate_con_declined')
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
