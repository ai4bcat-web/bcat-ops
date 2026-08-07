import { describe, it, expect, vi, afterEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { buildFilePacket, packetFilename, isPdfKey, isImageKey, isUnembeddableKey } from './filePacketPdf'

/** A real 1-page PDF to exercise the page-copy path. */
async function samplePdfBytes(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([612, 792])
  return doc.save()
}

const baseInput = {
  title: 'Zak Mendoza',
  subtitle: 'Driver file',
  fields: [
    { label: 'Phone', value: '(708) 555-0142' },
    { label: 'CDL', value: 'CDL-A IL-8823901' },
    { label: 'Trailer', value: 'TBD' },
  ],
  generatedAt: '2026-08-05',
}

describe('file key classification', () => {
  it('recognises the formats the uploader accepts', () => {
    expect(isPdfKey('compliance/DRIVER/d1/cdl_copy/171-scan.PDF')).toBe(true)
    expect(isImageKey('a/b/photo_front/1-truck.jpg')).toBe(true)
    expect(isImageKey('a/b/photo_front/1-truck.png')).toBe(true)
    expect(isUnembeddableKey('a/b/photo_rear/1-IMG_0042.heic')).toBe(true)
    expect(isPdfKey('a/b/c/1-note.txt')).toBe(false)
  })
})

describe('buildFilePacket', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('produces a cover page even with no documents', async () => {
    const { bytes, outcomes } = await buildFilePacket({
      ...baseInput,
      items: [],
      getUrl: async () => { throw new Error('should not be called') },
    })
    expect(outcomes).toEqual([])
    const out = await PDFDocument.load(bytes)
    expect(out.getPageCount()).toBe(1)
    expect(out.getTitle()).toBe('Zak Mendoza — Driver file')
  })

  it('copies every page of an embedded PDF after the cover', async () => {
    const pdf = await samplePdfBytes(3)
    vi.stubGlobal('fetch', async () => ({ arrayBuffer: async () => pdf.buffer }))

    const { bytes, outcomes } = await buildFilePacket({
      ...baseInput,
      items: [{ label: 'CDL', s3Key: 'x/cdl_copy/1-cdl.pdf', note: 'Expires 03/2027' }],
      getUrl: async () => 'https://example.test/cdl.pdf',
    })
    expect(outcomes).toEqual([{ label: 'CDL', outcome: 'pdf' }])
    const out = await PDFDocument.load(bytes)
    expect(out.getPageCount()).toBe(1 + 3)   // cover + 3 copied pages
  })

  it('adds a placeholder page for HEIC rather than dropping the document', async () => {
    const { bytes, outcomes } = await buildFilePacket({
      ...baseInput,
      items: [{ label: 'Rear', s3Key: 'x/photo_rear/1-IMG.heic' }],
      getUrl: async () => { throw new Error('never fetched') },
    })
    expect(outcomes).toEqual([{ label: 'Rear', outcome: 'placeholder' }])
    const out = await PDFDocument.load(bytes)
    expect(out.getPageCount()).toBe(2)
  })

  it('keeps going and marks the item failed when a download breaks', async () => {
    const { bytes, outcomes } = await buildFilePacket({
      ...baseInput,
      items: [
        { label: 'Insurance', s3Key: 'x/insurance_cert/1-ins.pdf' },
        { label: 'Registration', s3Key: 'x/irp_cab_card/1-reg.heic' },
      ],
      getUrl: async () => { throw new Error('S3 said no') },
    })
    expect(outcomes).toEqual([
      { label: 'Insurance', outcome: 'failed' },
      { label: 'Registration', outcome: 'placeholder' },
    ])
    const out = await PDFDocument.load(bytes)
    expect(out.getPageCount()).toBe(3)   // cover + one failure page + one placeholder
  })
})

describe('packetFilename', () => {
  it('slugs the entity name and stamps the date', () => {
    expect(packetFilename('Zak Mendoza', 'driver', '2026-08-05')).toBe('zak-mendoza-driver-file-2026-08-05.pdf')
    expect(packetFilename('Truck #214', 'truck', '2026-08-05')).toBe('truck-214-truck-file-2026-08-05.pdf')
  })
})

describe('branding', () => {
  it('every outgoing PDF uses the one shared carrier name', async () => {
    // PDF content streams are compressed, so this is asserted at the source: each
    // document module must reference the shared constant rather than its own string.
    // The drift this prevents is real — the pay statements said IVAN CARTAGE while the
    // file packet said BCAT, so two documents about one driver disagreed on the carrier.
    const { readFileSync } = await import('node:fs')
    const { COMPANY_NAME } = await import('./branding')
    expect(COMPANY_NAME).toBe('IVAN CARTAGE')

    for (const file of ['src/lib/filePacketPdf.ts', 'src/lib/payPdf.ts', 'src/lib/payPdfBoxTruck.ts']) {
      const src = readFileSync(file, 'utf8')
      expect(src).toContain('COMPANY_NAME')
      expect(src).not.toMatch(/drawText\('BCAT'|text\('BCAT'/)
    }
  })

  it('titles the document with the entity and its file type', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const { bytes } = await buildFilePacket({ ...baseInput, items: [], getUrl: async () => '' })
    expect((await PDFDocument.load(bytes)).getTitle()).toBe('Zak Mendoza — Driver file')
  })
})
