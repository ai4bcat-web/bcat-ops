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

describe('fileSentInvoiceDocument', () => {
  beforeEach(() => { send.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}) })
  const sent = { id: 'i1', shipmentId: 's1', orderId: 'o1', number: 'INV-000001', pdfKey: 'invoices/c1/INV-000001-v1.pdf', pdfSizeBytes: 10, status: 'ISSUED' }
  const filed = () => JSON.parse(Buffer.from(send.mock.calls[0][0].input.Payload).toString('utf8')).arguments

  it('lists the invoice that went out on its shipment, pointing at the file that was sent', async () => {
    send.mockResolvedValue({ StatusCode: 200 })
    const { fileSentInvoiceDocument } = await load('shipment-actions-fn')
    expect(await fileSentInvoiceDocument(sent)).toBe(true)
    expect(filed().action).toBe('ATTACH_INVOICE_DOC')
    expect(JSON.parse(filed().input)).toMatchObject({ shipmentId: 's1', invoiceId: 'i1', orderId: 'o1', number: 'INV-000001', s3Key: 'invoices/c1/INV-000001-v1.pdf', sizeBytes: 10 })
  })

  it('does nothing for an invoice with no PDF, no shipment or one that is void', async () => {
    const { fileSentInvoiceDocument } = await load('shipment-actions-fn')
    expect(await fileSentInvoiceDocument({ ...sent, pdfKey: null })).toBe(false)
    expect(await fileSentInvoiceDocument({ ...sent, shipmentId: null })).toBe(false)
    expect(await fileSentInvoiceDocument({ ...sent, status: 'VOID' })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('never throws when the filing fails: the invoice has already gone out', async () => {
    send.mockRejectedValue(new Error('throttled'))
    const { fileSentInvoiceDocument } = await load('shipment-actions-fn')
    expect(await fileSentInvoiceDocument(sent)).toBe(false)
  })
})
