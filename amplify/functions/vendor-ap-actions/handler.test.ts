import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marshall } from '@aws-sdk/util-dynamodb'

const OWNER_EMAIL = 'ryne@bcatcorp.com'

const send = vi.hoisted(() => {
  process.env.TABLE_NAME = 'VendorPayable-test'
  process.env.MAINTENANCE_TABLE_NAME = 'MaintenanceInvoice-test'
  return vi.fn()
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send = send
  }
  class GetItemCommand {
    input: unknown
    __type = 'Get'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class PutItemCommand {
    input: unknown
    __type = 'Put'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class UpdateItemCommand {
    input: unknown
    __type = 'Update'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class TransactWriteItemsCommand {
    input: unknown
    __type = 'Transact'
    constructor(input: unknown) {
      this.input = input
    }
  }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, TransactWriteItemsCommand }
})

import { handler, parseInput } from './handler'

interface MockGetCommand {
  __type: 'Get'
  input: { TableName?: string; Key?: Record<string, AttributeValue>; Item?: Record<string, AttributeValue> }
}

interface MockPutCommand {
  __type: 'Put'
  input: {
    TableName?: string
    Item?: Record<string, AttributeValue>
    ConditionExpression?: string
  }
}

interface MockUpdateCommand {
  __type: 'Update'
  input: {
    TableName?: string
    Key?: Record<string, AttributeValue>
    ConditionExpression?: string
    UpdateExpression?: string
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, AttributeValue>
    ReturnValues?: string
  }
}

interface MockTransactCommand {
  __type: 'Transact'
  input: {
    TransactItems?: Array<{
      Update?: {
        TableName?: string
        Key?: Record<string, AttributeValue>
        ConditionExpression?: string
        UpdateExpression?: string
        ExpressionAttributeNames?: Record<string, string>
        ExpressionAttributeValues?: Record<string, AttributeValue>
      }
    }>
  }
}

type MockCommand = MockGetCommand | MockPutCommand | MockUpdateCommand | MockTransactCommand

function isPut(cmd: MockCommand): cmd is MockPutCommand {
  return cmd.__type === 'Put'
}

function isUpdate(cmd: MockCommand): cmd is MockUpdateCommand {
  return cmd.__type === 'Update'
}

function isTransact(cmd: MockCommand): cmd is MockTransactCommand {
  return cmd.__type === 'Transact'
}

function asCommand(call: unknown[]): MockCommand {
  return call[0] as MockCommand
}

interface TestIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

function identity(overrides?: { email?: string; groups?: string[] }): TestIdentity {
  return {
    sub: 'sub-1',
    username: overrides?.email ?? 'user@bcatcorp.com',
    claims: { 'cognito:groups': overrides?.groups ?? ['page-vendorAp'] },
  }
}

interface TestEventArgs {
  action: string
  id?: string | null
  maintenanceInvoiceId?: string | null
  input?: string | Record<string, unknown> | null
}

interface TestAppSyncEvent {
  arguments: TestEventArgs
  identity?: TestIdentity | null
}

function event(args: TestEventArgs, id?: TestIdentity): TestAppSyncEvent {
  return { arguments: args, identity: id ?? identity() }
}

beforeEach(() => {
  send.mockReset()
})

describe('authorization', () => {
  it('rejects missing identity', async () => {
    await expect(handler({ arguments: { action: 'SEND_MAINTENANCE', maintenanceInvoiceId: 'm-1' }, identity: null })).rejects.toThrow(
      'Unauthorized: missing identity',
    )
  })

  it('rejects unresolved email', async () => {
    await expect(
      handler({
        arguments: { action: 'SEND_MAINTENANCE', maintenanceInvoiceId: 'm-1' },
        identity: { sub: 'sub', username: 'nope', claims: {} },
      }),
    ).rejects.toThrow('Unauthorized: could not resolve caller email')
  })

  it('allows SEND_MAINTENANCE with page-invoices', async () => {
    send.mockResolvedValue({})
    await expect(
      handler(event({ action: 'SEND_MAINTENANCE', maintenanceInvoiceId: 'm-1' }, identity({ groups: ['page-invoices'], email: 'staff@bcatcorp.com' }))),
    ).rejects.toThrow('Source maintenance invoice not found')
  })

  it('forbids SEND_MAINTENANCE without any required grant', async () => {
    await expect(
      handler(event({ action: 'SEND_MAINTENANCE', maintenanceInvoiceId: 'm-1' }, identity({ groups: ['page-loads'] }))),
    ).rejects.toThrow('Forbidden: SEND_MAINTENANCE requires owner, ADMIN, page-invoices, or page-vendorAp')
  })

  it('forbids COMPLETE with only page-invoices', async () => {
    await expect(
      handler(event({ action: 'COMPLETE', id: 'ap-1' }, identity({ groups: ['page-invoices'] }))),
    ).rejects.toThrow('Forbidden: COMPLETE requires owner, ADMIN, or page-vendorAp')
  })

  it('allows all actions for owner', async () => {
    send.mockResolvedValue({})
    await expect(
      handler(
        event(
          {
            action: 'COMPLETE',
            id: 'ap-1',
            input: { expectedUpdatedAt: 't1', paymentMethod: 'Check', paymentDate: '2026-05-16' },
          },
          identity({ email: OWNER_EMAIL, groups: [] }),
        ),
      ),
    ).rejects.toThrow('Vendor payable not found')
  })

  it('allows all actions for ADMIN group', async () => {
    send.mockResolvedValue({})
    await expect(
      handler(
        event(
          { action: 'REOPEN', id: 'ap-1', input: { expectedUpdatedAt: 't1' } },
          identity({ groups: ['ADMIN'] }),
        ),
      ),
    ).rejects.toThrow('Vendor payable not found')
  })
})

describe('parseInput', () => {
  it('returns empty object for null/undefined', () => {
    expect(parseInput(null)).toEqual({})
    expect(parseInput(undefined)).toEqual({})
  })

  it('parses valid JSON object string', () => {
    expect(parseInput('{"expectedUpdatedAt":"t1"}')).toEqual({ expectedUpdatedAt: 't1' })
  })

  it('rejects JSON null', () => {
    expect(() => parseInput('null')).toThrow('Invalid input: must be a JSON object')
  })

  it('rejects JSON array', () => {
    expect(() => parseInput('[1,2,3]')).toThrow('Invalid input: must be a JSON object')
  })

  it('rejects JSON scalar', () => {
    expect(() => parseInput('"hello"')).toThrow('Invalid input: must be a JSON object')
    expect(() => parseInput('42')).toThrow('Invalid input: must be a JSON object')
  })

  it('rejects invalid JSON', () => {
    expect(() => parseInput('{')).toThrow('Invalid input: not valid JSON')
  })
})

describe('SEND_MAINTENANCE', () => {
  const source = {
    id: 'm-1',
    status: 'POSTED',
    vendor: 'Kriete',
    invoiceNumber: 'X103105858',
    amount: 118276,
    date: '2026-05-15',
    description: 'Parts',
    paymentMethod: '',
    paymentDate: '',
  }

  it('creates a new VendorPayable row from maintenance invoice', async () => {
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: marshall(source) })

    const result = await handler(
      event({ action: 'SEND_MAINTENANCE', maintenanceInvoiceId: 'm-1' }),
    )

    expect(result.duplicate).toBeUndefined()
    expect(result.item.id).toBe('maintenance:m-1')
    expect(result.item.status).toBe('NEED_TO_PAY')
    expect(result.item.source).toBe('MAINTENANCE')
    expect(result.item.sourceInvoiceId).toBe('m-1')
    expect(result.item.vendor).toBe('Kriete')
    expect(result.item.invoiceNumber).toBe('X103105858')
    expect(result.item.amount).toBe(118276)
    expect(result.item.invoiceDate).toBe('2026-05-15')
    expect(result.item.subject).toBe('Kriete #X103105858')
    expect(result.item.attachments).toEqual([])
    expect(result.item.paymentMethod).toBeNull()
    expect(result.item).toHaveProperty('__typename', 'VendorPayable')

    const calls = send.mock.calls.map(asCommand)
    const put = calls.find(isPut)
    expect(put).toBeDefined()
    expect(put!.input.TableName).toBe('VendorPayable-test')
    expect(put!.input.ConditionExpression).toBe('attribute_not_exists(id)')
  })

  it('returns existing DONE row as duplicate even if source is now paid', async () => {
    const existing = marshall({
      id: 'maintenance:m-1',
      status: 'DONE',
      source: 'MAINTENANCE',
      sourceInvoiceId: 'm-1',
      subject: 'Kriete #X103105858',
      vendor: 'Kriete',
      invoiceNumber: 'X103105858',
      amount: 118276,
      invoiceDate: '2026-05-15',
      description: 'Parts',
      attachments: [],
      receivedAt: '2026-05-15T00:00:00.000Z',
      paymentMethod: 'Zelle',
      paymentDate: '2026-05-16',
      paidBy: 'admin@bcatcorp.com',
      paidAt: '2026-05-16T00:00:00.000Z',
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-15T00:00:00.000Z',
    })
    // Source is now paid and archived; existing DONE should still be returned.
    send
      .mockResolvedValueOnce({ Item: existing })
      .mockResolvedValueOnce({
        Item: marshall({ ...source, status: 'ARCHIVED', paymentMethod: 'Check', paymentDate: '2026-05-20' }),
      })

    const result = await handler(
      event({ action: 'SEND_MAINTENANCE', maintenanceInvoiceId: 'm-1' }),
    )

    expect(result.duplicate).toBe(true)
    expect(result.item.status).toBe('DONE')
    expect(result.item.paymentMethod).toBe('Zelle')
    expect(result.item.paymentDate).toBe('2026-05-16')
  })

  it('refuses to create from an archived source when no AP exists', async () => {
    send.mockResolvedValueOnce({})
    send.mockResolvedValueOnce({ Item: marshall({ ...source, status: 'ARCHIVED' }) })

    await expect(
      handler(event({ action: 'SEND_MAINTENANCE', maintenanceInvoiceId: 'm-1' })),
    ).rejects.toThrow('Cannot send archived maintenance invoice to AP')
  })

  it('refuses to create from an already-paid source when no AP exists', async () => {
    send.mockResolvedValueOnce({})
    send.mockResolvedValueOnce({
      Item: marshall({ ...source, paymentMethod: 'Check', paymentDate: '2026-05-16' }),
    })

    await expect(
      handler(event({ action: 'SEND_MAINTENANCE', maintenanceInvoiceId: 'm-1' })),
    ).rejects.toThrow('Cannot send already-paid maintenance invoice to AP')
  })

  it('refreshes NEED_TO_PAY snapshot without resetting status or payment fields', async () => {
    const existing = marshall({
      id: 'maintenance:m-1',
      status: 'NEED_TO_PAY',
      source: 'MAINTENANCE',
      sourceInvoiceId: 'm-1',
      subject: 'Old #OLD',
      vendor: 'Old',
      invoiceNumber: 'OLD',
      amount: 100,
      invoiceDate: '2026-01-01',
      description: 'Old',
      attachments: [],
      receivedAt: '2026-05-15T00:00:00.000Z',
      paymentMethod: null,
      paymentDate: null,
      paymentReference: null,
      paidBy: null,
      paidAt: null,
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-15T00:00:00.000Z',
    })
    const refreshed = marshall({
      id: 'maintenance:m-1',
      status: 'NEED_TO_PAY',
      source: 'MAINTENANCE',
      sourceInvoiceId: 'm-1',
      subject: 'Kriete #X103105858',
      vendor: 'Kriete',
      invoiceNumber: 'X103105858',
      amount: 118276,
      invoiceDate: '2026-05-15',
      description: 'Parts',
      attachments: [],
      receivedAt: '2026-05-15T00:00:00.000Z',
      paymentMethod: null,
      paymentDate: null,
      paymentReference: null,
      paidBy: null,
      paidAt: null,
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-15T12:00:00.000Z',
    })
    send
      .mockResolvedValueOnce({ Item: existing })
      .mockResolvedValueOnce({ Item: marshall(source) })
      .mockResolvedValueOnce({ Attributes: refreshed })

    const result = await handler(
      event({ action: 'SEND_MAINTENANCE', maintenanceInvoiceId: 'm-1' }),
    )

    expect(result.duplicate).toBe(true)
    expect(result.item.vendor).toBe('Kriete')
    expect(result.item.amount).toBe(118276)
    expect(result.item.status).toBe('NEED_TO_PAY')
    expect(result.item.paymentMethod).toBeNull()

    const update = send.mock.calls.map(asCommand).find(isUpdate)
    expect(update).toBeDefined()
    expect(update!.input.TableName).toBe('VendorPayable-test')
    expect(update!.input.ConditionExpression).toBe('attribute_exists(id)')
  })
})

describe('UPDATE_DETAILS', () => {
  it('rejects updating MAINTENANCE source details', async () => {
    send.mockResolvedValueOnce({
      Item: marshall({
        id: 'ap-1',
        status: 'NEED_TO_PAY',
        source: 'MAINTENANCE',
        sourceInvoiceId: 'm-1',
        updatedAt: '2026-05-15T00:00:00.000Z',
      }),
    })

    await expect(
      handler(
        event({
          action: 'UPDATE_DETAILS',
          id: 'ap-1',
          input: { expectedUpdatedAt: '2026-05-15T00:00:00.000Z', vendor: 'New' },
        }),
      ),
    ).rejects.toThrow('Maintenance source details cannot be edited from AP')
  })

  it('updates allowed EMAIL fields with expectedUpdatedAt CAS', async () => {
    send
      .mockResolvedValueOnce({
        Item: marshall({
          id: 'ap-1',
          status: 'NEED_TO_PAY',
          source: 'EMAIL',
          sourceMessageId: 'msg-1',
          subject: 'Invoice',
          vendor: 'Acme',
          invoiceNumber: '100',
          amount: 5000,
          invoiceDate: '2026-05-01',
          description: 'Service',
          attachments: [],
          receivedAt: '2026-05-01T00:00:00.000Z',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-15T00:00:00.000Z',
        }),
      })
      .mockResolvedValueOnce({
        Attributes: marshall({
          id: 'ap-1',
          status: 'NEED_TO_PAY',
          source: 'EMAIL',
          vendor: 'NewCo',
          invoiceNumber: '100',
          amount: 5500,
          invoiceDate: '2026-05-02',
          description: 'Service',
          attachments: [],
          updatedAt: '2026-05-15T12:00:00.000Z',
        }),
      })

    const result = await handler(
      event({
        action: 'UPDATE_DETAILS',
        id: 'ap-1',
        input: JSON.stringify({
          expectedUpdatedAt: '2026-05-15T00:00:00.000Z',
          vendor: 'NewCo',
          amount: 5500,
          invoiceDate: '2026-05-02',
        }),
      }),
    )

    expect(result.item.vendor).toBe('NewCo')
    expect(result.item.amount).toBe(5500)
    expect(result.item.invoiceDate).toBe('2026-05-02')

    const update = send.mock.calls.map(asCommand).find(isUpdate)
    expect(update!.input.ConditionExpression).toContain('#updatedAt = :expectedUpdatedAt')
  })

  it('rejects negative amount', async () => {
    send.mockResolvedValueOnce({
      Item: marshall({
        id: 'ap-1',
        status: 'NEED_TO_PAY',
        source: 'EMAIL',
        updatedAt: '2026-05-15T00:00:00.000Z',
      }),
    })

    await expect(
      handler(
        event({
          action: 'UPDATE_DETAILS',
          id: 'ap-1',
          input: { expectedUpdatedAt: '2026-05-15T00:00:00.000Z', amount: -100 },
        }),
      ),
    ).rejects.toThrow('Amount cannot be negative')
  })

  it('rejects non-integer amount', async () => {
    send.mockResolvedValueOnce({
      Item: marshall({
        id: 'ap-1',
        status: 'NEED_TO_PAY',
        source: 'EMAIL',
        updatedAt: '2026-05-15T00:00:00.000Z',
      }),
    })

    await expect(
      handler(
        event({
          action: 'UPDATE_DETAILS',
          id: 'ap-1',
          input: { expectedUpdatedAt: '2026-05-15T00:00:00.000Z', amount: 10.5 },
        }),
      ),
    ).rejects.toThrow('Amount must be an integer number of cents')
  })
})

describe('COMPLETE', () => {
  function existingAp(overrides?: Partial<Record<string, unknown>>) {
    return marshall({
      id: 'maintenance:m-1',
      status: 'NEED_TO_PAY',
      source: 'MAINTENANCE',
      sourceInvoiceId: 'm-1',
      subject: 'Kriete #X103105858',
      vendor: 'Kriete',
      invoiceNumber: 'X103105858',
      amount: 118276,
      invoiceDate: '2026-05-15',
      description: 'Parts',
      attachments: [],
      receivedAt: '2026-05-15T00:00:00.000Z',
      paymentMethod: null,
      paymentDate: null,
      paymentReference: null,
      paidBy: null,
      paidAt: null,
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-15T00:00:00.000Z',
      ...overrides,
    })
  }

  const source = {
    id: 'm-1',
    status: 'POSTED',
    vendor: 'Kriete',
    invoiceNumber: 'X103105858',
    amount: 118276,
    date: '2026-05-15',
    description: 'Parts',
    paymentMethod: '',
    paymentDate: '',
  }

  it('requires paymentDate', async () => {
    send.mockResolvedValueOnce({ Item: existingAp() })
    await expect(
      handler(
        event({
          action: 'COMPLETE',
          id: 'maintenance:m-1',
          input: { expectedUpdatedAt: '2026-05-15T00:00:00.000Z', paymentMethod: 'Check' },
        }),
      ),
    ).rejects.toThrow('Date must be YYYY-MM-DD')
  })

  it('requires non-empty trimmed paymentMethod', async () => {
    send.mockResolvedValueOnce({ Item: existingAp() })
    await expect(
      handler(
        event({
          action: 'COMPLETE',
          id: 'maintenance:m-1',
          input: {
            expectedUpdatedAt: '2026-05-15T00:00:00.000Z',
            paymentMethod: '   ',
            paymentDate: '2026-05-16',
          },
        }),
      ),
    ).rejects.toThrow('paymentMethod cannot be empty')
  })

  it('completes AP and linked maintenance invoice atomically', async () => {
    send
      .mockResolvedValueOnce({ Item: existingAp() })
      .mockResolvedValueOnce({ Item: marshall({ ...source, updatedAt: '2026-05-15T00:00:00Z' }) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: existingAp({
          status: 'DONE',
          paymentMethod: 'Check',
          paymentDate: '2026-05-16',
          paymentReference: 'Ref-123',
        }),
      })

    const result = await handler(
      event({
        action: 'COMPLETE',
        id: 'maintenance:m-1',
        input: {
          expectedUpdatedAt: '2026-05-15T00:00:00.000Z',
          paymentMethod: 'Check',
          paymentDate: '2026-05-16',
          paymentReference: 'Ref-123',
        },
      }),
    )

    expect(result.item.status).toBe('DONE')
    expect(result.item.paymentMethod).toBe('Check')
    expect(result.item.paymentDate).toBe('2026-05-16')
    expect(result.item.paymentReference).toBe('Ref-123')

    const transact = send.mock.calls.map(asCommand).find(isTransact)
    expect(transact).toBeDefined()
    expect(transact!.input.TransactItems).toHaveLength(2)
    const [apUpdate, sourceUpdate] = transact!.input.TransactItems!
    expect(apUpdate.Update!.TableName).toBe('VendorPayable-test')
    expect(sourceUpdate.Update!.TableName).toBe('MaintenanceInvoice-test')
    expect(sourceUpdate.Update!.UpdateExpression).toContain('#paymentMethod = :method')
    expect(sourceUpdate.Update!.UpdateExpression).toContain('#paymentDate = :date')
    expect(sourceUpdate.Update!.ConditionExpression).toContain('#updatedAt = :sourceUpdatedAt')
    expect(sourceUpdate.Update!.ExpressionAttributeValues).toMatchObject({
      ':sourceUpdatedAt': { S: '2026-05-15T00:00:00Z' },
      ':method': { S: 'Check' },
      ':date': { S: '2026-05-16' },
    })
  })

  it('refuses conflicting source already paid by someone else', async () => {
    send
      .mockResolvedValueOnce({ Item: existingAp() })
      .mockResolvedValueOnce({ Item: marshall({ ...source, paymentMethod: 'Zelle', paymentDate: '2026-05-16' }) })

    await expect(
      handler(
        event({
          action: 'COMPLETE',
          id: 'maintenance:m-1',
          input: {
            expectedUpdatedAt: '2026-05-15T00:00:00.000Z',
            paymentMethod: 'Check',
            paymentDate: '2026-05-17',
          },
        }),
      ),
    ).rejects.toThrow('Linked maintenance invoice is already paid')
  })

  it('allows correction on DONE AP with new payment values when source matches existing AP payment', async () => {
    send
      .mockResolvedValueOnce({
        Item: existingAp({
          status: 'DONE',
          paymentMethod: 'Check',
          paymentDate: '2026-05-16',
          paidBy: 'admin@bcatcorp.com',
          paidAt: '2026-05-16T00:00:00Z',
        }),
      })
      .mockResolvedValueOnce({ Item: marshall({ ...source, paymentMethod: 'Check', paymentDate: '2026-05-16' }) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: existingAp({
          status: 'DONE',
          paymentMethod: 'Wire',
          paymentDate: '2026-05-17',
          paidBy: 'admin@bcatcorp.com',
          paidAt: '2026-05-16T00:00:00Z',
        }),
      })

    const result = await handler(
      event({
        action: 'COMPLETE',
        id: 'maintenance:m-1',
        input: {
          expectedUpdatedAt: '2026-05-15T00:00:00.000Z',
          paymentMethod: 'Wire',
          paymentDate: '2026-05-17',
        },
      }),
    )

    expect(result.item.status).toBe('DONE')
    expect(result.item.paymentMethod).toBe('Wire')
    expect(result.item.paymentDate).toBe('2026-05-17')
  })

  it('refreshes a changed source snapshot into the AP row while completing', async () => {
    send
      .mockResolvedValueOnce({ Item: existingAp() })
      .mockResolvedValueOnce({ Item: marshall({ ...source, amount: 99999, vendor: 'Kriete Truck Center', updatedAt: '2026-05-15T00:00:00Z' }) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: existingAp({ status: 'DONE', amount: 99999, vendor: 'Kriete Truck Center', paymentMethod: 'Check', paymentDate: '2026-05-16' }) })

    const result = await handler(
      event({
        action: 'COMPLETE',
        id: 'maintenance:m-1',
        input: {
          expectedUpdatedAt: '2026-05-15T00:00:00.000Z',
          paymentMethod: 'Check',
          paymentDate: '2026-05-16',
        },
      }),
    )

    expect(result.item.status).toBe('DONE')
    const transact = send.mock.calls.map(asCommand).find(isTransact)
    const [apUpdate, sourceUpdate] = transact!.input.TransactItems!
    expect(apUpdate.Update!.UpdateExpression).toContain('#amount = :amount')
    expect(apUpdate.Update!.ExpressionAttributeValues![':amount']).toEqual({ N: '99999' })
    expect(apUpdate.Update!.ExpressionAttributeValues![':vendor']).toEqual({ S: 'Kriete Truck Center' })
    expect(sourceUpdate.Update!.ExpressionAttributeValues![':sourceUpdatedAt']).toEqual({ S: '2026-05-15T00:00:00Z' })
  })

  it('treats source with default paymentMethod but no paymentDate as unpaid', async () => {
    send
      .mockResolvedValueOnce({ Item: existingAp() })
      .mockResolvedValueOnce({
        Item: marshall({ ...source, paymentMethod: 'Check', paymentDate: '', updatedAt: '2026-05-15T00:00:00Z' }),
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: existingAp({ status: 'DONE', paymentMethod: 'Check', paymentDate: '2026-05-16' }),
      })

    const result = await handler(
      event({
        action: 'COMPLETE',
        id: 'maintenance:m-1',
        input: {
          expectedUpdatedAt: '2026-05-15T00:00:00.000Z',
          paymentMethod: 'Check',
          paymentDate: '2026-05-16',
        },
      }),
    )

    expect(result.item.status).toBe('DONE')
  })

  it('completes using legacy field-match when source lacks updatedAt', async () => {
    send
      .mockResolvedValueOnce({ Item: existingAp() })
      .mockResolvedValueOnce({ Item: marshall(source) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: existingAp({ status: 'DONE', paymentMethod: 'Check', paymentDate: '2026-05-16' }) })

    await handler(
      event({
        action: 'COMPLETE',
        id: 'maintenance:m-1',
        input: {
          expectedUpdatedAt: '2026-05-15T00:00:00.000Z',
          paymentMethod: 'Check',
          paymentDate: '2026-05-16',
        },
      }),
    )

    const transact = send.mock.calls.map(asCommand).find(isTransact)
    const sourceUpdate = transact!.input.TransactItems![1].Update!
    expect(sourceUpdate.ConditionExpression).toContain('attribute_not_exists(#paymentMethod)')
    expect(sourceUpdate.ConditionExpression).toContain('attribute_not_exists(#paymentDate)')
    expect(sourceUpdate.ExpressionAttributeValues).not.toHaveProperty(':sourceUpdatedAt')
  })

  it('translates transaction cancellation into conflict error', async () => {
    send
      .mockResolvedValueOnce({ Item: existingAp() })
      .mockResolvedValueOnce({ Item: marshall(source) })
      .mockRejectedValueOnce({ name: 'TransactionCanceledException' })

    await expect(
      handler(
        event({
          action: 'COMPLETE',
          id: 'maintenance:m-1',
          input: {
            expectedUpdatedAt: '2026-05-15T00:00:00.000Z',
            paymentMethod: 'Check',
            paymentDate: '2026-05-16',
          },
        }),
      ),
    ).rejects.toThrow('Conflict: the linked maintenance invoice was paid or edited by someone else')
  })
})

describe('REOPEN', () => {
  function existingDoneAp(overrides?: Partial<Record<string, unknown>>) {
    return marshall({
      id: 'maintenance:m-1',
      status: 'DONE',
      source: 'MAINTENANCE',
      sourceInvoiceId: 'm-1',
      subject: 'Kriete #X103105858',
      vendor: 'Kriete',
      invoiceNumber: 'X103105858',
      amount: 118276,
      invoiceDate: '2026-05-15',
      description: 'Parts',
      attachments: [],
      receivedAt: '2026-05-15T00:00:00.000Z',
      paymentMethod: 'Check',
      paymentDate: '2026-05-16',
      paymentReference: 'Ref-1',
      paidBy: 'admin@bcatcorp.com',
      paidAt: '2026-05-16T00:00:00.000Z',
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-16T00:00:00.000Z',
      ...overrides,
    })
  }

  const sourcePaid = {
    id: 'm-1',
    status: 'POSTED',
    vendor: 'Kriete',
    invoiceNumber: 'X103105858',
    amount: 118276,
    date: '2026-05-15',
    description: 'Parts',
    paymentMethod: 'Check',
    paymentDate: '2026-05-16',
  }

  it('reopens completed AP and clears linked source payment', async () => {
    send
      .mockResolvedValueOnce({ Item: existingDoneAp() })
      .mockResolvedValueOnce({ Item: marshall(sourcePaid) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: existingDoneAp({
          status: 'NEED_TO_PAY',
          paymentMethod: null,
          paymentDate: null,
          paymentReference: null,
          paidBy: null,
          paidAt: null,
          updatedAt: '2026-05-17T00:00:00.000Z',
        }),
      })

    const result = await handler(
      event({
        action: 'REOPEN',
        id: 'maintenance:m-1',
        input: { expectedUpdatedAt: '2026-05-16T00:00:00.000Z' },
      }),
    )

    expect(result.item.status).toBe('NEED_TO_PAY')
    expect(result.item.paymentMethod).toBeNull()
    expect(result.item.paymentDate).toBeNull()

    const transact = send.mock.calls.map(asCommand).find(isTransact)
    expect(transact!.input.TransactItems).toHaveLength(2)
    const sourceUpdate = transact!.input.TransactItems![1].Update!
    expect(sourceUpdate.UpdateExpression).toContain('REMOVE #paymentMethod, #paymentDate')
  })

  it('prevents reopen when source payment changed externally', async () => {
    send
      .mockResolvedValueOnce({ Item: existingDoneAp() })
      .mockResolvedValueOnce({ Item: marshall({ ...sourcePaid, paymentMethod: 'Zelle' }) })

    await expect(
      handler(
        event({
          action: 'REOPEN',
          id: 'maintenance:m-1',
          input: { expectedUpdatedAt: '2026-05-16T00:00:00.000Z' },
        }),
      ),
    ).rejects.toThrow('linked maintenance invoice payment has changed externally')
  })

  it('rejects reopening non-DONE AP', async () => {
    send.mockResolvedValueOnce({
      Item: marshall({
        id: 'maintenance:m-1',
        status: 'NEED_TO_PAY',
        source: 'MAINTENANCE',
        sourceInvoiceId: 'm-1',
        updatedAt: '2026-05-15T00:00:00.000Z',
      }),
    })

    await expect(
      handler(
        event({
          action: 'REOPEN',
          id: 'maintenance:m-1',
          input: { expectedUpdatedAt: '2026-05-15T00:00:00.000Z' },
        }),
      ),
    ).rejects.toThrow('vendor payable is not completed')
  })
})
