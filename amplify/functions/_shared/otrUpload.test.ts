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
  // The body is a finished Buffer now, not a FormData — see buildMultipart for why.
  const body = Buffer.from(init.body as unknown as Uint8Array)
  return { url, init, body, text: body.toString('latin1') }
}

describe('uploadDocument', () => {
  it('posts to the documented path', async () => {
    const { url, init } = await upload()
    expect(url).toBe('https://otr.test/CarrierTmsV3/documents/upload')
    expect(init.method).toBe('POST')
  })

  it('sends the documented headers, its own boundary, and a Content-Length', async () => {
    /*
     * The Content-Length is the point of building the body by hand. Handing fetch a
     * FormData streams it chunked with no length, and every document we ever sent OTR came
     * back rejected in ways that look like a parser reading a body it could not frame.
     */
    const { init, body } = await upload()
    const headers = init.headers as Record<string, string>
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('sub-key')
    expect(headers.Authorization).toBe('Bearer t0ken')
    expect(headers['X-Invoice-Doc-Type']).toBe('1')
    expect(headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=----BCATFormBoundary/)
    expect(headers['Content-Length']).toBe(String(body.byteLength))
  })

  it('declares the exact boundary the body actually uses', async () => {
    const { init, text } = await upload()
    const boundary = (init.headers as Record<string, string>)['Content-Type'].split('boundary=')[1]
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true)
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true)
  })

  it('sends exactly the documented fields, in the documented order', async () => {
    // Order matters to a streaming multipart parser that wants the invoice id before it
    // starts consuming the file. OTR's own example is file, DocumentType, invoiceid,
    // SendEmail, InvoiceDocTypes.
    const { text } = await upload()
    // `form-data; name=` only — a bare /name="/ also matches filename=".
    const names = [...text.matchAll(/form-data; name="([^"]+)"/g)].map((m) => m[1])
    expect(names).toEqual(['file', 'DocumentType', 'invoiceid', 'SendEmail', 'InvoiceDocTypes'])
    expect(text).toContain('name="DocumentType"\r\n\r\ninvoice-file-upload\r\n')
    expect(text).toContain('name="invoiceid"\r\n\r\n16222565\r\n')
    expect(text).toContain('name="SendEmail"\r\n\r\nfalse\r\n')
    expect(text).toContain('name="InvoiceDocTypes"\r\n\r\n1\r\n')
  })

  it('sends the file byte for byte, under its own name, with its type declared', async () => {
    /*
     * The failure that started this: OTR opened 1,852,054 bytes of a 1,018,923-byte PDF —
     * what that file becomes if its bytes are decoded as UTF-8 text and re-encoded. If
     * anything in this function ever puts the body through a string again, this catches it.
     *
     * The part DOES carry a Content-Type. This file previously asserted the opposite, on
     * the claim that `--form "file=@pod.pdf"` sends none. Capturing that exact curl against
     * a local socket shows it sends `Content-Type: application/pdf` — curl infers it from
     * the extension. A .NET handler reading a null ContentType raises "Object reference not
     * set to an instance of an object", which is what both probe PDFs came back with.
     */
    const { body, text } = await upload()
    expect(text).toContain('name="file"; filename="POD-14538.pdf"')
    expect(text).toContain('Content-Type: application/pdf')
    const at = body.indexOf(Buffer.from(PDF_BYTES))
    expect(at).toBeGreaterThan(-1)
    expect(body.subarray(at, at + PDF_BYTES.length)).toEqual(Buffer.from(PDF_BYTES))
  })

  it('names and types the part from the bytes, not from the name it was given', async () => {
    /*
     * Live bug: enhanced PODs are sometimes `.enhanced.jpg`, and every upload was named
     * `POD-<pro>.pdf` regardless. OTR fed that JPEG to their PDF reader and answered
     * "Invalid or corrupt pdf format" — about a file that was never a PDF.
     */
    let captured: Buffer | null = null
    const client = clientWith((_u, init) => { captured = Buffer.from(init.body as unknown as Uint8Array) })
    await client.uploadDocument({
      invoiceId: '16222565',
      docType: OTR_DOC_TYPE.POD,
      fileName: 'POD-14538.pdf', // wrong on purpose
      contentType: 'application/pdf', // also wrong on purpose
      file: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), // a JPEG
    })
    const text = captured!.toString('latin1')
    // A real JPEG gets wrapped into a PDF first (see below), so this stub — which pdf-lib
    // cannot embed — is what proves the sniffed type reaches the part when wrapping fails.
    expect(text).toContain('filename="POD-14538.jpg"')
    expect(text).toContain('Content-Type: image/jpeg')
  })

  it('wraps a real image into a PDF, because OTR only ever reads PDFs', async () => {
    /*
     * Measured: a 614-byte JPEG sent as `.jpg` with Content-Type image/jpeg came back from
     * IronPDF as "Invalid or corrupt pdf format" — their service ignores the declared type.
     * Enhanced PODs are sometimes `.enhanced.jpg`, so this is the normal path.
     */
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
      'base64',
    )
    let captured: Buffer | null = null
    const client = clientWith((_u, init) => { captured = Buffer.from(init.body as unknown as Uint8Array) })
    await client.uploadDocument({
      invoiceId: '16222565',
      docType: OTR_DOC_TYPE.POD,
      fileName: 'POD-14538.jpg',
      contentType: 'image/jpeg',
      file: png,
    })
    const text = captured!.toString('latin1')
    expect(text).toContain('filename="POD-14538.pdf"')
    expect(text).toContain('Content-Type: application/pdf')
    expect(text).not.toContain('image/png')
    // And it left as an ASCII-safe PDF, so OTR's UTF-8 round trip cannot touch it.
    const start = text.indexOf('%PDF')
    expect(start).toBeGreaterThan(-1)
    const fileEnd = text.lastIndexOf('\r\n--')
    expect([...captured!.subarray(start, fileEnd)].every((b) => b <= 0x7f)).toBe(true)
  })

  it('sends a copy, so a view onto a larger buffer cannot leak its neighbours', async () => {
    const backing = new Uint8Array([0xaa, 0xbb, 0x25, 0x50, 0x44, 0x46, 0xcc, 0xdd])
    const view = backing.subarray(2, 6)
    let captured: Uint8Array | null = null
    const client = clientWith((_u, init) => { captured = init.body as unknown as Uint8Array })
    await client.uploadDocument({
      invoiceId: '1', docType: OTR_DOC_TYPE.RATE_CONFIRMATION,
      fileName: 'rc.pdf', contentType: 'application/pdf', file: view,
    })
    const sent = Buffer.from(captured! as unknown as Uint8Array)
    expect(sent.includes(Buffer.from([0xaa, 0xbb]))).toBe(false)
    expect(sent.includes(Buffer.from([0x25, 0x50, 0x44, 0x46]))).toBe(true)
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

/*
 * v2 is where documents actually land.
 *
 * v1 decoded the body as UTF-8 and destroyed every byte above 0x7F, then crashed with a
 * null reference on anything its reader could open — proven with a 610-byte PDF carrying
 * no high bytes at all. Against v2 the real 1,018,923-byte POD for invoice 16222565
 * uploaded untouched and returned 200.
 */
describe('uploading through OTR v2', () => {
  function v2Client(capture: (url: string, init: RequestInit) => void): OtrClient {
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith('/auth/token')) {
        return new Response(JSON.stringify({ access_token: href.includes('carrier-tms/2') ? 'v2tok' : 'v1tok', expires_in: 7200 }), { status: 200 })
      }
      capture(href, init ?? {})
      return new Response(JSON.stringify({}), { status: 200 })
    })
    return new OtrClient({
      baseUrl: 'https://otr.test/CarrierTmsV3',
      uploadBaseUrl: 'https://otr.test/carrier-tms/2',
      subscriptionKey: 'sub-key', username: 'u', password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
  }

  async function uploadV2(file = PDF_BYTES) {
    let seen: { url: string; init: RequestInit } | null = null
    const client = v2Client((url, init) => { seen = { url, init } })
    await client.uploadDocument({
      invoiceId: '16222565', docType: OTR_DOC_TYPE.POD,
      fileName: 'POD-14538.pdf', contentType: 'application/pdf', file,
    })
    const { url, init } = seen! as { url: string; init: RequestInit }
    const body = Buffer.from(init.body as unknown as Uint8Array)
    return { url, init, body, text: body.toString('latin1') }
  }

  it('posts to /file-upload on the v2 host', async () => {
    const { url } = await uploadV2()
    expect(url).toBe('https://otr.test/carrier-tms/2/file-upload')
  })

  it('sends ItemPkey, which is what v2 renamed invoiceid to', async () => {
    const { text } = await uploadV2()
    expect(text).toContain('name="ItemPkey"\r\n\r\n16222565\r\n')
    expect(text).not.toContain('name="invoiceid"')
  })

  it('carries the v2 host’s own token, not the v1 one', async () => {
    // Two products on their gateway; the tokens are not interchangeable.
    const { init } = await uploadV2()
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer v2tok')
  })

  it('sends the file untouched — no ASCII rewrite', async () => {
    /*
     * The workaround that v1 forced: re-encoding every stream with /ASCIIHexDecode, which
     * roughly doubled a POD. v2 takes the binary, so it must not be paying that cost.
     */
    const real = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x80, 0xfe])
    const { body } = await uploadV2(real)
    const at = body.indexOf(Buffer.from(real))
    expect(at).toBeGreaterThan(-1)
    expect(body.subarray(at, at + real.length)).toEqual(Buffer.from(real))
  })

  it('still sends invoiceid when no v2 host is configured', async () => {
    // Falling back to v1 has to keep working, including its ASCII workaround.
    const { text } = await upload()
    expect(text).toContain('name="invoiceid"')
    expect(text).not.toContain('name="ItemPkey"')
  })
})

/*
 * Production speaks ONLY v2 — every v1 path on services.otrsolutions.com returns 404 — so
 * invoices move across too, and their body changes shape.
 */
describe('creating an invoice on v2', () => {
  const PAYLOAD = {
    InvoiceNo: '99002', BrokerMC: '20313', PoNumber: 'PO-TEST-99002',
    InvoiceAmount: 1850, InvoiceDate: '2026-10-05',
    FromCity: 'CHICAGO', FromState: 'IL', FromZip: '60601',
    ToCity: 'INDIANAPOLIS', ToState: 'IN', ToZip: '46201',
  }

  function clientOn(baseUrl: string, clientDot?: string) {
    const calls: Array<{ url: string; body: string }> = []
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith('/auth/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }), { status: 200 })
      }
      calls.push({ url: href, body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ invoiceId: 123, invoiceNo: '99002' }), { status: 200 })
    })
    const client = new OtrClient({
      baseUrl, subscriptionKey: 'k', username: 'u', password: 'p', clientDot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    return { client, calls }
  }

  it('sends CustomerMC as a number, not BrokerMC as a string', async () => {
    const { client, calls } = clientOn('https://otr.test/carrier-tms/2', '1234567')
    await client.createInvoice(PAYLOAD)
    const body = JSON.parse(calls[0].body)
    expect(body.CustomerMC).toBe(20313)
    expect(body.BrokerMC).toBeUndefined()
  })

  it('sends ClientDOT, which v1 never asked for', async () => {
    const { client, calls } = clientOn('https://otr.test/carrier-tms/2', '1234567')
    await client.createInvoice(PAYLOAD)
    expect(JSON.parse(calls[0].body).ClientDOT).toBe('1234567')
  })

  it('drops the ZIPs, which v2 does not accept', async () => {
    const { client, calls } = clientOn('https://otr.test/carrier-tms/2', '1234567')
    await client.createInvoice(PAYLOAD)
    const body = JSON.parse(calls[0].body)
    expect(body.FromZip).toBeUndefined()
    expect(body.ToZip).toBeUndefined()
    expect(body.FromCity).toBe('CHICAGO') // the rest survives
  })

  it('refuses before calling OTR when no ClientDOT is configured', async () => {
    /*
     * A missing DOT would come back as an opaque 400 two calls later, after the invoice
     * attempt had already been made. Failing here says exactly what is wrong.
     */
    const { client, calls } = clientOn('https://otr.test/carrier-tms/2')
    await expect(client.createInvoice(PAYLOAD)).rejects.toThrow(/ClientDOT/)
    expect(calls).toHaveLength(0)
  })

  it('still sends the v1 body against a v1 base', async () => {
    const { client, calls } = clientOn('https://otr.test/CarrierTmsV3')
    await client.createInvoice(PAYLOAD)
    const body = JSON.parse(calls[0].body)
    expect(body.BrokerMC).toBe('20313')
    expect(body.FromZip).toBe('60601')
    expect(body.CustomerMC).toBeUndefined()
  })
})
