import { describe, expect, it, vi } from 'vitest'
import { runBatchFactor, type BatchFactorDeps, type BatchFactorRow } from './batchFactor'

const row = (over: Partial<BatchFactorRow> & { key: string }): BatchFactorRow => ({
  orderId: `ord-${over.key}`, label: over.key, invoiceId: null, factoringItemId: null, ...over,
})

function deps(over: Partial<BatchFactorDeps> = {}): BatchFactorDeps {
  return {
    generate: vi.fn(async (ids: string[]) => ({ results: ids.map((orderId) => ({ orderId, invoiceId: `inv-${orderId}` })) })),
    sendToFactor: vi.fn(async (invoiceId: string) => ({ factoringItem: { id: `item-${invoiceId}` } })),
    submit: vi.fn(async () => ({ invoiceId: 900, documentErrors: [] })),
    uploadDocs: vi.fn(async () => ({ invoiceId: 900, documentErrors: [] })),
    pause: vi.fn(async () => {}),
    ...over,
  }
}

describe('runBatchFactor', () => {
  it('generates once, queues and submits each load in order, pausing between loads', async () => {
    const d = deps()
    const out = await runBatchFactor([row({ key: 'a' }), row({ key: 'b' })], d)
    expect(d.generate).toHaveBeenCalledTimes(1)
    expect(d.generate).toHaveBeenCalledWith(['ord-a', 'ord-b'])
    expect(d.sendToFactor).toHaveBeenNthCalledWith(1, 'inv-ord-a')
    expect(d.submit).toHaveBeenNthCalledWith(2, 'item-inv-ord-b')
    expect(d.pause).toHaveBeenCalledTimes(1)
    expect(out.map((o) => o.ok)).toEqual([true, true])
  })

  it('reports a partial failure per load and keeps going', async () => {
    const d = deps({
      generate: vi.fn(async () => ({ results: [
        { orderId: 'ord-a', invoiceId: 'inv-a' },
        { orderId: 'ord-b', error: 'gate', releaseGate: { ok: false, missing: [{ message: 'POD is missing' }] } },
        { orderId: 'ord-c', invoiceId: 'inv-c' },
      ] })),
      submit: vi.fn(async (id: string) => {
        if (id === 'item-inv-a') throw new Error('OTR has no broker with MC 1')
        return { invoiceId: 901, documentErrors: [] }
      }),
    })
    const out = await runBatchFactor([row({ key: 'a' }), row({ key: 'b' }), row({ key: 'c' })], d)
    expect(out[0]).toMatchObject({ ok: false, step: 'submit', message: 'OTR has no broker with MC 1' })
    expect(out[1]).toMatchObject({ ok: false, step: 'generate', message: 'POD is missing' })
    expect(out[2]).toMatchObject({ ok: true, step: 'submitted' })
    expect(d.sendToFactor).not.toHaveBeenCalledWith(undefined)
  })

  it('never submits a load that is already with OTR', async () => {
    const d = deps()
    const out = await runBatchFactor([row({ key: 'a', factoringItemId: 'x', queueStatus: 'PENDING_WITH_OTR', otrInvoiceId: '5' })], d)
    expect(out[0]).toMatchObject({ ok: false, skipped: true })
    expect(d.submit).not.toHaveBeenCalled()
    expect(d.uploadDocs).not.toHaveBeenCalled()
    expect(d.generate).not.toHaveBeenCalled()
  })

  it('retry: an invoice and queue row from the first attempt are reused, and a row already at OTR only resends documents', async () => {
    const d = deps()
    const out = await runBatchFactor([
      row({ key: 'a', invoiceId: 'inv-a' }),
      row({ key: 'b', invoiceId: 'inv-b', factoringItemId: 'item-b', queueStatus: 'NEED_TO_FACTOR' }),
      row({ key: 'c', invoiceId: 'inv-c', factoringItemId: 'item-c', queueStatus: 'NEED_TO_FACTOR', otrInvoiceId: '77' }),
    ], d)
    expect(d.generate).not.toHaveBeenCalled()
    expect(d.sendToFactor).toHaveBeenCalledTimes(1)
    expect(d.submit).toHaveBeenCalledWith('item-b')
    expect(d.submit).not.toHaveBeenCalledWith('item-c')
    expect(d.uploadDocs).toHaveBeenCalledWith('item-c')
    expect(out.every((o) => o.ok)).toBe(true)
  })

  it('documents that did not reach OTR leave the load failed, with the reason', async () => {
    const d = deps({ submit: vi.fn(async () => ({ invoiceId: 902, documentErrors: ['POD rejected (413)'] })) })
    const [o] = await runBatchFactor([row({ key: 'a' })], d)
    expect(o).toMatchObject({ ok: false, step: 'documents' })
    expect(o.message).toContain('POD rejected (413)')
  })

  it('a generate call that throws fails every load that needed it, and the queue step is never reached', async () => {
    const d = deps({ generate: vi.fn(async () => { throw new Error('Lambda timed out') }) })
    const out = await runBatchFactor([row({ key: 'a' }), row({ key: 'b', invoiceId: 'inv-b' })], d)
    expect(out[0]).toMatchObject({ ok: false, step: 'generate', message: 'Lambda timed out' })
    expect(out[1]).toMatchObject({ ok: true })
    expect(d.sendToFactor).toHaveBeenCalledTimes(1)
  })
})
