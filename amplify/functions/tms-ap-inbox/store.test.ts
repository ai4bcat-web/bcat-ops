import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDynamoStore } from './store'

interface Sent {
  name: string
  input: Record<string, unknown>
}

const sent: Sent[] = []
let respond: (cmd: Sent) => unknown = () => ({})

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }))
vi.mock('@aws-sdk/lib-dynamodb', () => {
  const cmd = (name: string) =>
    class {
      readonly name = name
      constructor(readonly input: Record<string, unknown>) {}
    }
  return {
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (c: Sent) => {
          sent.push(c)
          return respond(c)
        },
      }),
    },
    GetCommand: cmd('Get'),
    PutCommand: cmd('Put'),
    QueryCommand: cmd('Query'),
    ScanCommand: cmd('Scan'),
    UpdateCommand: cmd('Update'),
    BatchGetCommand: cmd('BatchGet'),
  }
})

/** DynamoDB rejects any `#name` / `:value` that is declared but unused, or used but undeclared. */
function expressionProblems(input: Record<string, unknown>): string[] {
  const text = ['UpdateExpression', 'ConditionExpression', 'KeyConditionExpression', 'FilterExpression']
    .map((k) => String(input[k] ?? ''))
    .join(' ')
  const names = Object.keys((input.ExpressionAttributeNames ?? {}) as object)
  const values = Object.keys((input.ExpressionAttributeValues ?? {}) as object)
  const usedNames = new Set(text.match(/#\w+/g) ?? [])
  const usedValues = new Set(text.match(/:\w+/g) ?? [])
  return [
    ...names.filter((n) => !usedNames.has(n)).map((n) => `unused name ${n}`),
    ...[...usedNames].filter((n) => !names.includes(n)).map((n) => `undeclared name ${n}`),
    ...values.filter((v) => !usedValues.has(v)).map((v) => `unused value ${v}`),
    ...[...usedValues].filter((v) => !values.includes(v)).map((v) => `undeclared value ${v}`),
  ]
}

const lastInput = (): Record<string, unknown> => sent[sent.length - 1].input
const namesOf = (input: Record<string, unknown>): string[] => Object.values((input.ExpressionAttributeNames ?? {}) as Record<string, string>)

beforeEach(() => {
  sent.length = 0
  respond = () => ({})
  Object.assign(process.env, {
    TMS_SETTINGS_TABLE_NAME: 'Settings', CARRIER_BILL_TABLE_NAME: 'Bills', VENDOR_PAYABLE_TABLE_NAME: 'Vendors',
    AP_INBOX_ITEM_TABLE_NAME: 'Items', LOAD_CARRIER_TABLE_NAME: 'LC', LOAD_TABLE_NAME: 'Loads', SHIPMENT_TABLE_NAME: 'Ships', CARRIER_TABLE_NAME: 'Carriers',
  })
})

describe('createDynamoStore: every write is a valid, narrow DynamoDB expression', () => {
  it('writes only the allow-listed bill columns plus provenance, under the CAS + paid/credited guard', async () => {
    const store = createDynamoStore()
    const out = await store.updateCarrierBill(
      'B1',
      { billNumber: 'SH-1', billDate: '2026-11-03', billMonth: '2026-11', dueAt: '2026-12-03', billedCents: 150_050, varianceCents: 50, status: 'PAID', balanceCents: 0, remitTo: 'x', approvedAt: 'x' } as never,
      { expectedVersion: 3, expectedStatus: 'IN_REVIEW', audit: { itemId: 'apin:m1', sourceUrl: 'https://mail.example/m1', at: '2026-11-04T00:00:00Z' } },
    )
    expect(out).toEqual({ version: 4 })
    const input = lastInput()
    expect(expressionProblems(input)).toEqual([])
    expect(namesOf(input).sort()).toEqual(
      ['apInboxAppliedAt', 'apInboxItemId', 'apInboxSourceUrl', 'billDate', 'billMonth', 'billNumber', 'billedCents', 'dueAt', 'status', 'updatedAt', 'updatedBy', 'varianceCents', 'version'].sort(),
    )
    // `status` appears only in the guard, never in the SET list.
    expect(String(input.UpdateExpression)).not.toContain(Object.entries(input.ExpressionAttributeNames as Record<string, string>).find(([, v]) => v === 'status')![0])
    expect(String(input.ConditionExpression)).toContain('paidCents = :zero AND creditedCents = :zero')
  })

  it('reports a failed condition as null, not an error', async () => {
    respond = () => {
      throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' })
    }
    const out = await createDynamoStore().updateCarrierBill('B1', { billNumber: 'x' }, { expectedVersion: 3, expectedStatus: 'IN_REVIEW', audit: { itemId: 'i', sourceUrl: 'u', at: 'a' } })
    expect(out).toBeNull()
  })

  it('revert restores the columns, blanks the number and clears provenance, guarded by version only', async () => {
    await createDynamoStore().revertCarrierBill('B1', { billNumber: '', billDate: '2026-11-01', billMonth: '2026-11', dueAt: '2026-12-01', billedCents: 150_000, varianceCents: 0 }, { expectedVersion: 4 })
    const input = lastInput()
    expect(expressionProblems(input)).toEqual([])
    expect(String(input.UpdateExpression)).toMatch(/REMOVE .*#r_apInboxItemId/)
    const nameOf = (real: string) => Object.entries(input.ExpressionAttributeNames as Record<string, string>).find(([, v]) => v === real)![0]
    expect(String(input.UpdateExpression)).toMatch(new RegExp(`REMOVE .*${nameOf('billNumber')}`))
    expect(String(input.ConditionExpression)).not.toContain('paidCents')
  })

  it('vendor updates take only the blank-fill columns and require NEED_TO_PAY', async () => {
    await createDynamoStore().updateVendorPayable('vp-1', { invoiceDate: '2026-11-02', dueDate: '2026-12-02', status: 'DONE', paidAt: 'x' } as never, { itemId: 'i', sourceUrl: 'u', at: 'a' })
    const input = lastInput()
    expect(expressionProblems(input)).toEqual([])
    expect(namesOf(input).sort()).toEqual(['apInboxAppliedAt', 'apInboxItemId', 'apInboxSourceUrl', 'dueDate', 'invoiceDate', 'status'].sort())
    expect(Object.values(input.ExpressionAttributeValues as object)).toContain('NEED_TO_PAY')
  })

  it('config CAS, state patches, the run lock and item updates are well-formed', async () => {
    const store = createDynamoStore()
    const cfg = await store.getConfig()
    await store.putConfig(cfg, 1)
    expect(expressionProblems(lastInput())).toEqual([])

    await store.patchState({ cursor: { afterMs: 5, boundaryIds: ['a'] }, retry: [], gapNote: undefined, runs: [] })
    const patch = lastInput()
    expect(expressionProblems(patch)).toEqual([])
    expect(String(patch.UpdateExpression)).toMatch(/^SET apInboxState\.#s\d+ = :s\d+/)
    expect(String(patch.UpdateExpression)).toContain('REMOVE apInboxState.')

    sent.length = 0
    await store.claimRun(new Date('2026-11-04T10:00:00Z'), new Date('2026-11-04T09:54:00Z'))
    expect(sent.map((s) => expressionProblems(s.input))).toEqual([[], []])
    await store.releaseRun()
    expect(expressionProblems(lastInput())).toEqual([])

    respond = () => ({ Attributes: { id: 'apin:m1', status: 'APPLIED', version: 2, extraction: '{"kind":"INVOICE"}' } })
    const item = await store.updateItem('apin:m1', { status: 'APPLIED', reviewReason: null, ttlEpoch: 5 }, { expectedVersion: 1, statusIn: ['NEEDS_REVIEW'] })
    expect(expressionProblems(lastInput())).toEqual([])
    expect(item?.extraction).toEqual({ kind: 'INVOICE' })
  })

  it('lists a status newest-first through the status index and puts items conditionally', async () => {
    const store = createDynamoStore()
    respond = () => ({ Items: [{ id: 'a', extraction: {} }] })
    await store.listByStatus('NEEDS_REVIEW', { sinceIso: '2026-10-01T00:00:00Z', limit: 5 })
    expect(lastInput()).toMatchObject({ IndexName: 'apInboxItemsByStatusAndReceivedAt', ScanIndexForward: false })
    expect(expressionProblems(lastInput())).toEqual([])
    respond = () => ({})
    await store.putItemIfAbsent({ id: 'apin:m1', messageId: 'm1', receivedAt: '2026-11-04T00:00:00Z', kind: 'INVOICE', status: 'NEEDS_REVIEW', extraction: {} as never, mailbox: null, version: 1 })
    expect(lastInput().ConditionExpression).toBe('attribute_not_exists(id)')
    expect((lastInput().Item as Record<string, unknown>).mailbox).toBeUndefined()
  })

  it('builds the ledger from the apOpen indexes and a vendor scan, only awaiting assignments', async () => {
    respond = (c) => {
      if (c.name === 'Query' && c.input.TableName === 'Bills') return { Items: [{ id: 'B1', status: 'IN_REVIEW', loadId: 'l1', carrierId: 'c1', version: 1, billedCents: 1, grossCents: 1 }, { id: 'B0', status: 'PAID', loadId: 'l1' }] }
      if (c.name === 'Query') return { Items: [{ id: 'lc1', apStatus: 'AWAITING_INVOICE', loadId: 'l1', shipmentId: 's1', carrierId: 'c1' }, { id: 'lc2', apStatus: 'IN_REVIEW', loadId: 'l1', shipmentId: 's1' }] }
      if (c.name === 'Scan') return { Items: [{ id: 'vp1', status: 'NEED_TO_PAY', vendor: 'Acme' }] }
      if (c.name === 'BatchGet') {
        const table = Object.keys(c.input.RequestItems as object)[0]
        const rows: Record<string, unknown[]> = { Loads: [{ id: 'l1', aljexId: 'A123' }], Ships: [{ id: 's1', number: 'S1-1' }], Carriers: [{ id: 'c1', name: 'Swift', mcNumber: '9' }] }
        return { Responses: { [table]: rows[table] } }
      }
      return {}
    }
    const ledger = await createDynamoStore().loadLedger()
    expect(ledger.bills.map((b) => b.id)).toEqual(['B1'])
    expect(ledger.bills[0].aljexId).toBe('A123')
    expect(ledger.assignments).toEqual([expect.objectContaining({ loadCarrierId: 'lc1', shipmentNumber: 'S1-1' })])
    expect(ledger.vendorPayables.map((v) => v.id)).toEqual(['vp1'])
    expect(ledger.carriers.c1.mcNumber).toBe('9')
    const indexes = sent.filter((s) => s.name === 'Query').map((s) => s.input.IndexName).sort()
    expect(indexes).toEqual(['carrierBillsByApOpenAndDueAt', 'loadCarriersByApOpenAndApStatusChangedAt'])
  })
})
