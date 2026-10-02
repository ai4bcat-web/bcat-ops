/**
 * The shape of a document upload, against OTR's own documented example.
 *
 * https://docs.otrsolutions.com/reference/upload-file
 *
 * PRO 14538 reached OTR as invoice 16222565 and both documents came back 500 — a status
 * their docs do not list for this endpoint at all (they document 400, 401 and 413). One
 * was "Invalid or corrupt pdf format" against a file that parses cleanly here; the other
 * was a null dereference inside their handler.
 *
 * The field NAMES were already right. These pin the whole request — names, order, headers
 * and the bytes — so the next change to this function cannot quietly drift from the spec
 * while we are still working out whose fault the 500 is.
 */
import { describe, it, expect, vi } from 'vitest'
import { OtrClient, OTR_DOC_TYPE } from './otrClient'

/** A real PDF header, so a byte-for-byte comparison means something. */
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x80, 0x00, 0xfe, 0x7f,
])

function clientWith(capture: (url: string, init: RequestInit) => void): OtrClient {
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url)
    if (href.endsWith('/auth/token')) {
      return new Response(JSON.stringify({ access_token: 't0ken', expires_in: 7200 }), { status: 200 })
    }
    capture(href, init ?? {})
    return new Response(JSON.stringify({ message: 'ok', invoiceId: '16222565' }), { status: 200 })
  })
  return new OtrClient({
    baseUrl: 'https://otr.test/CarrierTmsV3',
    subscriptionKey: 'sub-key',
    username: 'u',
    password: 'p',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
}

async function upload() {
  let captured: { url: string; init: RequestInit } | null = null
  const client = clientWith((url, init) => { captured = { url, init } })
  await client.uploadDocument({
    invoiceId: '16222565',
    docType: OTR_DOC_TYPE.POD,
    fileName: 'POD-14538.pdf',
    contentType: 'application/pdf',
    file: PDF_BYTES,
  })
  const { url, init } = captured! as { url: string; init: RequestInit }
  const form = init.body as FormData
  return { url, init, form }
}

describe('uploadDocument', () => {
  it('posts to the documented path', async () => {
    const { url, init } = await upload()
    expect(url).toBe('https://otr.test/CarrierTmsV3/documents/upload')
    expect(init.method).toBe('POST')
  })

  it('sends the three documented headers and no Content-Type of its own', async () => {
    // Setting Content-Type by hand would suppress the multipart boundary fetch generates,
    // and the body would arrive unparseable.
    const { init } = await upload()
    const headers = init.headers as Record<string, string>
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('sub-key')
    expect(headers.Authorization).toBe('Bearer t0ken')
    expect(headers['X-Invoice-Doc-Type']).toBe('1')
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type')
  })

  it('sends exactly the documented fields, in the documented order', async () => {
    // Order matters to a streaming multipart parser that wants the invoice id before it
    // starts consuming the file. OTR's own example is file, DocumentType, invoiceid,
    // SendEmail, InvoiceDocTypes.
    const { form } = await upload()
    expect([...form.keys()]).toEqual([
      'file', 'DocumentType', 'invoiceid', 'SendEmail', 'InvoiceDocTypes',
    ])
    expect(form.get('DocumentType')).toBe('invoice-file-upload')
    expect(form.get('invoiceid')).toBe('16222565')
    expect(form.get('SendEmail')).toBe('false')
    expect(form.get('InvoiceDocTypes')).toBe('1')
  })

  it('sends the file byte for byte, under its own name', async () => {
    /*
     * The failure that started this: OTR opened 1,852,054 bytes of a 1,018,923-byte PDF —
     * what that file becomes if its bytes are decoded as UTF-8 text and re-encoded. If
     * anything in this function ever stringifies the body again, this is what catches it.
     */
    const { form } = await upload()
    const file = form.get('file') as File
    expect(file.name).toBe('POD-14538.pdf')
    /*
     * No declared type on the part, matching OTR's documented example: `--form
     * "file=@pod.pdf"` sends application/octet-stream, not application/pdf. The extension
     * on the name is what tells them what it is.
     */
    expect(file.type).toBe('')
    expect(file.size).toBe(PDF_BYTES.length)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF_BYTES)
  })

  it('sends a copy, so a view onto a larger buffer cannot leak its neighbours', async () => {
    const backing = new Uint8Array([0xaa, 0xbb, 0x25, 0x50, 0x44, 0x46, 0xcc, 0xdd])
    const view = backing.subarray(2, 6)
    let captured: FormData | null = null
    const client = clientWith((_u, init) => { captured = init.body as FormData })
    await client.uploadDocument({
      invoiceId: '1', docType: OTR_DOC_TYPE.RATE_CONFIRMATION,
      fileName: 'rc.pdf', contentType: 'application/pdf', file: view,
    })
    const file = (captured! as unknown as FormData).get('file') as File
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
  })

  it('names the 413 in words, because that one has an obvious fix', async () => {
    const client = new OtrClient({
      baseUrl: 'https://otr.test/CarrierTmsV3',
      subscriptionKey: 'k', username: 'u', password: 'p',
      fetchImpl: (async (url: unknown) =>
        String(url).endsWith('/auth/token')
          ? new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }), { status: 200 })
          : new Response('too big', { status: 413 })) as unknown as typeof fetch,
    })
    await expect(
      client.uploadDocument({
        invoiceId: '1', docType: OTR_DOC_TYPE.POD,
        fileName: 'huge.pdf', contentType: 'application/pdf', file: PDF_BYTES,
      }),
    ).rejects.toThrow(/exceeds OTR's upload size limit/)
  })

  it('carries OTR’s own words out on any other failure', async () => {
    // "Document upload failed (500)" is not a diagnosis. The body is.
    const client = new OtrClient({
      baseUrl: 'https://otr.test/CarrierTmsV3',
      subscriptionKey: 'k', username: 'u', password: 'p',
      fetchImpl: (async (url: unknown) =>
        String(url).endsWith('/auth/token')
          ? new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }), { status: 200 })
          : new Response('Invalid or corrupt pdf format', { status: 500 })) as unknown as typeof fetch,
    })
    await expect(
      client.uploadDocument({
        invoiceId: '1', docType: OTR_DOC_TYPE.POD,
        fileName: 'pod.pdf', contentType: 'application/pdf', file: PDF_BYTES,
      }),
    ).rejects.toMatchObject({ status: 500, body: 'Invalid or corrupt pdf format' })
  })
})
