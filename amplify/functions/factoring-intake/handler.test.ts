import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'

const { send } = vi.hoisted(() => {
  process.env.FACTORING_INTAKE_SECRET = 'test-secret'
  process.env.TABLE_NAME = 'FactoringItem-test'
  return { send: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send = send }
  class PutItemCommand { input: unknown; __type = 'Put'; constructor(input: unknown) { this.input = input } }
  return { DynamoDBClient, PutItemCommand }
})

import { handler, extractProNumber, isForFactoringQueue, extractAddresses } from './handler'

type MockCommand = {
  __type?: string
  input: {
    TableName?: string
    ConditionExpression?: string
    Item?: Record<string, AttributeValue>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

function event(payload: Record<string, unknown>, method = 'POST') {
  return {
    body: JSON.stringify(payload),
    requestContext: { http: { method } },
  }
}

describe('extractProNumber', () => {
  it('extracts numeric PRO numbers from canonical subjects', () => {
    expect(extractProNumber('Invoice for PRO #01234')).toBe('01234')
    expect(extractProNumber('Invoice for PRO #12345')).toBe('12345')
  })

  it('tolerates forward prefixes, case variation, and extra whitespace', () => {
    const cases = [
      'Fwd: Invoice for PRO #01234',
      'FW: invoice for pro #01234',
      'Invoice  for   PRO # 01234',
      'Invoice for PRO#01234',
      'RE: Invoice for PRO  #  01234',
    ]
    for (const subject of cases) {
      expect(extractProNumber(subject), subject).toBe('01234')
    }
  })

  it('allows the same PRO number to appear more than once', () => {
    expect(
      extractProNumber(
        'Invoice for PRO #01234 — see also PRO #01234',
      ),
    ).toBe('01234')
  })

  it('returns null when no invoice PRO phrase is present', () => {
    expect(extractProNumber('Random subject')).toBeNull()
    expect(extractProNumber('Invoice for PO #01234')).toBeNull()
    expect(extractProNumber('PRO #01234')).toBeNull()
  })

  it('accepts alphanumeric PROs and upper-cases them', () => {
    expect(extractProNumber('Invoice for PRO #945143JJ')).toBe('945143JJ')
    expect(extractProNumber('Invoice for PRO #a01234')).toBe('A01234')
  })

  it('stops at punctuation after the PRO', () => {
    expect(extractProNumber('Invoice for PRO #01234,')).toBe('01234')
    expect(extractProNumber('Invoice for PRO #01234. Attached')).toBe('01234')
    expect(extractProNumber('Invoice for PRO #123-45')).toBe('123-45')
    expect(extractProNumber('Invoice for PRO #01234-')).toBe('01234')
    expect(extractProNumber('Invoice for PRO 01234')).toBe('01234')
  })

  it('returns null when the phrase has no id or the id has no digit', () => {
    expect(extractProNumber('Invoice for PRO #')).toBeNull()
    expect(extractProNumber('Invoice for PRO # — see attached')).toBeNull()
    expect(extractProNumber('Invoice for PRO number 12345')).toBeNull()
    expect(extractProNumber('Invoice for PRO from OTR')).toBeNull()
    expect(extractProNumber('Invoice for PRO #ABC')).toBeNull()
  })

  it('returns null when invoice phrases name different PRO numbers', () => {
    expect(
      extractProNumber(
        'Invoice for PRO #01234 and Invoice for PRO #56789',
      ),
    ).toBeNull()
  })
})

describe('factoring-intake handler', () => {
  it('rejects JSON null before secret access', async () => {
    const res = await handler({ body: 'null' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid JSON body' })
  })

  it('rejects missing secret as unauthorized', async () => {
    const res = await handler(
      event({
        messageId: 'msg-1',
        subject: 'Invoice for PRO #1',
        from: 'bridge@bcatcorp.com',
      }),
    )
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'unauthorized' })
  })

  it('rejects wrong secret', async () => {
    const res = await handler(
      event({
        secret: 'wrong',
        messageId: 'msg-1',
        subject: 'Invoice for PRO #1',
        from: 'bridge@bcatcorp.com',
      }),
    )
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'unauthorized' })
  })

  it('rejects non-string messageId', async () => {
    const res = await handler(
      event({
        secret: 'test-secret',
        messageId: 123,
        subject: 'Invoice for PRO #1',
        from: 'bridge@bcatcorp.com',
      }),
    )
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'messageId required' })
  })

  it('rejects non-string subject', async () => {
    const res = await handler(
      event({
        secret: 'test-secret',
        messageId: 'msg-1',
        subject: true,
        from: 'bridge@bcatcorp.com',
      }),
    )
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'subject required' })
  })

  it('rejects non-string from to avoid marshalling an object into a GraphQL string', async () => {
    const res = await handler(
      event({
        secret: 'test-secret',
        messageId: 'msg-1',
        subject: 'Invoice for PRO #1',
        from: { address: 'bridge@bcatcorp.com' },
      }),
    )
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'from must be a string' })
  })

  it('rejects non-POST methods', async () => {
    const res = await handler(
      event(
        {
          secret: 'test-secret',
          messageId: 'msg-1',
          subject: 'Invoice for PRO #1',
          from: 'bridge@bcatcorp.com',
        },
        'GET',
      ),
    )
    expect(res.statusCode).toBe(405)
  })

  it('rejects subjects without a usable PRO number', async () => {
    const res = await handler(
      event({
        secret: 'test-secret',
        messageId: 'msg-1',
        subject: 'Just a regular subject',
        from: 'bridge@bcatcorp.com',
      }),
    )
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'no invoice PRO number' })
  })

  it('rejects multiple different invoice PRO numbers', async () => {
    const res = await handler(
      event({
        secret: 'test-secret',
        messageId: 'msg-1',
        subject: 'Invoice for PRO #01234 and Invoice for PRO #56789',
        from: 'bridge@bcatcorp.com',
      }),
    )
    expect(res.statusCode).toBe(422)
  })

  it('creates a FactoringItem row with NEED_TO_FACTOR status', async () => {
    send.mockResolvedValue({})

    const res = await handler(
      event({
        secret: 'test-secret',
        messageId: 'msg-001',
        subject: 'Invoice for PRO #012345',
        from: 'ivanfactoring@bcatcorp.com',
        receivedAt: '2026-09-23T10:00:00Z',
      }),
    )

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      id: '012345',
      proNumber: '012345',
      duplicate: false,
    })

    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0][0] as MockCommand
    expect(command.__type).toBe('Put')
    expect(command.input.TableName).toBe('FactoringItem-test')
    expect(command.input.ConditionExpression).toBe('attribute_not_exists(id)')

    const item = unmarshall(command.input.Item!)
    expect(item).toMatchObject({
      id: '012345',
      proNumber: '012345',
      __typename: 'FactoringItem',
      status: 'NEED_TO_FACTOR',
      subject: 'Invoice for PRO #012345',
      fromEmail: 'ivanfactoring@bcatcorp.com',
      messageId: 'msg-001',
    })
    expect(item.receivedAt).toBe('2026-09-23T10:00:00.000Z')
  })

  it('returns duplicate:true without changing status on conditional-check failure', async () => {
    const conditionalError = Object.assign(
      new Error('The conditional request failed'),
      { name: 'ConditionalCheckFailedException' },
    )
    send.mockRejectedValueOnce(conditionalError)

    const res = await handler(
      event({
        secret: 'test-secret',
        messageId: 'msg-002',
        subject: 'Invoice for PRO #012345',
        from: 'ivanfactoring@bcatcorp.com',
      }),
    )

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      id: '012345',
      proNumber: '012345',
      duplicate: true,
    })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('only mail addressed to the factoring group creates a row', () => {
  it('extracts addresses from a header with display names', () => {
    expect(extractAddresses('Ivan Factoring <ivanfactoring@bcatcorp.com>, ryne@bcatcorp.com'))
      .toEqual(['ivanfactoring@bcatcorp.com', 'ryne@bcatcorp.com'])
  })

  it('accepts the group whatever the casing', () => {
    expect(isForFactoringQueue(['IvanFactoring@BcatCorp.com'])).toBe(true)
  })

  it('accepts when the group is one recipient among several', () => {
    expect(isForFactoringQueue(['ryne@bcatcorp.com', 'ivanfactoring@bcatcorp.com'])).toBe(true)
  })

  it('refuses mail merely sent to somebody else', () => {
    expect(isForFactoringQueue(['ryne@bcatcorp.com', 'dispatch@bcatcorp.com'])).toBe(false)
  })

  it('refuses a lookalike address', () => {
    // The bridge's Gmail query includes a full-text term, so near misses do reach here.
    expect(isForFactoringQueue(['ivanfactoring@bcatcorp.com.example.net'])).toBe(false)
    expect(isForFactoringQueue(['notivanfactoring@bcatcorp.com'])).toBe(false)
  })

  it('refuses a message that only MENTIONS the group', () => {
    /*
     * The whole point of checking the address rather than the text: a forwarded invoice
     * quoting "ivanfactoring@bcatcorp.com" in its body was never delivered to the group,
     * and the bridge's search deliberately casts a wide net that catches exactly that.
     */
    expect(isForFactoringQueue(extractAddresses('please copy ivanfactoring at bcatcorp dot com')))
      .toBe(false)
  })

  it('refuses nothing at all', () => {
    expect(isForFactoringQueue([])).toBe(false)
  })
})
