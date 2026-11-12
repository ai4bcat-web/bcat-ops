import { beforeEach, describe, expect, it, vi } from 'vitest'

const { send } = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = send },
  InvokeCommand: class { constructor(public input: Record<string, unknown>) {} },
}))

const INPUT = { shipmentId: 's1', invoiceId: 'i1', orderId: 'o1', number: 'INV-000001', s3Key: 'invoices/c1/INV-000001-v1.pdf', sizeBytes: 10 }

async function load(functionName: string) {
  vi.resetModules()
  vi.stubEnv('SHIPMENT_ACTIONS_FUNCTION_NAME', functionName)
  return import('./store')
}

describe('fileInvoiceDocument', () => {
  beforeEach(() => { send.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}) })

  it('waits for ATTACH_INVOICE_DOC and reports that it landed', async () => {
    send.mockResolvedValue({ StatusCode: 200 })
    const { fileInvoiceDocument } = await load('shipment-actions-fn')
    expect(await fileInvoiceDocument(INPUT)).toBe(true)
    const sent = send.mock.calls[0][0].input
    expect(sent.InvocationType).toBe('RequestResponse')
    expect(sent.FunctionName).toBe('shipment-actions-fn')
    const payload = JSON.parse(Buffer.from(sent.Payload).toString('utf8'))
    expect(payload.systemCaller).toBe('finance-actions')
    expect(payload.arguments.action).toBe('ATTACH_INVOICE_DOC')
  })

  it('reports false — and does not throw — when the handler errors', async () => {
    send.mockResolvedValue({ StatusCode: 200, FunctionError: 'Unhandled', Payload: Buffer.from('{"errorMessage":"boom"}') })
    const { fileInvoiceDocument } = await load('shipment-actions-fn')
    expect(await fileInvoiceDocument(INPUT)).toBe(false)
  })

  it('reports false when the invoke itself fails', async () => {
    send.mockRejectedValue(new Error('throttled'))
    const { fileInvoiceDocument } = await load('shipment-actions-fn')
    expect(await fileInvoiceDocument(INPUT)).toBe(false)
  })

  it('reports false when no shipment Lambda is configured', async () => {
    const { fileInvoiceDocument } = await load('')
    expect(await fileInvoiceDocument(INPUT)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
