/**
 * Factoring bridge byte-identity guard (MERGE_REGRESSION T6).
 *
 * The Gmail bridge + factoring-intake Lambda carry production invoices to the factor. The
 * Step AW merge must not change them by one byte:
 *   1. the source files hash to what origin/main has;
 *   2. the handler, fed a fixed set of requests, answers and writes exactly the records
 *      captured from origin/main's handler (bridgeIdentity.golden.json);
 *   3. the new release-to-billing queue row (`factoringRowFor`) is the bridge's row plus
 *      only the documented additive fields, so `manageOtr submit` reads both the same way.
 *
 * Changing the bridge on purpose = regenerate the golden files from the new origin/main.
 * Golden hashes: `git show origin/main:<path> | shasum -a 256`. Golden records: run this
 * file against the extracted origin/main handler with `vitest -u`.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'

const { send, lambdaSend } = vi.hoisted(() => {
  process.env.FACTORING_INTAKE_SECRET = 'guard-secret'
  process.env.TABLE_NAME = 'FactoringItem-guard'
  process.env.OTR_ACTIONS_FUNCTION_NAME = 'otr-actions-guard'
  return { send: vi.fn(), lambdaSend: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send = send }
  class PutItemCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  return { DynamoDBClient, PutItemCommand }
})
vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send = lambdaSend }
  class InvokeCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

import { handler, extractProNumber, extractAddresses, isForFactoringQueue } from './handler'
import { factoringRowFor } from '../../../src/lib/factorHandoff'
import type { Stop } from '../../../src/types'
import type { CustomerRecord, InvoiceRecord, OrderRecord } from '../../../src/types/tms'

const ROOT = resolve(__dirname, '../../..')
const sha256 = (path: string) => createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex')

describe('bridge source files are byte-identical to origin/main', () => {
  const golden = JSON.parse(readFileSync(resolve(__dirname, 'bridgeIdentity.hashes.json'), 'utf8')) as Record<string, string>

  it.each(Object.keys(golden))('%s', (path) => {
    expect(sha256(path)).toBe(golden[path])
  })
})

const NOW = '2026-11-07T15:00:00.000Z'
const GOOD = {
  secret: 'guard-secret',
  messageId: 'msg-guard-1',
  subject: 'Invoice for PRO #01234',
  from: 'Billing <billing@example.test>',
  receivedAt: '2026-11-06T10:00:00.000Z',
  recipients: ['ivanfactoring@bcatcorp.com'],
}
const post = (payload: unknown) => ({ body: JSON.stringify(payload), requestContext: { http: { method: 'POST' } } })

const SCENARIOS: Array<[string, unknown]> = [
  ['canonical invoice', post(GOOD)],
  ['no receivedAt defaults to now', post({ ...GOOD, receivedAt: undefined, messageId: 'msg-guard-2' })],
  ['recipients as a raw header string with display names', post({ ...GOOD, recipients: 'Ivan Factoring <IvanFactoring@BCATCorp.com>, Other <o@example.test>', messageId: 'msg-guard-3' })],
  ['alphanumeric PRO is upper-cased', post({ ...GOOD, subject: 'Fwd: Invoice for PRO #a98765b', messageId: 'msg-guard-4' })],
  ['Transflo template', post({ ...GOOD, subject: 'SUBMIT TO TRANSFLO Pro # 14589 Ref # 2284206 Attached', messageId: 'msg-guard-5' })],
  ['old bridge with no recipients is accepted', post({ ...GOOD, recipients: undefined, messageId: 'msg-guard-6' })],
  ['wrong recipient is 422', post({ ...GOOD, recipients: ['someone@example.test'] })],
  ['group only quoted in a subject is not a recipient', post({ ...GOOD, recipients: ['other@example.test'], subject: 'ivanfactoring@bcatcorp.com PRO #12345' })],
  ['no PRO in subject is 422', post({ ...GOOD, subject: 'Random subject' })],
  ['empty subject is 422', post({ ...GOOD, subject: '' })],
  ['two different PROs is 422', post({ ...GOOD, subject: 'Invoice for PRO #01234 and Invoice for PRO #56789' })],
  ['bad secret is 401', post({ ...GOOD, secret: 'nope' })],
  ['missing secret is 401', post({ ...GOOD, secret: undefined })],
  ['missing messageId is 400', post({ ...GOOD, messageId: ' ' })],
  ['non-string from is 400', post({ ...GOOD, from: 5 })],
  ['invalid JSON is 400', { body: '{nope', requestContext: { http: { method: 'POST' } } }],
  ['JSON null is 400', { body: 'null' }],
  ['GET is 405', { body: null, requestContext: { http: { method: 'GET' } } }],
  ['base64 body decodes', { body: Buffer.from(JSON.stringify({ ...GOOD, messageId: 'msg-guard-7' })).toString('base64'), isBase64Encoded: true, requestContext: { http: { method: 'POST' } } }],
]

type PutCall = { input: { TableName?: string; ConditionExpression?: string; Item?: Record<string, AttributeValue> } }

async function run(ev: Parameters<typeof handler>[0], opts: { duplicate?: boolean; enrichFails?: boolean } = {}) {
  send.mockReset()
  lambdaSend.mockReset()
  if (opts.duplicate) send.mockRejectedValue(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }))
  else send.mockResolvedValue({})
  if (opts.enrichFails) lambdaSend.mockRejectedValue(new Error('invoke down'))
  else lambdaSend.mockResolvedValue({})
  const res = await handler(ev)
  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.body) as unknown,
    puts: (send.mock.calls as PutCall[][]).map(([c]) => ({
      TableName: c.input.TableName,
      ConditionExpression: c.input.ConditionExpression,
      Item: c.input.Item ? unmarshall(c.input.Item) : undefined,
    })),
    enrichment: (lambdaSend.mock.calls as { input: { FunctionName: string; InvocationType: string; Payload: Buffer } }[][]).map(([c]) => ({
      FunctionName: c.input.FunctionName,
      InvocationType: c.input.InvocationType,
      Payload: JSON.parse(Buffer.from(c.input.Payload).toString('utf8')) as unknown,
    })),
  }
}

describe('factoring-intake behaviour matches origin/main record for record', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  it('every request answers and writes what production does', async () => {
    const captured: Record<string, unknown> = {}
    for (const [name, ev] of SCENARIOS) captured[name] = await run(ev as Parameters<typeof handler>[0])
    captured['duplicate PRO is skipped, not retried'] = await run(post(GOOD) as Parameters<typeof handler>[0], { duplicate: true })
    captured['enrichment failure never loses the row'] = await run(post(GOOD) as Parameters<typeof handler>[0], { enrichFails: true })
    await expect(JSON.stringify(captured, null, 1) + '\n').toMatchFileSnapshot('./bridgeIdentity.golden.json')
  })

  it('subject, recipient and address parsing is unchanged', async () => {
    const subjects = [
      'Invoice for PRO #01234', 'Fwd: Invoice for PRO #01234', 'Invoice for PRO#01234', 'PRO #945143JJ', '14589', 'Fwd: 14589',
      'SUBMIT TO TRANSFLO Pro # 14589 Ref # 2284206', 'Invoice for PRO #123-45', 'Invoice for PRO #01234-', 'Invoice for PRO 01234',
      'Invoice for PO #01234', 'Invoice for PRO #ABC', 'Invoice for PRO #01234 and Invoice for PRO #56789', 'Random subject', '',
    ]
    const headers = ['Ivan <IvanFactoring@bcatcorp.com>', 'a@x.test, <b@x.test>', 'plain@x.test', 'no address here', '']
    const parsed = {
      pro: subjects.map((s) => [s, extractProNumber(s)]),
      addresses: headers.map((h) => [h, extractAddresses(h), isForFactoringQueue(extractAddresses(h))]),
    }
    await expect(JSON.stringify(parsed, null, 1) + '\n').toMatchFileSnapshot('./bridgeParsing.golden.json')
  })
})

describe('the release-to-billing queue row is the bridge row plus only the documented additions', () => {
  const stops: Stop[] = [
    { id: 's0', type: 'pickup', sequence: 0, appt: NOW, driverId: null, city: 'Mesa, AZ', address: { city: 'Mesa', state: 'AZ', zip: '85212' } },
    { id: 's1', type: 'delivery', sequence: 1, appt: NOW, driverId: null, city: 'Reno, NV', address: { city: 'Reno', state: 'NV', zip: '89501' } },
  ]
  const invoice = {
    id: 'INV-1', number: 'INV-1', orderId: 'ord-1', shipmentId: 'shp-1', shipmentNumber: 'BC-1', customerId: 'cus-1',
    status: 'ISSUED', invoiceDate: '2026-11-01', totalCents: 100_000, references: [],
  } as unknown as InvoiceRecord
  const order = { id: 'ord-1', shipmentId: 'shp-1', customerId: 'cus-1' } as unknown as OrderRecord
  const customer = { id: 'cus-1', name: 'ZZ Broker', mcNumber: '000001' } as unknown as CustomerRecord

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  const queueRow = factoringRowFor({
    invoice, order, load: { id: 'ld-1', aljexId: 'BC-1-1', shipmentId: 'shp-1' }, stops, customer, caller: 'ops@example.test', now: NOW,
  }) as unknown as Record<string, unknown>

  it('carries every field the bridge writes, with the same type', async () => {
    const { puts } = await run(post(GOOD) as Parameters<typeof handler>[0])
    const bridgeRow = puts[0].Item as Record<string, unknown>
    // `toEmails` is the bridge's own audit of who the mail was delivered to; a TMS row has no mail.
    const bridgeFields = Object.keys(bridgeRow).filter((k) => k !== 'toEmails' && k !== '__typename')
    expect(bridgeFields.sort()).toEqual(['createdAt', 'fromEmail', 'id', 'messageId', 'proNumber', 'receivedAt', 'status', 'subject', 'updatedAt'])
    for (const k of bridgeFields) expect(typeof queueRow[k], k).toBe(typeof bridgeRow[k])
    expect(queueRow.status).toBe(bridgeRow.status)
    expect(queueRow.id).toBe(queueRow.proNumber)
  })

  it('adds only the optional TMS fields and nothing else', () => {
    const bridgeFields = ['createdAt', 'fromEmail', 'id', 'messageId', 'proNumber', 'receivedAt', 'status', 'subject', 'updatedAt']
    const extra = Object.keys(queueRow).filter((k) => !bridgeFields.includes(k)).sort()
    expect(extra).toEqual(['customerId', 'invoiceId', 'loadId', 'orderId', 'otrManualFields', 'shipmentId', 'source'])
  })
})
