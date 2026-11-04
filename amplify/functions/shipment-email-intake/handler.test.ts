import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handler } from './handler'

const lambdaSend = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    send = lambdaSend
  }
  class InvokeCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  return { LambdaClient, InvokeCommand }
})

const dynamoSend = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send = dynamoSend
  }
  class QueryCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  return { DynamoDBClient, QueryCommand }
})

const event = (body: unknown, base64 = false) => ({
  body: base64 ? Buffer.from(JSON.stringify(body)).toString('base64') : JSON.stringify(body),
  isBase64Encoded: base64,
})

const JSON_BODY = (res: { statusCode: number; body: string }) => JSON.parse(res.body)

describe('shipment-email-intake', () => {
  beforeEach(() => {
    vi.resetModules()
    lambdaSend.mockReset()
    dynamoSend.mockReset()
    dynamoSend.mockResolvedValue({ Items: [] })
    process.env.SHIPMENT_EMAIL_INTAKE_SECRET = 'intake-secret'
    process.env.THREAD_MAILBOX = 'ai4bcat@gmail.com'
    process.env.SHIPMENT_MESSAGE_TABLE_NAME = 'ShipmentMessage-test'
    process.env.TMS_TRACKING_ACTIONS_FUNCTION_NAME = 'tms-tracking-actions-test'
  })

  it('rejects a bad secret', async () => {
    const res = await handler(event({ secret: 'wrong', messageId: '<x@example.com>', to: 'ai4bcat+tracking.shp-1@gmail.com', from: 'a', subject: 's', body: 'b' }))
    expect(res.statusCode).toBe(401)
  })

  it('routes by plus-address and invokes tms-tracking-actions', async () => {
    lambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ routed: true })) })

    const res = await handler(event({
      secret: 'intake-secret',
      messageId: '<reply-1@example.com>',
      to: 'ai4bcat+tracking.shp-123@gmail.com',
      from: 'driver@example.com',
      subject: 'Re: BC1001',
      body: 'Loaded',
    }))

    expect(res.statusCode).toBe(200)
    const body = JSON_BODY(res)
    expect(body.shipmentId).toBe('shp-123')

    const invoke = lambdaSend.mock.calls[0][0] as { input: { FunctionName: string; Payload: Buffer } }
    const payload = JSON.parse(invoke.input.Payload.toString('utf-8')) as {
      arguments: { action: string; input: Record<string, unknown> }
      systemCaller?: string
      identity?: unknown
    }
    expect(payload.arguments.action).toBe('INGEST_SHIPMENT_MESSAGE')
    // The router can only authorize this caller through the system-caller allow-list; a
    // hand-built identity has no claims and fails `Unauthorized: could not resolve caller email`.
    expect(payload.systemCaller).toBe('shipment-email-intake')
    expect(payload.identity).toBeUndefined()
    expect(payload.arguments.input.shipmentId).toBe('shp-123')
    expect(payload.arguments.input.messageId).toBe('<reply-1@example.com>')
  })

  it('routes by Message-ID when no plus-address matches', async () => {
    dynamoSend.mockResolvedValue({
      Items: [{
        shipmentId: { S: 'shp-456' },
        messageId: { S: '<outbound-1@example.com>' },
      }],
    })
    lambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ routed: true })) })

    const res = await handler(event({
      secret: 'intake-secret',
      messageId: '<outbound-1@example.com>',
      to: 'ai4bcat@gmail.com',
      from: 'driver@example.com',
      subject: 'Re: BC1001',
      body: 'Loaded',
    }))

    expect(res.statusCode).toBe(200)
    expect(JSON_BODY(res).shipmentId).toBe('shp-456')
  })

  it('routes a reply that lost its plus-address by In-Reply-To, and passes it on', async () => {
    dynamoSend.mockImplementation(async (cmd: { input: { ExpressionAttributeValues: { ':k': { S: string } } } }) =>
      cmd.input.ExpressionAttributeValues[':k'].S === '<SES123@email.amazonses.com>'
        ? { Items: [{ shipmentId: { S: 'shp-789' }, messageId: { S: '<SES123@email.amazonses.com>' } }] }
        : { Items: [] })
    lambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ routed: true })) })
    const res = await handler(event({
      secret: 'intake-secret',
      messageId: '<reply-1@carrier.example>',
      inReplyTo: '<SES123@email.amazonses.com>',
      to: 'ai4bcat@gmail.com',
      from: 'driver@example.com',
      subject: 'Re: Rate confirmation',
      body: 'ok',
    }))
    expect(res.statusCode).toBe(200)
    expect(JSON_BODY(res).shipmentId).toBe('shp-789')
    const invoked = JSON.parse(Buffer.from(lambdaSend.mock.calls[0][0].input.Payload).toString())
    expect(invoked.arguments.input.inReplyTo).toBe('<SES123@email.amazonses.com>')
  })

  it('walks References newest-first when In-Reply-To is not ours', async () => {
    dynamoSend.mockImplementation(async (cmd: { input: { ExpressionAttributeValues: { ':k': { S: string } } } }) =>
      cmd.input.ExpressionAttributeValues[':k'].S === '<SES9@email.amazonses.com>'
        ? { Items: [{ shipmentId: { S: 'shp-9' } }] }
        : { Items: [] })
    lambdaSend.mockResolvedValue({ Payload: Buffer.from('{}') })
    const res = await handler(event({
      secret: 'intake-secret', messageId: '<r2@x.example>', inReplyTo: '<mid-thread@x.example>',
      references: '<SES9@email.amazonses.com> <mid-thread@x.example>',
      to: 'ai4bcat@gmail.com', from: 'a@b.example', subject: 's', body: 'b',
    }))
    expect(JSON_BODY(res).shipmentId).toBe('shp-9')
  })

  const byId = (map: Record<string, string>) =>
    dynamoSend.mockImplementation(async (cmd: { input: { ExpressionAttributeValues: { ':k': { S: string } } } }) => {
      const sid = map[cmd.input.ExpressionAttributeValues[':k'].S]
      return sid ? { Items: [{ shipmentId: { S: sid } }] } : { Items: [] }
    })
  const reply = (extra: Record<string, unknown>) => handler(event({
    secret: 'intake-secret', messageId: '<r@x.example>', to: 'ai4bcat@gmail.com', from: 'a@b.example', subject: 'Re: hello', body: 'b', ...extra,
  }))

  it('matches a forwarded reply (no plus-address) on the SES Message-ID in In-Reply-To', async () => {
    byId({ '<SESABC@email.amazonses.com>': 'shp-1' })
    lambdaSend.mockResolvedValue({ Payload: Buffer.from('{}') })
    const body = JSON_BODY(await reply({ inReplyTo: '<SESABC@email.amazonses.com>' }))
    expect(body).toMatchObject({ shipmentId: 'shp-1', routedBy: 'in-reply-to', conflict: false })
  })

  it('matches a reply by the [ref <shipment>] subject token alone', async () => {
    lambdaSend.mockResolvedValue({ Payload: Buffer.from('{}') })
    const body = JSON_BODY(await reply({ subject: 'Re: Fwd: Rate confirmation — load S1-A [ref shp-77]' }))
    expect(body).toMatchObject({ shipmentId: 'shp-77', routedBy: 'subject-ref', conflict: false })
  })

  it('plus-address wins over In-Reply-To and the subject, and the conflict is flagged', async () => {
    byId({ '<SESX@email.amazonses.com>': 'shp-B' })
    lambdaSend.mockResolvedValue({ Payload: Buffer.from('{}') })
    const res = await reply({ to: 'ai4bcat+tracking.shp-a@gmail.com', inReplyTo: '<SESX@email.amazonses.com>', subject: 'Re: x [ref shp-C]' })
    const body = JSON_BODY(res)
    expect(body).toMatchObject({ shipmentId: 'shp-a', routedBy: 'plus-address', conflict: true })
    const invoked = JSON.parse(Buffer.from(lambdaSend.mock.calls[0][0].input.Payload).toString())
    expect(invoked.arguments.input.routingNote).toMatch(/disagree/)
  })

  it('In-Reply-To wins over the subject when they disagree', async () => {
    byId({ '<SESY@email.amazonses.com>': 'shp-B' })
    lambdaSend.mockResolvedValue({ Payload: Buffer.from('{}') })
    const body = JSON_BODY(await reply({ inReplyTo: '<SESY@email.amazonses.com>', subject: '[ref shp-C]' }))
    expect(body).toMatchObject({ shipmentId: 'shp-B', conflict: true })
  })

  it('leaves an unrelated reply unthreaded', async () => {
    const res = await reply({ inReplyTo: '<someone-else@x.example>', subject: 'Re: lunch' })
    expect(res.statusCode).toBe(422)
    expect(lambdaSend).not.toHaveBeenCalled()
  })

  it('returns 422 when it cannot route the message', async () => {
    const res = await handler(event({
      secret: 'intake-secret',
      messageId: '<x@example.com>',
      to: 'ai4bcat@gmail.com',
      from: 'driver@example.com',
      subject: 'Hi',
      body: 'Hello',
    }))

    expect(res.statusCode).toBe(422)
  })

  it('logs the parsed message on dev when the tracking function is unset', async () => {
    delete process.env.TMS_TRACKING_ACTIONS_FUNCTION_NAME
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const res = await handler(event({
      secret: 'intake-secret',
      messageId: '<dev-1@example.com>',
      to: 'ai4bcat+tracking.shp-dev@gmail.com',
      from: 'driver@example.com',
      subject: 'POD',
      body: 'See attached',
      attachments: [{ name: 'pod.pdf', contentType: 'application/pdf', base64: 'cGRmLWR1bW15' }],
    }))

    expect(res.statusCode).toBe(200)
    expect(JSON_BODY(res).logged).toBe(true)
    expect(logSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('parsed inbound message'))).toBe(true)
    logSpy.mockRestore()
  })
})
