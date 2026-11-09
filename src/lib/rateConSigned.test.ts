import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import { buildSignedRateCon, formatInstant, SIGNATURE_ANCHOR, type SigningEvidence } from './rateConSigned'
import { RATE_CON_SIGNATURE_ANCHOR } from './carrierRateCon'

const evidence: SigningEvidence = {
  documentTitle: 'Rate Confirmation - PRO 14832',
  pro: '14832',
  version: 2,
  documentId: 'doc-123',
  signerName: 'José O\u2019Brien',
  signerEmail: 'dispatch@swift.example',
  sentAt: '2026-11-09T17:00:00.000Z',
  sentBy: 'ryne@bcatcorp.com',
  viewedAt: '2026-11-09T17:05:00.000Z',
  signedAt: '2026-11-09T17:10:30.000Z',
  ip: '203.0.113.9',
  userAgent: 'Mozilla/5.0 ' + 'x'.repeat(250),
  location: null,
  details: { 'Driver phone': '+13125550101' },
  consentText: 'consent',
}

async function blank(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([612, 792])
  return doc.save()
}

function text(bytes: Uint8Array, page?: number): string {
  const raw = Buffer.from(bytes)
  const streams: string[] = []
  let from = 0
  for (;;) {
    const start = raw.indexOf('stream\n', from, 'latin1')
    if (start < 0) break
    const end = raw.indexOf('endstream', start, 'latin1')
    try { streams.push(inflateSync(raw.subarray(start + 7, end)).toString('latin1')) } catch { /* not flate */ }
    from = end + 9
  }
  return page == null ? streams.join('\n') : streams[page] ?? ''
}
const hex = (t: string) => Buffer.from(t, 'latin1').toString('hex').toUpperCase()

describe('signature anchor', () => {
  it('is the one the rate con layout draws its Carrier Signature / Date line at', () => {
    expect(SIGNATURE_ANCHOR).toEqual(RATE_CON_SIGNATURE_ANCHOR)
  })
})

describe('buildSignedRateCon', () => {
  it('keeps the original pages, appends exactly one certificate page, and hashes the unsigned bytes', async () => {
    const unsigned = await blank(3)
    const signed = await buildSignedRateCon(unsigned, evidence)
    const out = await PDFDocument.load(signed.bytes)

    expect(out.getPageCount()).toBe(4)
    expect(signed.pages).toBe(4)
    expect(signed.unsignedSha256).toBe(createHash('sha256').update(unsigned).digest('hex'))
    const all = text(signed.bytes)
    for (const t of [signed.unsignedSha256, 'SIGNING CERTIFICATE', '203.0.113.9', 'dispatch@swift.example', 'ryne@bcatcorp.com', 'doc-123', 'v2', 'Not available']) {
      expect(all, t).toContain(hex(t))
    }
    // A user agent longer than the line wraps rather than running off the page.
    expect(all).toContain(hex('x'.repeat(10)))
  })

  it('stamps the typed name and the date on the LAST original page, at the signature line', async () => {
    const signed = await buildSignedRateCon(await blank(2), evidence)
    const out = await PDFDocument.load(signed.bytes)
    const last = out.getPage(1)
    const content = text(signed.bytes)
    expect(content).toContain(hex('Brien'))
    expect(last.getHeight()).toBe(792)
    // Date segments: signed 11/09/2026 in New York time.
    for (const part of ['11', '09', '2026']) expect(content).toContain(hex(part))
  })

  it('refuses a name its font cannot print instead of writing a broken PDF', async () => {
    await expect(buildSignedRateCon(await blank(1), { ...evidence, signerName: '李小龙' })).rejects.toThrow()
  })
})

describe('formatInstant', () => {
  it('prints Eastern time with its zone, and says so when there is no instant', () => {
    expect(formatInstant('2026-11-09T17:10:30.000Z')).toMatch(/Nov 9, 2026.*12:10:30 PM EST/)
    expect(formatInstant(null)).toBe('Not recorded')
  })
})
