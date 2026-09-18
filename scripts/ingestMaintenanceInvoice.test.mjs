import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  processInvoices,
  listAllInvoices,
  resolveEquipmentId,
  parseEmailBody,
  deriveInvoiceId,
} from './ingestMaintenanceInvoice.mjs'
import { invoiceExternalId } from './invoiceDedup.mjs'

const scriptPath = fileURLToPath(new URL('./ingestMaintenanceInvoice.mjs', import.meta.url))

const sampleInvoice = {
  date: '2026-09-10',
  vendor: "Brother's Truck Repair",
  amount: 128450,
  invoiceNumber: 'INV-1042',
  unitNumber: '530',
  description: 'Trailer 53103 repair',
}

function makeTransport(handlers) {
  return async (query, variables, idToken) => {
    if (query.includes('ListMaintenanceInvoices')) return handlers.list?.(query, variables, idToken)
    if (query.includes('GetMaintenanceInvoice')) return handlers.get?.(query, variables, idToken)
    if (query.includes('CreateMaintenanceInvoice')) return handlers.create?.(query, variables, idToken)
    throw new Error(`Unexpected query: ${query.slice(0, 40)}`)
  }
}

function emptyListResponse() {
  return { data: { listMaintenanceInvoices: { items: [], nextToken: null } } }
}

describe('listAllInvoices', () => {
  it('follows every nextToken through empty pages', async () => {
    const pages = [
      { items: [{ id: 'a', date: '2026-01-01', vendor: 'V', amount: 100, invoiceNumber: '1', status: 'PENDING', externalId: 'ea', source: 'EMAIL' }], nextToken: 'page2' },
      { items: [], nextToken: 'page3' },
      { items: [{ id: 'b', date: '2026-01-02', vendor: 'W', amount: 200, invoiceNumber: '2', status: 'PENDING', externalId: 'eb', source: 'EMAIL' }], nextToken: null },
    ]
    const calls = []
    const callAppSync = async (query, variables) => {
      calls.push({ query, variables })
      const idx = variables.nextToken === 'page2' ? 1 : variables.nextToken === 'page3' ? 2 : 0
      return { data: { listMaintenanceInvoices: pages[idx] } }
    }

    const items = await listAllInvoices(callAppSync, 'token', 5000)

    expect(items).toHaveLength(2)
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.variables.nextToken)).toEqual([null, 'page2', 'page3'])
  })
})

describe('processInvoices', () => {
  it('creates new EMAIL records with PENDING status and deterministic id', async () => {
    let created
    const ext = invoiceExternalId(sampleInvoice)
    const callAppSync = makeTransport({
      list: () => emptyListResponse(),
      create: (_q, variables) => {
        created = variables
        return { data: { createMaintenanceInvoice: { id: variables.input.id, externalId: variables.input.externalId } } }
      },
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 1, duplicates: 0, failed: 0 })
    expect(created.input.id).toBe(deriveInvoiceId(ext))
    expect(created.input.externalId).toBe(ext)
    expect(created.input.status).toBe('PENDING')
    expect(created.input.source).toBe('EMAIL')
    expect(created.input.equipmentId).toBe('eq-mnevuhxgs5jf')
  })

  it('treats matching ConditionalCheckFailedException as a duplicate', async () => {
    const ext = invoiceExternalId(sampleInvoice)
    const id = deriveInvoiceId(ext)
    const callAppSync = makeTransport({
      list: () => emptyListResponse(),
      create: () => ({
        errors: [{ message: 'Conditional check failed', errorType: 'ConditionalCheckFailedException' }],
      }),
      get: (_q, variables) => {
        expect(variables.id).toBe(id)
        return { data: { getMaintenanceInvoice: { id, externalId: ext } } }
      },
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 0, duplicates: 1, failed: 0 })
  })

  it('treats DynamoDB:ConditionalCheckFailedException as duplicate', async () => {
    const ext = invoiceExternalId(sampleInvoice)
    const id = deriveInvoiceId(ext)
    const callAppSync = makeTransport({
      list: () => emptyListResponse(),
      create: () => ({
        errors: [{ message: 'Conditional check failed', errorType: 'DynamoDB:ConditionalCheckFailedException' }],
      }),
      get: (_q, variables) => {
        expect(variables.id).toBe(id)
        return { data: { getMaintenanceInvoice: { id, externalId: ext } } }
      },
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 0, duplicates: 1, failed: 0 })
  })

  it('dedups archived or edited invoices by document identity', async () => {
    const ext = invoiceExternalId(sampleInvoice)
    const archived = {
      id: 'ui-generated-id',
      date: sampleInvoice.date,
      vendor: 'BROTHERS TRUCK REPAIR',
      amount: sampleInvoice.amount,
      invoiceNumber: 'inv 1042',
      equipmentId: 'eq-changed',
      status: 'ARCHIVED',
      externalId: ext,
      source: 'EMAIL',
    }
    const callAppSync = makeTransport({
      list: () => ({ data: { listMaintenanceInvoices: { items: [archived], nextToken: null } } }),
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 0, duplicates: 1, failed: 0 })
  })

  it('still dedups legacy rows without externalId by content key', async () => {
    const legacy = {
      id: 'legacy-id',
      date: sampleInvoice.date,
      vendor: sampleInvoice.vendor,
      amount: sampleInvoice.amount,
      invoiceNumber: sampleInvoice.invoiceNumber,
      equipmentId: 'eq-changed',
      source: 'MANUAL',
      status: 'POSTED',
    }
    const callAppSync = makeTransport({
      list: () => ({ data: { listMaintenanceInvoices: { items: [legacy], nextToken: null } } }),
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 0, duplicates: 1, failed: 0 })
  })

  it('fails when list returns malformed connection', async () => {
    const callAppSync = makeTransport({
      list: () => ({ data: { listMaintenanceInvoices: null } }),
    })

    await expect(processInvoices([sampleInvoice], { idToken: 't', callAppSync })).rejects.toThrow('malformed response')
  })

  it('fails when create returns mismatched id', async () => {
    const ext = invoiceExternalId(sampleInvoice)
    const callAppSync = makeTransport({
      list: () => emptyListResponse(),
      create: (_q, variables) => ({
        data: { createMaintenanceInvoice: { id: 'wrong-id', externalId: variables.input.externalId } },
      }),
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 0, duplicates: 0, failed: 1 })
  })

  it('fails when create returns mismatched externalId', async () => {
    const ext = invoiceExternalId(sampleInvoice)
    const id = deriveInvoiceId(ext)
    const callAppSync = makeTransport({
      list: () => emptyListResponse(),
      create: () => ({
        data: { createMaintenanceInvoice: { id, externalId: 'wrong' } },
      }),
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 0, duplicates: 0, failed: 1 })
  })

  it('skips null records in list items', async () => {
    const listData = { data: { listMaintenanceInvoices: { items: [null, undefined, { id: 'a', date: '2026-01-01', vendor: 'V', amount: 100, invoiceNumber: '1', status: 'PENDING', externalId: 'ea', source: 'EMAIL' }], nextToken: null } } }
    const callAppSync = makeTransport({
      list: () => listData,
      create: (_q, variables) => ({
        data: { createMaintenanceInvoice: { id: variables.input.id, externalId: variables.input.externalId } },
      }),
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 1, duplicates: 0, failed: 0 })
  })

  it('fails ambiguous unnumbered source-identified matches for manual review', async () => {
    const unnumbered = { ...sampleInvoice, invoiceNumber: undefined, sourceDocumentId: 'att:abc123:0' }
    const legacy = { ...unnumbered, sourceDocumentId: undefined }
    const callAppSync = makeTransport({
      list: () => ({
        data: {
          listMaintenanceInvoices: {
            items: [{ ...legacy, externalId: invoiceExternalId(legacy) }],
            nextToken: null,
          },
        },
      }),
    })

    const result = await processInvoices([unnumbered], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 0, duplicates: 0, failed: 1 })
  })

  it('continues processing partial failures and reports nonzero failures', async () => {
    const inv2 = { ...sampleInvoice, invoiceNumber: 'INV-2222', unitNumber: '685' }
    const callAppSync = makeTransport({
      list: () => emptyListResponse(),
      create: (_q, variables) => {
        if (variables.input.invoiceNumber === sampleInvoice.invoiceNumber) {
          return { errors: [{ message: 'ServiceUnavailable', errorType: 'ServiceUnavailable' }] }
        }
        return { data: { createMaintenanceInvoice: { id: variables.input.id, externalId: variables.input.externalId } } }
      },
    })

    const result = await processInvoices([sampleInvoice, inv2], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 1, duplicates: 0, failed: 1 })
  })

  it('does not swallow unrelated errors', async () => {
    const callAppSync = makeTransport({
      list: () => emptyListResponse(),
      create: () => ({ errors: [{ message: 'Unauthorized to create invoice', errorType: 'Unauthorized' }] }),
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 0, duplicates: 0, failed: 1 })
  })

  it('fails when conditional conflict id carries a different externalId', async () => {
    const id = deriveInvoiceId(invoiceExternalId(sampleInvoice))
    const callAppSync = makeTransport({
      list: () => emptyListResponse(),
      create: () => ({
        errors: [{ message: 'ConditionalCheckFailedException', errorType: 'ConditionalCheckFailedException' }],
      }),
      get: () => ({ data: { getMaintenanceInvoice: { id, externalId: 'someone-else' } } }),
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result).toEqual({ inserted: 0, duplicates: 0, failed: 1 })
  })

  it('fails when get-by-id after a conditional conflict errors', async () => {
    const callAppSync = makeTransport({
      list: () => emptyListResponse(),
      create: () => ({
        errors: [{ message: 'ConditionalCheckFailedException', errorType: 'ConditionalCheckFailedException' }],
      }),
      get: () => ({ errors: [{ message: 'Unauthorized', errorType: 'Unauthorized' }] }),
    })

    const result = await processInvoices([sampleInvoice], { idToken: 't', callAppSync })

    expect(result.failed).toBe(1)
  })
})

describe('CLI dry-run', () => {
  it('resolves equipment without network calls', () => {
    const stdout = execFileSync('node', [scriptPath, '--dry-run', '--json', JSON.stringify([sampleInvoice])], { encoding: 'utf8' })
    const previews = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))

    expect(previews).toHaveLength(1)
    expect(previews[0].resolvedEquipmentId).toBe('eq-mnevuhxgs5jf')
    expect(previews[0].amount).toBe(sampleInvoice.amount)
  })
})

describe('parseEmailBody legacy behavior', () => {
  it('extracts a basic invoice from text', () => {
    const text = `
      Invoice Date: 2026-08-15
      Vendor: Quick Truck Repair
      Unit: 530
      Description: brake job on trailer 53103
      Total: $1,234.56
      Payment method: check
    `
    const parsed = parseEmailBody(text)
    expect(parsed.date).toBe('2026-08-15')
    expect(parsed.vendor).toBe('Quick Truck Repair')
    expect(parsed.amount).toBe(123456)
    expect(parsed.equipmentId).toBe('eq-mnevuhxgs5jf')
  })
})
